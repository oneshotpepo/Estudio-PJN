// Puente entre la app (escrita para claude.ai) y este servidor: base, archivos, Claude por API, usuario y descargas.
// Expone window.claude.use(nombre) con las mismas funciones que usaba la app en claude.ai.
(() => {
  'use strict';
  const api = async (url, body, opts = {}) => {
    const r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: opts.signal });
    if (r.status === 401) { location.href = '/login.html'; throw Object.assign(new Error('Sesión vencida'), { code: 'not_granted' }); }
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) throw Object.assign(new Error((j && j.error) || ('HTTP ' + r.status)), { code: (j && j.code) || 'error', status: r.status });
    return j;
  };

  // ------------------------------------------------------------ yo
  let yoP = null;
  const yo = () => (yoP = yoP || fetch('/api/yo', { credentials: 'same-origin' }).then((r) => { if (r.status === 401) { location.href = '/login.html'; } return r.json(); }));

  // ------------------------------------------------------------ base
  const partir = (p) => { const s = String(p).replace(/^\/+|\/+$/g, ''); const i = s.lastIndexOf('/'); return [s.slice(0, i), s.slice(i + 1)]; };
  const snapDoc = (id, data) => ({ id, exists: data != null, data: () => (data == null ? undefined : JSON.parse(JSON.stringify(data))) });
  // suscripciones: una consulta cada pocos segundos trae lo que cambió en todas las colecciones abiertas
  const SUBS = new Map(); // col -> {docs: Map, cbs: Set}
  let cursor = null, sondeando = false, reloj = null;
  const avisar = (col) => { const s = SUBS.get(col); if (!s) return; const docs = [...s.docs.entries()].map(([id, d]) => snapDoc(id, d));
    const q = { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) };
    s.cbs.forEach((cb) => { try { cb(q); } catch (e) { console.error(e); } }); };
  async function sondear() {
    if (sondeando || cursor == null || !SUBS.size || document.hidden && Math.random() < 0.6) return;
    sondeando = true;
    try {
      let mas = true, vueltas = 0;
      while (mas && vueltas++ < 5) {
        // se repasan las últimas 50 versiones por si una escritura terminó fuera de orden (repetir no hace daño)
        const r = await api('/api/db', { op: 'cambios', cols: [...SUBS.keys()], desde: String(Math.max(0, +cursor - 50)) });
        const tocadas = new Set();
        for (const d of r.docs) { const s = SUBS.get(d.col); if (!s) continue; const ant = s.docs.get(d.id);
          if (d.borrado) { if (s.docs.has(d.id)) { s.docs.delete(d.id); tocadas.add(d.col); } }
          else if (JSON.stringify(ant) !== JSON.stringify(d.data)) { s.docs.set(d.id, d.data); tocadas.add(d.col); } }
        if (+r.ver > +cursor) cursor = r.ver;
        tocadas.forEach(avisar); mas = r.mas;
      }
    } catch (e) { if (e.code !== 'not_granted') console.warn('sondeo', e.message); }
    sondeando = false;
  }
  const docRef = (path) => {
    const [col, id] = partir(path);
    const ref = {
      id, path,
      get: async () => { const r = await api('/api/db', { op: 'get', path }); return snapDoc(id, r.exists ? r.data : null); },
      set: async (data, opts) => { await api('/api/db', { op: 'set', path, data, merge: !!(opts && opts.merge) }); local(col, id, opts && opts.merge ? { ...(SUBS.get(col)?.docs.get(id) || {}), ...data } : data); },
      update: async (data) => { await api('/api/db', { op: 'update', path, data }); const s = SUBS.get(col); if (s && s.docs.has(id)) local(col, id, { ...s.docs.get(id), ...data }); },
      delete: async () => { await api('/api/db', { op: 'delete', path }); local(col, id, null); },
      onSnapshot: (cb) => { let vivo = true; const f = async () => { if (!vivo) return; try { cb(await ref.get()); } catch {} }; f(); const t = setInterval(f, 5000); return () => { vivo = false; clearInterval(t); }; },
    };
    return ref;
  };
  // refleja enseguida lo que escribe esta pestaña (sin esperar al próximo sondeo)
  // y avisa en el momento: la app abre el escrito recién creado apenas vuelve add() y lo busca en su lista
  // (con el aviso demorado no lo encontraba y el escrito quedaba sin expediente: Claude redactaba con [COMPLETAR])
  const local = (col, id, data) => { const s = SUBS.get(col); if (!s) return; if (data == null) s.docs.delete(id); else s.docs.set(id, JSON.parse(JSON.stringify(data))); avisar(col); };
  const colRef = (col, orden = null, limite = null) => ({
    id: col.split('/').pop(), path: col,
    doc: (id) => docRef(col + '/' + (id || Math.random().toString(36).slice(2) + Date.now().toString(36))),
    add: async (data) => { const r = await api('/api/db', { op: 'add', col, data }); local(col, r.id, data); return docRef(col + '/' + r.id); },
    orderBy: (campo, dir) => colRef(col, { campo, dir: dir === 'desc' ? 'desc' : 'asc' }, limite),
    limit: (n) => colRef(col, orden, n),
    get: async () => { const r = await api('/api/db', { op: 'lista', col, orden, limite }); const docs = r.docs.map((d) => snapDoc(d.id, d.data));
      return { docs, size: docs.length, empty: !docs.length, forEach: (f) => docs.forEach(f) }; },
    onSnapshot: (cb, errCb) => {
      let s = SUBS.get(col), nueva = false;
      if (!s) { s = { docs: new Map(), cbs: new Set(), listo: null }; SUBS.set(col, s); nueva = true; }
      s.cbs.add(cb);
      if (nueva) s.listo = api('/api/db', { op: 'lista', col }).then((r) => { r.docs.forEach((d) => s.docs.set(d.id, d.data)); if (cursor == null || +r.ver < +cursor) cursor = r.ver; })
        .catch((e) => { if (errCb) errCb(e); });
      s.listo.then(() => avisar(col));
      if (!reloj) reloj = setInterval(sondear, 4000);
      return () => { s.cbs.delete(cb); if (!s.cbs.size) SUBS.delete(col); };
    },
  });
  const db = { doc: docRef, collection: (c) => colRef(String(c).replace(/^\/+|\/+$/g, '')) };

  // ------------------------------------------------------------ Claude (API del estudio)
  const textoDe = (content) => (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const queDe = (opts, tools) => (tools && tools.length) || (opts && opts.modelTier === 'default') ? 'consulta' : 'texto';
  function errClaude(e) {
    if (e && e.name === 'AbortError') return Object.assign(new Error('cancelado'), { code: 'cancelled' });
    if (e && e.code === 'tope') return Object.assign(new Error(e.message), { code: 'rate_limited' });
    return e;
  }
  async function sample(input, opts = {}) {
    const msgs = typeof input === 'string' ? [{ role: 'user', content: input }]
      : (input || []).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    const tools = Array.isArray(opts.tools) ? opts.tools : [];
    const defs = tools.map((t) => ({ name: t.name, description: t.description || '', input_schema: t.inputSchema || t.input_schema || { type: 'object', properties: {} } }));
    const que = opts._que || queDe(opts, tools);
    let r = null;
    try {
      for (let vuelta = 0; vuelta < 15; vuelta++) {
        r = await api('/api/claude', { messages: msgs, tools: defs, que, max_tokens: opts.maxTokens }, { signal: opts.signal });
        if (r.stop_reason === 'refusal') throw Object.assign(new Error('Claude no quiso responder este pedido.'), { code: 'refusal', text: textoDe(r.content) });
        if (r.stop_reason !== 'tool_use' || !tools.length) break;
        msgs.push({ role: 'assistant', content: r.content });
        const usos = r.content.filter((b) => b.type === 'tool_use');
        const resultados = await Promise.all(usos.map(async (b) => {
          const t = tools.find((x) => x.name === b.name);
          try {
            if (!t || !t.execute) throw new Error('Herramienta desconocida: ' + b.name);
            const out = await t.execute(b.input || {});
            return { type: 'tool_result', tool_use_id: b.id, content: typeof out === 'string' ? out : JSON.stringify(out) };
          } catch (e) { return { type: 'tool_result', tool_use_id: b.id, is_error: true, content: String((e && e.message) || e) }; }
        }));
        msgs.push({ role: 'user', content: resultados });
      }
    } catch (e) { throw errClaude(e); }
    const text = textoDe(r && r.content);
    if (opts.onText) { try { opts.onText({ text }); } catch {} }
    return { text, truncated: !!r && r.stop_reason === 'max_tokens' };
  }
  function jsonDe(t) {
    const s = String(t || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(s); } catch {}
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
    const c = s.indexOf('['), d = s.lastIndexOf(']');
    if (c >= 0 && d > c) { try { return JSON.parse(s.slice(c, d + 1)); } catch {} }
    throw Object.assign(new Error('Claude no devolvió un JSON válido.'), { code: 'invalid_json', text: t });
  }
  sample.json = async (prompt, opts = {}) => {
    const r = await sample(String(prompt) + '\n\nRespondé únicamente con el objeto JSON pedido, sin texto antes ni después y sin bloques de código.', { ...opts, _que: 'json' });
    return jsonDe(r.text);
  };
  sample.text = async (prompt, opts = {}) => (await sample(prompt, opts)).text;
  sample.limits = async () => ({ tools: { maxCount: 20 } });

  // ------------------------------------------------------------ archivos
  const assets = {
    upload: async (file) => {
      const r = await fetch('/api/blob', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-nombre': encodeURIComponent(file.name || 'archivo') }, body: file });
      let j = null; try { j = await r.json(); } catch {}
      if (!r.ok) throw new Error((j && j.error) || 'No se pudo subir el archivo');
      return { id: j.id, url: j.url };
    },
  };
  const downloads = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename || 'archivo';
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    },
  };
  // en esta versión nadie es "dueño de la pestaña": los pedidos a Claude van directo por la API del estudio
  const user = { id: async () => (await yo()).usuario, isOwner: async () => false, name: async () => (await yo()).nombre, isAdmin: async () => !!(await yo()).admin };

  const CAPS = { db, sample, assets, downloads, user };
  window.claude = { use: async (n) => CAPS[n] || null };

  // ------------------------------------------------------------ pie: usuario, gasto y salir
  async function pie() {
    const foot = document.querySelector('.rail-foot'); if (!foot) return;
    const u = await yo().catch(() => null); if (!u || !u.usuario) return;
    const box = document.createElement('div'); box.className = 'datachip'; box.style.display = 'grid'; box.style.gap = '4px';
    const nom = document.createElement('span'); nom.textContent = 'Entraste como ' + (u.nombre || u.usuario);
    const links = document.createElement('span');
    const a1 = document.createElement('a'); a1.href = '/usuarios.html'; a1.textContent = u.admin ? 'Usuarios y gasto' : 'Mi contraseña'; a1.className = 'linkbtn';
    const a2 = document.createElement('a'); a2.href = '/api/login?salir'; a2.textContent = 'Salir'; a2.className = 'linkbtn';
    links.append(a1, ' · ', a2); box.append(nom, links); foot.prepend(box);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pie); else pie();
})();
