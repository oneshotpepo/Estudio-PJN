// POST {usuario, clave} -> entra. DELETE -> sale.
// La primera vez (sin usuarios en la base) entra el administrador con ADMIN_USUARIO / ADMIN_CLAVE de Vercel y queda creado.
import { base } from './_lib/base.js';
import { hashClave, claveOk, crearCookie, borrarCookie, frenado, fallo, limpiarIntentos, ipDe, cuerpo } from './_lib/sesion.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'DELETE' || (req.method === 'GET' && req.query && req.query.salir != null)) {
      res.setHeader('Set-Cookie', borrarCookie());
      if (req.method === 'GET') { res.statusCode = 302; res.setHeader('Location', '/login.html'); return res.end(); }
      return res.status(200).json({ ok: true });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    const b = await cuerpo(req);
    const usuario = String(b.usuario || '').trim().toLowerCase();
    const clave = String(b.clave || '');
    if (!usuario || !clave) return res.status(400).json({ error: 'Completá usuario y contraseña.' });
    const claves = ['u:' + usuario, 'ip:' + ipDe(req)];
    if (await frenado(claves)) return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos y probá de nuevo.' });

    const s = await base();
    let u = (await s`select usuario, hash, activo from usuarios where usuario = ${usuario}`)[0];
    if (!u) {
      const hay = (await s`select count(*)::int as n from usuarios`)[0].n;
      const adminU = String(process.env.ADMIN_USUARIO || 'juan').trim().toLowerCase();
      const adminC = String(process.env.ADMIN_CLAVE || '');
      if (!hay && adminC.length >= 10 && usuario === adminU && clave === adminC) {
        await s`insert into usuarios (usuario, nombre, hash, admin) values (${usuario}, ${usuario}, ${hashClave(clave)}, true) on conflict do nothing`;
        u = { usuario, activo: true, hash: null, nuevo: true };
      }
    }
    if (!u || !u.activo || (!u.nuevo && !claveOk(clave, u.hash))) {
      await fallo(claves);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    await limpiarIntentos(claves);
    res.setHeader('Set-Cookie', await crearCookie(usuario));
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Error del servidor' });
  }
}
