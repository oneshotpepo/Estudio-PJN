// Usuarios, contraseñas y sesión (cookie firmada). Nada de esto viaja a terceros.
import crypto from 'node:crypto';
import { base, ajuste } from './base.js';

const DIAS = 30;
const COOKIE = 'epjn';

export function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(clave), sal, 64, { N: 16384, r: 8, p: 1 });
  return `s1$${sal.toString('base64')}$${h.toString('base64')}`;
}
export function claveOk(clave, guardado) {
  const [v, sal, h] = String(guardado || '').split('$');
  if (v !== 's1' || !sal || !h) return false;
  const calc = crypto.scryptSync(String(clave), Buffer.from(sal, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const esp = Buffer.from(h, 'base64');
  return esp.length === calc.length && crypto.timingSafeEqual(esp, calc);
}

const llave = () => ajuste('llave_sesion', () => crypto.randomBytes(32).toString('base64'));
const firmar = async (txt) => crypto.createHmac('sha256', await llave()).update(txt).digest('base64url');

export async function crearCookie(usuario) {
  const exp = Date.now() + DIAS * 864e5;
  const cuerpo = `${Buffer.from(usuario).toString('base64url')}.${exp}`;
  const v = `${cuerpo}.${await firmar(cuerpo)}`;
  return `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DIAS * 86400}`;
}
export const borrarCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function leerCookie(req) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : '';
}

// Devuelve {usuario, nombre, admin} o null.
export async function quien(req) {
  const v = leerCookie(req);
  const [u64, exp, firma] = v.split('.');
  if (!u64 || !exp || !firma || +exp < Date.now()) return null;
  const esp = await firmar(`${u64}.${exp}`);
  if (esp.length !== firma.length || !crypto.timingSafeEqual(Buffer.from(esp), Buffer.from(firma))) return null;
  const usuario = Buffer.from(u64, 'base64url').toString();
  const s = await base();
  const r = await s`select usuario, nombre, admin from usuarios where usuario = ${usuario} and activo`;
  return r[0] || null;
}

// Para las rutas de datos: corta con 401 si no hay sesión.
export async function exigir(req, res, { admin = false } = {}) {
  const u = await quien(req);
  if (!u) { res.status(401).json({ error: 'Tenés que entrar con tu usuario.' }); return null; }
  if (admin && !u.admin) { res.status(403).json({ error: 'Solo un administrador puede hacer esto.' }); return null; }
  return u;
}

// Freno a quien prueba contraseñas: 8 errores seguidos bloquean ese usuario 15 minutos; 30 desde la misma conexión, la conexión.
export async function frenado(claves) {
  const s = await base();
  const r = await s`select 1 from intentos where clave in ${s(claves)} and hasta > now()`;
  return r.length > 0;
}
export async function fallo(claves) {
  const s = await base();
  for (const k of claves) {
    await s`insert into intentos (clave, n) values (${k}, 1)
      on conflict (clave) do update set n = case when intentos.hasta is not null and intentos.hasta < now() then 1 else intentos.n + 1 end,
      hasta = case when (case when intentos.hasta is not null and intentos.hasta < now() then 1 else intentos.n + 1 end) >= ${k.startsWith('ip:') ? 30 : 8} then now() + interval '15 minutes' else null end`;
  }
}
export async function limpiarIntentos(claves) { const s = await base(); await s`delete from intentos where clave in ${s(claves)}`; }

export const ipDe = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

// Lee el cuerpo JSON (Vercel ya lo parsea; en local puede venir crudo).
export async function cuerpo(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const partes = []; for await (const p of req) partes.push(p);
  try { return JSON.parse(Buffer.concat(partes).toString() || '{}'); } catch { return {}; }
}
