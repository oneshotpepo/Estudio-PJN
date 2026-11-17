// Entrada para la PC del estudio (y para pasar los datos de la Perona vieja). Solo escribe: no devuelve datos.
// Autorización: cabecera "Authorization: Bearer <SUBIR_TOKEN>" (variable de Vercel).
//   POST /api/subir?op=archivo&id=<id>&nombre=<nombre>[&clase=exp]   cuerpo crudo (<= 4 MB) -> guarda/reemplaza el archivo
//   (con cabecera x-gzip: 1 si el cuerpo es JSON comprimido: se sirve tal cual con Content-Encoding gzip)
//   POST /api/subir?op=tiene  JSON {ids:[...]} -> {tiene:[...]} cuáles ya están (para no subir de nuevo)
//   POST /api/subir?op=docs   JSON {col, docs:[{id, data}], merge?} -> guarda documentos
//   POST /api/subir?op=cargas -> {cargas:[...]} pedidos de carga al PJN pendientes; op=carga_pdf {id} -> el PDF; op=carga_res {id, estado, ...} -> anota el resultado
//   POST /api/subir?op=limpiar JSON {mantener:[ids]} -> borra archivos de la PC que ya no se usan (solo los subidos por "pc")
import crypto from 'node:crypto';
import { base, sinNulos } from './_lib/base.js';

export const config = { api: { bodyParser: false }, maxDuration: 60 };
const MAX = 4 * 1024 * 1024;

function autorizado(req) {
  const t = String(process.env.SUBIR_TOKEN || '');
  const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (t.length < 24 || h.length !== t.length) return false;
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(t));
}
async function crudo(req) {
  const partes = []; let n = 0;
  for await (const p of req) { n += p.length; if (n > MAX) throw Object.assign(new Error('Más de 4 MB: partilo.'), { status: 413 }); partes.push(p); }
  return Buffer.concat(partes);
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!autorizado(req)) return res.status(401).json({ error: 'Token inválido' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    const q = req.query || {};
    const s = await base();
    if (q.op === 'archivo') {
      const id = String(q.id || crypto.randomBytes(16).toString('hex'));
      if (!ID.test(id)) return res.status(400).json({ error: 'id inválido' });
      const datos = await crudo(req);
      const nombre = String(q.nombre || id).slice(0, 200);
      const tipo = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
      const gz = String(req.headers['x-gzip'] || '') === '1';
      // los expedientes completos (e<id>) se reemplazan cuando cambian y no entran en la limpieza diaria
      const de = q.clase === 'exp' ? 'pc-exp' : 'pc';
      await s`insert into archivos (id, nombre, tipo, tam, datos, de, gz) values (${id}, ${nombre}, ${tipo}, ${datos.length}, ${datos}, ${de}, ${gz})
        on conflict (id) do update set nombre = excluded.nombre, tipo = excluded.tipo, tam = excluded.tam, datos = excluded.datos, gz = excluded.gz, de = excluded.de, at = now()`;
      return res.status(200).json({ id, url: '/_blob/' + id, tam: datos.length });
    }
    let b = {};
    try { b = JSON.parse((await crudo(req)).toString() || '{}'); } catch { return res.status(400).json({ error: 'JSON inválido' }); }
    if (q.op === 'docs') {
      const col = String(b.col || '');
      if (!col || col.length > 200 || col.startsWith('/')) return res.status(400).json({ error: 'col inválida' });
      const docs = (Array.isArray(b.docs) ? b.docs : []).filter((d) => d && typeof d.id === 'string' && d.id && d.id.length <= 200 && d.data && typeof d.data === 'object');
      for (const d of docs) {
        if (b.merge) await s`insert into docs (col, id, data) values (${col}, ${d.id}, ${s.json(sinNulos(d.data))})
          on conflict (col, id) do update set data = case when docs.borrado then excluded.data else coalesce(docs.data, '{}'::jsonb) || excluded.data end, borrado = false, ver = nextval('ver_seq'), at = now()`;
        else await s`insert into docs (col, id, data) values (${col}, ${d.id}, ${s.json(sinNulos(d.data))})
          on conflict (col, id) do update set data = excluded.data, borrado = false, ver = nextval('ver_seq'), at = now()`;
      }
      return res.status(200).json({ ok: true, n: docs.length });
    }
    if (q.op === 'tiene') {
      const ids = (Array.isArray(b.ids) ? b.ids : []).filter((x) => typeof x === 'string' && ID.test(x)).slice(0, 2000);
      const r = ids.length ? await s`select id from archivos where id = any(${ids})` : [];
      if (r.length) await s`update archivos set at = now() where id = any(${r.map((x) => x.id)})`;
      return res.status(200).json({ tiene: r.map((x) => x.id) });
    }
    if (q.op === 'limpiar') {
      const mantener = (Array.isArray(b.mantener) ? b.mantener : []).filter((x) => typeof x === 'string');
      if (mantener.length < 1) return res.status(400).json({ error: 'Falta la lista de archivos a mantener' });
      const r = await s`delete from archivos where de = 'pc' and at < now() - interval '2 days' and not (id = any(${mantener})) returning id`;
      return res.status(200).json({ ok: true, borrados: r.length });
    }
    // ---- carga al PJN: el Cargador de la PC baja los pedidos que dejó la app y avisa cómo terminaron
    if (q.op === 'cargas') {
      const r = await s`select id, data from docs where col = 'cargas' and not borrado and data->>'estado' = 'pedido' order by at limit 20`;
      return res.status(200).json({ cargas: r.map((x) => ({ ...x.data, id: x.id })) });
    }
    if (q.op === 'carga_pdf' || q.op === 'carga_res') {
      const id = String(b.id || '');
      const c = id && id.length <= 200 ? await s`select data from docs where col = 'cargas' and id = ${id} and not borrado` : [];
      if (!c.length) return res.status(404).json({ error: 'No existe ese pedido de carga' });
      const d = c[0].data || {};
      if (q.op === 'carga_pdf') {
        const f = await s`select datos from archivos where id = ${String(d.pdf_id || '')}`;
        if (!f.length) return res.status(404).json({ error: 'No está el PDF' });
        res.setHeader('Content-Type', 'application/pdf');
        return res.status(200).send(f[0].datos);
      }
      const estado = String(b.estado || '');
      if (!['tomado', 'cargado', 'error', 'revisar'].includes(estado)) return res.status(400).json({ error: 'estado inválido' });
      // un pedido que ya terminó no vuelve atrás
      if (['cargado', 'revisar'].includes(d.estado) && d.estado !== estado) return res.status(200).json({ ok: true, igual: true });
      const fin = estado !== 'tomado';
      const r = sinNulos({ estado, mensaje: String(b.mensaje || '').slice(0, 1000), pjn_ids: Array.isArray(b.pjn_ids) ? b.pjn_ids.slice(0, 20) : [], destino: String(b.destino || '').slice(0, 300), fecha: String(b.fecha || '').slice(0, 40) });
      await s`update docs set data = data || ${s.json(fin ? { ...r, resuelto_at: new Date().toISOString() } : { estado, tomado_at: new Date().toISOString() })}, ver = nextval('ver_seq'), at = now() where col = 'cargas' and id = ${id}`;
      if (fin && d.escrito_id) {
        const extra = estado === 'cargado' ? { estado: 'Presentado', presentado_at: new Date().toISOString() } : {};
        await s`update docs set data = data || jsonb_build_object('envio', coalesce(data->'envio', '{}'::jsonb) || ${s.json(r)}) || ${s.json(extra)}, ver = nextval('ver_seq'), at = now()
          where col = 'escritos' and id = ${String(d.escrito_id)} and not borrado and data->'envio'->>'id' = ${id}`;
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Operación desconocida' });
  } catch (e) {
    console.error(e);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Error del servidor' });
  }
}
