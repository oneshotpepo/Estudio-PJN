// Sirve la app solo a quien entró. Sin sesión, manda a la pantalla de login.
import fs from 'node:fs';
import path from 'node:path';
import { quien } from './_lib/sesion.js';

let html = null;
const RUNTIME = '<script src="/runtime.js"></script>';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let u = null;
  try { u = await quien(req); } catch (e) { console.error(e); }
  if (!u) { res.statusCode = 302; res.setHeader('Location', '/login.html'); return res.end(); }
  if (!html) {
    const crudo = fs.readFileSync(path.join(process.cwd(), 'app', 'estudio.html'), 'utf8');
    // el puente con la base y con Claude va antes que el código de la app
    html = crudo.replace('<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/', RUNTIME + '\n<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/');
    if (!html.includes(RUNTIME)) html = crudo.replace('</head>', RUNTIME + '</head>');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  return res.status(200).send(html);
}
