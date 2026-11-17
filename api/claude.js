// Pedidos a Claude con la clave de API del estudio (ANTHROPIC_API_KEY en Vercel), con tope de gasto por mes.
// POST {messages, tools?, que: 'texto'|'json'|'consulta', max_tokens?} -> {content, stop_reason, model, usd}
// Las herramientas de Consultas se ejecutan en el navegador; acá solo se pasa el pedido a la API.
import Anthropic from '@anthropic-ai/sdk';
import { base } from './_lib/base.js';
import { exigir, cuerpo } from './_lib/sesion.js';

export const config = { maxDuration: 300 };

const MODELO = 'claude-opus-5-5';
// USD por millón de tokens: entrada, salida, lectura de caché, escritura de caché
const PRECIOS = {
  'claude-opus-5-5': [4, 20, 0.2, 5],
  'claude-opus-5': [5, 25, 0.5, 6.25],
  'claude-opus-4-8': [5, 25, 0.5, 6.25],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5],
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
};
const precio = (m) => PRECIOS[m] || PRECIOS['claude-opus-4-8'];
const costo = (m, us) => { const p = precio(m); return ((us.input_tokens || 0) * p[0] + (us.output_tokens || 0) * p[1] + (us.cache_read_input_tokens || 0) * p[2] + (us.cache_creation_input_tokens || 0) * p[3]) / 1e6; };
const ESFUERZO = { texto: 'high', json: 'high', consulta: 'medium' };

let cliente = null;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const t0 = Date.now();
  let u = null, que = 'texto';
  try {
    u = await exigir(req, res); if (!u) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ code: 'sin_clave', error: 'Falta cargar la clave de API de Claude en Vercel (ANTHROPIC_API_KEY).' });
    const b = await cuerpo(req);
    que = ['texto', 'json', 'consulta'].includes(b.que) ? b.que : 'texto';
    const messages = Array.isArray(b.messages) ? b.messages : [];
    if (!messages.length) return res.status(400).json({ error: 'Pedido vacío' });

    const s = await base();
    const tope = +(process.env.TOPE_USD_MES || 150);
    const gastado = +(await s`select coalesce(sum(usd), 0) as g from uso where at >= date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires') at time zone 'America/Argentina/Buenos_Aires'`)[0].g;
    if (gastado >= tope) return res.status(429).json({ code: 'tope', error: `Se llegó al tope de gasto de Claude de este mes (US$ ${tope}). Se renueva el día 1; Juan lo puede subir en Vercel (TOPE_USD_MES).` });

    const tools = (Array.isArray(b.tools) ? b.tools : []).slice(0, 20).map((t) => ({ name: String(t.name), description: String(t.description || ''), input_schema: t.input_schema || { type: 'object', properties: {} } }));
    if (!cliente) cliente = new Anthropic();
    const pedido = {
      model: MODELO,
      max_tokens: Math.min(Math.max(+b.max_tokens || 32000, 1024), 64000),
      messages,
      output_config: { effort: ESFUERZO[que] },
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      ...(tools.length ? { tools } : {}),
    };
    const r = await cliente.beta.messages.stream(pedido).finalMessage();
    const usd = costo(r.model || MODELO, r.usage || {});
    await s`insert into uso (usuario, que, modelo, entrada, salida, cache_lee, cache_escribe, usd, seg, ok)
      values (${u.usuario}, ${que}, ${r.model || MODELO}, ${r.usage?.input_tokens || 0}, ${r.usage?.output_tokens || 0}, ${r.usage?.cache_read_input_tokens || 0}, ${r.usage?.cache_creation_input_tokens || 0}, ${usd}, ${(Date.now() - t0) / 1000}, true)`;
    return res.status(200).json({ content: r.content, stop_reason: r.stop_reason, stop_details: r.stop_details || null, model: r.model, usd });
  } catch (e) {
    console.error(e);
    let code = 'error', status = 502, msg = 'Claude no pudo contestar. Probá de nuevo en un rato.';
    if (e instanceof Anthropic.RateLimitError) { code = 'rate_limited'; status = 429; msg = 'Claude está saturado o se llegó al límite de la cuenta. Probá en un rato.'; }
    else if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) { code = 'clave'; status = 503; msg = 'La clave de API de Claude no anda (revisá ANTHROPIC_API_KEY en Vercel o los créditos de la cuenta).'; }
    else if (e instanceof Anthropic.BadRequestError) { code = 'invalid_argument'; status = 400; msg = 'Claude rechazó el pedido: ' + String(e.message || '').slice(0, 300); }
    else if (e instanceof Anthropic.APIConnectionError) { code = 'conexion'; }
    try { if (u) { const s = await base(); await s`insert into uso (usuario, que, modelo, seg, ok, error, usd) values (${u.usuario}, ${que}, ${MODELO}, ${(Date.now() - t0) / 1000}, false, ${String(e.message || e).slice(0, 500)}, 0)`; } } catch {}
    return res.status(status).json({ code, error: msg });
  }
}
