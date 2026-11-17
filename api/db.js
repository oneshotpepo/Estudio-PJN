// Base de documentos de la app (reemplaza la "db" de claude.ai): colecciones con documentos JSON.
// POST {op, ...}. Ops: get, set, update, delete, add, lista, cambios.
import crypto from 'node:crypto';
import { base, sinNulos } from './_lib/base.js';
import { exigir, cuerpo } from './_lib/sesion.js';

const partir = (p) => { const s = String(p || '').replace(/^\/+|\/+$/g, ''); const i = s.lastIndexOf('/'); return i < 1 ? null : [s.slice(0, i), s.slice(i + 1)]; };
const colOk = (col) => typeof col === 'string' && col.length > 0 && col.length < 200 && !col.startsWith('/') && !col.includes('//');
const nuevoId = () => crypto.randomBytes(15).toString('base64url');
// las conversaciones de Consultas son de cada uno
const permitida = (col, u) => !col.startsWith('data/users/') || col === 'data/users/' + u.usuario;
const CAMPO = /^[A-Za-z0-9_]{1,60}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const u = await exigir(req, res); if (!u) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    const b = await cuerpo(req);
    const s = await base();
    const op = b.op;

    if (op === 'get' || op === 'set' || op === 'update' || op === 'delete') {
      const p = partir(b.path); if (!p || !colOk(p[0])) return res.status(400).json({ error: 'Ruta inválida' });
      const [col, id] = p; if (!permitida(col, u)) return res.status(403).json({ error: 'No permitido' });
      if (op === 'get') {
        const r = await s`select data from docs where col = ${col} and id = ${id} and not borrado`;
        return res.status(200).json(r.length ? { exists: true, data: r[0].data } : { exists: false });
      }
      if (op === 'set') {
        const data = sinNulos(b.data && typeof b.data === 'object' ? b.data : {});
        if (b.merge) await s`insert into docs (col, id, data) values (${col}, ${id}, ${s.json(data)})
          on conflict (col, id) do update set data = case when docs.borrado then excluded.data else coalesce(docs.data, '{}'::jsonb) || excluded.data end, borrado = false, ver = nextval('ver_seq'), at = now()`;
        else await s`insert into docs (col, id, data) values (${col}, ${id}, ${s.json(data)})
          on conflict (col, id) do update set data = excluded.data, borrado = false, ver = nextval('ver_seq'), at = now()`;
        return res.status(200).json({ ok: true });
      }
      if (op === 'update') {
        const data = sinNulos(b.data && typeof b.data === 'object' ? b.data : {});
        const r = await s`update docs set data = coalesce(data, '{}'::jsonb) || ${s.json(data)}, ver = nextval('ver_seq'), at = now()
          where col = ${col} and id = ${id} and not borrado returning id`;
        if (!r.length) return res.status(404).json({ error: 'No existe el documento', code: 'not_found' });
        return res.status(200).json({ ok: true });
      }
      await s`update docs set borrado = true, data = null, ver = nextval('ver_seq'), at = now() where col = ${col} and id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    if (op === 'add') {
      const col = b.col; if (!colOk(col) || !permitida(col, u)) return res.status(400).json({ error: 'Colección inválida' });
      const id = nuevoId();
      await s`insert into docs (col, id, data) values (${col}, ${id}, ${s.json(sinNulos(b.data && typeof b.data === 'object' ? b.data : {}))})`;
      return res.status(200).json({ id });
    }

    if (op === 'lista') {
      const col = b.col; if (!colOk(col) || !permitida(col, u)) return res.status(400).json({ error: 'Colección inválida' });
      const lim = Math.min(Math.max(+b.limite || 50000, 1), 50000);
      const campo = b.orden && CAMPO.test(b.orden.campo || '') ? b.orden.campo : null;
      const desc = b.orden && b.orden.dir === 'desc';
      const ver = (await s`select coalesce(max(ver), 0)::text as v from docs`)[0].v;
      const r = campo
        ? await s`select id, data from docs where col = ${col} and not borrado order by data->>${campo} ${desc ? s`desc nulls last` : s`asc nulls first`} limit ${lim}`
        : await s`select id, data from docs where col = ${col} and not borrado order by id limit ${lim}`;
      return res.status(200).json({ ver, docs: r });
    }

    if (op === 'cambios') {
      const cols = (Array.isArray(b.cols) ? b.cols : []).filter((c) => colOk(c) && permitida(c, u)).slice(0, 50);
      if (!cols.length) return res.status(200).json({ ver: String(b.desde || '0'), docs: [] });
      const desde = /^\d+$/.test(String(b.desde || '')) ? String(b.desde) : '0';
      const r = await s`select col, id, data, borrado, ver::text as ver from docs where ver > ${desde}::bigint and col in ${s(cols)} order by ver limit 3000`;
      const ver = r.length ? r[r.length - 1].ver : desde;
      return res.status(200).json({ ver, docs: r, mas: r.length === 3000 });
    }

    return res.status(400).json({ error: 'Operación desconocida' });
  } catch (e) {
    console.error(e);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'Error del servidor' });
  }
}
