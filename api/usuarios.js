// Usuarios y gasto de Claude. GET: lista (admin) o solo el propio. POST {op}: crear, clave, activo (admin); mi_clave (cualquiera).
import { base } from './_lib/base.js';
import { exigir, cuerpo, hashClave, claveOk } from './_lib/sesion.js';

const USUARIO = /^[a-z0-9._-]{2,40}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const u = await exigir(req, res); if (!u) return;
    const s = await base();
    if (req.method === 'GET') {
      const mes = s`date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires'`;
      const gasto = await s`select usuario, count(*)::int as pedidos, coalesce(sum(usd), 0)::float as usd from uso where at >= ${mes} group by usuario`;
      const total = gasto.reduce((a, g) => a + g.usd, 0);
      if (!u.admin) return res.status(200).json({ yo: u, usuarios: [], gasto: gasto.filter((g) => g.usuario === u.usuario), total, tope: +(process.env.TOPE_USD_MES || 150) });
      const usuarios = await s`select usuario, nombre, admin, activo, at from usuarios order by usuario`;
      const ultimos = await s`select at, usuario, que, modelo, entrada, salida, usd::float, seg::float, ok, error from uso order by id desc limit 100`;
      return res.status(200).json({ yo: u, usuarios, gasto, total, tope: +(process.env.TOPE_USD_MES || 150), ultimos });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    const b = await cuerpo(req);
    if (b.op === 'mi_clave') {
      if (String(b.nueva || '').length < 10) return res.status(400).json({ error: 'La contraseña nueva tiene que tener al menos 10 caracteres.' });
      const r = (await s`select hash from usuarios where usuario = ${u.usuario}`)[0];
      if (!r || !claveOk(String(b.actual || ''), r.hash)) return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
      await s`update usuarios set hash = ${hashClave(b.nueva)} where usuario = ${u.usuario}`;
      return res.status(200).json({ ok: true });
    }
    if (!u.admin) return res.status(403).json({ error: 'Solo un administrador puede hacer esto.' });
    const usuario = String(b.usuario || '').trim().toLowerCase();
    if (!USUARIO.test(usuario)) return res.status(400).json({ error: 'Usuario inválido: usá letras minúsculas, números, punto o guion (2 a 40).' });
    if (b.op === 'crear' || b.op === 'clave') {
      if (String(b.clave || '').length < 10) return res.status(400).json({ error: 'La contraseña tiene que tener al menos 10 caracteres.' });
      if (b.op === 'crear') {
        const r = await s`insert into usuarios (usuario, nombre, hash, admin) values (${usuario}, ${String(b.nombre || usuario).slice(0, 80)}, ${hashClave(b.clave)}, ${!!b.admin}) on conflict do nothing returning usuario`;
        if (!r.length) return res.status(400).json({ error: 'Ya existe ese usuario.' });
      } else {
        const r = await s`update usuarios set hash = ${hashClave(b.clave)} where usuario = ${usuario} returning usuario`;
        if (!r.length) return res.status(404).json({ error: 'No existe ese usuario.' });
      }
      return res.status(200).json({ ok: true });
    }
    if (b.op === 'activo') {
      if (usuario === u.usuario) return res.status(400).json({ error: 'No te podés desactivar a vos mismo.' });
      await s`update usuarios set activo = ${!!b.activo} where usuario = ${usuario}`;
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Operación desconocida' });
  } catch (e) {
    console.error(e);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Error del servidor' });
  }
}
