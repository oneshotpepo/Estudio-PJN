// Carga al PJN desde la app: presenta el escrito que alguien confirmó, con la cuenta del PJN cargada en Vercel.
// POST {id}          -> presenta el pedido cargas/<id> (lo dejó la app al confirmar) y devuelve cómo terminó.
// POST {op:'probar'} -> (admin) entra al PJN y avisa si la cuenta puede presentar. No presenta nada.
// El trabajo contra el PJN lo hace /api/pjn (Python, el mismo código que corría en la PC del estudio).
// Acá se cuida que un mismo PDF no se presente dos veces: cada intento se anota en pjn_envios ANTES de mandarlo.
import crypto from 'node:crypto';
import { base, sinNulos } from './_lib/base.js';
import { exigir, cuerpo } from './_lib/sesion.js';

export const config = { maxDuration: 300 };
const MAX_PDF = 3 * 1024 * 1024;

async function pjn(req, cuerpoPedido) {
  const url = process.env.PJN_FUNC_URL || `https://${req.headers.host}/api/pjn`;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(process.env.SUBIR_TOKEN || '') }, body: JSON.stringify(cuerpoPedido), signal: AbortSignal.timeout(240000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error((j && j.error) || 'HTTP ' + r.status);
  return j;
}

// anota el resultado en el pedido y en el escrito (que pasa a Presentado si se cargó)
async function anotar(s, id, d, res) {
  const r = sinNulos({ estado: res.estado, mensaje: String(res.mensaje || '').slice(0, 1000), pjn_ids: Array.isArray(res.pjn_ids) ? res.pjn_ids.slice(0, 20) : [], destino: String(res.destino || '').slice(0, 300), fecha: new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 19) });
  const ahora = new Date().toISOString();
  await s`update docs set data = data || ${s.json({ ...r, resuelto_at: ahora })}, ver = nextval('ver_seq'), at = now() where col = 'cargas' and id = ${id}`;
  if (d.escrito_id) {
    const extra = r.estado === 'cargado' ? { estado: 'Presentado', presentado_at: ahora } : {};
    await s`update docs set data = data || jsonb_build_object('envio', coalesce(data->'envio', '{}'::jsonb) || ${s.json(r)}) || ${s.json(extra)}, ver = nextval('ver_seq'), at = now()
      where col = 'escritos' and id = ${String(d.escrito_id)} and not borrado and data->'envio'->>'id' = ${id}`;
  }
  return r;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const u = await exigir(req, res); if (!u) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    const b = await cuerpo(req);
    const s = await base();

    if (b.op === 'probar') {
      if (!u.admin) return res.status(403).json({ error: 'Solo un administrador puede hacer esto.' });
      try { return res.status(200).json(await pjn(req, { op: 'probar' })); }
      catch (e) { console.error(e); return res.status(200).json({ ok: false, mensaje: 'No pude llamar al cargador de la app: ' + String(e.message || e).slice(0, 200) }); }
    }

    const id = String(b.id || '');
    if (!id || id.length > 200) return res.status(400).json({ error: 'Falta el pedido' });
    // lo toma una sola vez: si otro pedido ya lo está presentando (o ya terminó), no se repite
    const t = await s`update docs set data = data || ${s.json({ estado: 'tomado', tomado_at: new Date().toISOString(), tomado_por: u.usuario })}, ver = nextval('ver_seq'), at = now()
      where col = 'cargas' and id = ${id} and not borrado and data->>'estado' = 'pedido' returning data`;
    if (!t.length) {
      const c = await s`select data from docs where col = 'cargas' and id = ${id} and not borrado`;
      if (!c.length) return res.status(404).json({ error: 'No existe ese pedido de carga' });
      const d = c[0].data || {};
      return res.status(200).json({ estado: d.estado === 'tomado' ? 'enviado' : d.estado, mensaje: d.mensaje || (d.estado === 'tomado' ? 'Ya se está presentando.' : ''), pjn_ids: d.pjn_ids || [], destino: d.destino || '', fecha: d.fecha || '' });
    }
    const d = t[0].data || {};
    const fin = async (r) => res.status(200).json(await anotar(s, id, d, r));

    const f = await s`select datos from archivos where id = ${String(d.pdf_id || '')}`;
    if (!f.length) return fin({ estado: 'error', mensaje: 'No encontré el PDF del escrito. Volvé a cargarlo.' });
    const pdf = Buffer.from(f[0].datos);
    const sha = crypto.createHash('sha256').update(pdf).digest('hex');
    if (d.pdf_sha256 && d.pdf_sha256 !== sha) return fin({ estado: 'error', mensaje: 'El PDF guardado no coincide con el que se confirmó. Volvé a cargarlo.' });
    if (pdf.length > MAX_PDF) return fin({ estado: 'error', mensaje: 'El PDF pesa más de 3 MB: cargalo a mano en el PJN.' });

    // registro de intentos: mismo expediente + mismo PDF no se manda dos veces
    const clave = crypto.createHash('sha256').update(JSON.stringify([String(d.numero || '').toUpperCase().replace(/\s+/g, ' ').trim(), sha])).digest('hex');
    const reserva = await s`insert into pjn_envios (clave, estado, usuario, carga_id, datos) values (${clave}, 'reservado', ${u.usuario}, ${id}, ${s.json(sinNulos({ numero: d.numero, descripcion: d.descripcion, escrito_id: d.escrito_id || null }))})
      on conflict (clave) do nothing returning clave`;
    if (!reserva.length) return fin({ estado: 'error', mensaje: 'Este mismo PDF ya se intentó cargar antes. No lo vuelvo a enviar: revisá en el PJN si quedó presentado.' });

    let r;
    try {
      r = await pjn(req, { op: 'cargar', pedido: { numero: d.numero, descripcion: d.descripcion }, pdf_b64: pdf.toString('base64') });
      if (!['cargado', 'error', 'revisar'].includes(r.estado)) throw new Error('respuesta desconocida');
    } catch (e) {
      // no se sabe si llegó a presentarse: nunca se reintenta solo
      console.error(e);
      r = { estado: 'revisar', etapa: 'envio', mensaje: 'Se cortó la conexión mientras se presentaba. Fijate en el PJN si quedó cargado antes de volver a intentar.' };
    }
    if (r.estado === 'error' && (r.etapa === 'previo' || r.etapa === 'subida')) await s`delete from pjn_envios where clave = ${clave}`; // no salió nada hacia el PJN: se puede reintentar
    else await s`update pjn_envios set estado = ${r.estado === 'cargado' ? 'cargado' : 'revisar'}, at = now(), datos = coalesce(datos, '{}'::jsonb) || ${s.json(sinNulos({ pjn_ids: r.pjn_ids || [], destino: r.destino || '', mensaje: r.mensaje || '', cuenta: r.cuenta || '' }))} where clave = ${clave}`;
    return fin(r);
  } catch (e) {
    console.error(e);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Error del servidor' });
  }
}
