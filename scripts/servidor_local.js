// Servidor para probar en una computadora, imitando a Vercel (rutas /api, archivos de public/ y las reglas de vercel.json).
// Uso: DATABASE_URL=postgres://... ADMIN_CLAVE=... SUBIR_TOKEN=... node scripts/servidor_local.js  (puerto 3000)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const vc = JSON.parse(fs.readFileSync(path.join(RAIZ, 'vercel.json'), 'utf8'));
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function reescribir(p) {
  for (const r of vc.rewrites || []) {
    const re = new RegExp('^' + r.source.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    const m = p.match(re);
    if (m) return r.destination.replace(/:(\w+)/g, (_, k) => encodeURIComponent(m.groups[k]));
  }
  return null;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let destino = reescribir(u.pathname);
  let pathname = u.pathname, query = Object.fromEntries(u.searchParams);
  if (destino) { const d = new URL(destino, 'http://x'); pathname = d.pathname; Object.assign(query, Object.fromEntries(d.searchParams)); }
  if (pathname.startsWith('/api/')) {
    const f = path.join(RAIZ, pathname.replace(/\/$/, '') + '.js');
    if (!f.startsWith(path.join(RAIZ, 'api')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('no'); }
    const mod = await import(pathToFileURL(f).href);
    req.query = query;
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
    res.send = (b) => { res.end(b); return res; };
    try { await mod.default(req, res); } catch (e) { console.error(e); if (!res.headersSent) { res.statusCode = 500; res.end('error'); } }
    return;
  }
  const f = path.join(RAIZ, 'public', pathname === '/' ? 'index.html' : pathname);
  if (!f.startsWith(path.join(RAIZ, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no encontrado'); }
  res.writeHead(200, { 'Content-Type': TIPOS[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(+process.env.PORT || 3000, () => console.log('http://localhost:' + (+process.env.PORT || 3000)));
