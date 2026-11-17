// Conexión a la base (Postgres: Neon desde Vercel, o cualquier otro) y tablas.
import postgres from 'postgres';

const URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
let _sql = null, _listo = null;

export function sql() {
  if (!URL) throw Object.assign(new Error('Falta DATABASE_URL: conectá la base en Vercel (Storage).'), { status: 500 });
  if (!_sql) _sql = postgres(URL, { max: 3, prepare: false, ssl: /localhost|127\.0\.0\.1/.test(URL) ? false : 'require', idle_timeout: 20 });
  return _sql;
}

// Crea las tablas la primera vez (idempotente).
export async function base() {
  const s = sql();
  if (!_listo) _listo = (async () => {
    await s.unsafe(`
      create sequence if not exists ver_seq;
      create table if not exists docs (
        col text not null, id text not null, data jsonb, borrado boolean not null default false,
        ver bigint not null default nextval('ver_seq'), at timestamptz not null default now(),
        primary key (col, id));
      create index if not exists docs_ver on docs (ver);
      create table if not exists archivos (
        id text primary key, nombre text, tipo text, tam integer, datos bytea not null,
        de text, at timestamptz not null default now());
      create table if not exists usuarios (
        usuario text primary key, nombre text, hash text not null, admin boolean not null default false,
        activo boolean not null default true, at timestamptz not null default now());
      create table if not exists intentos (clave text primary key, n integer not null, hasta timestamptz);
      create table if not exists ajustes (k text primary key, v text not null);
      create table if not exists uso (
        id bigserial primary key, at timestamptz not null default now(), usuario text, que text, modelo text,
        entrada integer, salida integer, cache_lee integer, cache_escribe integer, usd numeric(12,6), seg numeric(8,1), ok boolean, error text);
      create index if not exists uso_at on uso (at);
      alter table archivos add column if not exists gz boolean not null default false;
      create table if not exists pjn_envios (
        clave text primary key, estado text not null, at timestamptz not null default now(), usuario text, carga_id text, datos jsonb);
    `);
  })().catch((e) => { _listo = null; throw e; });
  await _listo;
  return s;
}

// Un valor guardado en la base que se genera solo la primera vez (ej. la llave para firmar las sesiones).
export async function ajuste(k, crear) {
  const s = await base();
  const r = await s`select v from ajustes where k = ${k}`;
  if (r.length) return r[0].v;
  const v = crear();
  await s`insert into ajustes (k, v) values (${k}, ${v}) on conflict (k) do nothing`;
  return (await s`select v from ajustes where k = ${k}`)[0].v;
}

// Postgres no acepta el carácter nulo dentro de un texto JSON (aparece en modelos Word viejos): se quita antes de guardar.
export function sinNulos(o) {
  if (typeof o === 'string') return o.includes('\u0000') ? o.replaceAll('\u0000', '') : o;
  if (Array.isArray(o)) return o.map(sinNulos);
  if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [sinNulos(k), sinNulos(v)]));
  return o;
}
