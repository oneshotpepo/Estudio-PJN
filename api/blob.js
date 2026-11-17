// Archivos de la app (datos que sube la PC, PDFs y modelos que sube la gente).
// GET /_blob/<id> -> el archivo. POST /api/blob (cuerpo crudo, cabecera x-nombre) -> {id}.
import crypto from 'node:crypto';
import { base } from './_lib/base.js';
import { exigir } from './_lib/sesion.js';

export const config = { api: { bodyParser: false } };
const MAX = 4 * 1024 * 1024; // Vercel no acepta pedidos de más de 4,5 MB

async function crudo(req) {
  const partes = []; let n = 0;
  for await (const p of req) { n += p.length; if (n > MAX) throw Object.assign(new Error('El archivo pesa más de 4 MB.'), { status: 413 }); partes.push(p); }
  return Buffer.concat(partes);
}

export default async function handler(req, res) {
  try {
    const u = await exigir(req, res); if (!u) return;
    const s = await base();
    if (req.method === 'GET') {
      const id = String((req.query && req.query.id) || '').replace(/[^A-Za-z0-9_-]/g, '');
      const r = id ? await s`select nombre, tipo, datos, gz from archivos where id = ${id}` : [];
      if (!r.length) return res.status(404).json({ error: 'No existe' });
      res.setHeader('Content-Type', r[0].tipo || 'application/octet-stream');
      if (r[0].gz) res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      if (r[0].nombre) res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(r[0].nombre)}`);
      return res.status(200).send(r[0].datos);
    }
    if (req.method === 'POST') {
      const datos = await crudo(req);
      if (!datos.length) return res.status(400).json({ error: 'Archivo vacío' });
      const id = crypto.randomBytes(16).toString('hex');
      const nombre = decodeURIComponent(String(req.headers['x-nombre'] || 'archivo')).slice(0, 200);
      const tipo = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
      await s`insert into archivos (id, nombre, tipo, tam, datos, de) values (${id}, ${nombre}, ${tipo}, ${datos.length}, ${datos}, ${u.usuario})`;
      return res.status(200).json({ id, url: '/_blob/' + id });
    }
    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    console.error(e);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Error del servidor' });
  }
}
