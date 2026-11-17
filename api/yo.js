// Quién está usando la app.
import { exigir } from './_lib/sesion.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const u = await exigir(req, res); if (!u) return;
    return res.status(200).json({ usuario: u.usuario, nombre: u.nombre || u.usuario, admin: !!u.admin, tope: +(process.env.TOPE_USD_MES || 150) });
  } catch (e) { console.error(e); return res.status(500).json({ error: 'Error del servidor' }); }
}
