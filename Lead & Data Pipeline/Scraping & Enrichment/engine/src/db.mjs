// db.mjs: one small interface over the database, so the same engine code runs on Supabase (pg) and in the
// tests (PGlite with the real SQL files): query(text, params) -> rows; tx(fn); close().

import { readFileSync } from 'node:fs';

export async function openSupabase(config) {
  const { default: pg } = await import('pg');
  // Supabase's certificate is signed by Supabase's own CA (Project Settings > Database > SSL Configuration > Download
  // certificate). With SUPABASE_DB_CA_FILE the server is checked; without it the connection is refused, unless
  // ENRICH_DB_INSECURE_TLS=true says, knowingly, to accept an encrypted link to an unchecked server.
  if (!config.dbCaFile && !config.dbInsecureTls) {
    throw new Error('SUPABASE_DB_CA_FILE is not set: download Supabase\'s SSL certificate (Project Settings > Database) and give its path, or set ENRICH_DB_INSECURE_TLS=true');
  }
  const ssl = config.dbCaFile ? { ca: readFileSync(config.dbCaFile, 'utf8'), rejectUnauthorized: true } : { rejectUnauthorized: false };
  const pool = new pg.Pool({ connectionString: config.dbUrl, ssl, max: 4, idleTimeoutMillis: 30000, application_name: `wraith-enrichment:${config.person}` });
  return wrap({
    query: async (text, params) => (await pool.query(text, params)).rows,
    connect: async () => { const c = await pool.connect(); return { query: async (t, p) => (await c.query(t, p)).rows, release: () => c.release() }; },
    close: () => pool.end(),
  });
}

export function fromPglite(pg) {
  return wrap({
    query: async (text, params) => (await pg.query(text, params)).rows,
    connect: async () => ({ query: async (t, p) => (await pg.query(t, p)).rows, release: () => {} }),
    close: async () => {},
  });
}

function wrap(base) {
  return {
    query: base.query,
    close: base.close,
    async one(text, params) { return (await base.query(text, params))[0] ?? null; },
    async tx(fn) {
      const c = await base.connect();
      try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
      catch (e) { try { await c.query('rollback'); } catch { /* the original error matters */ } throw e; }
      finally { c.release(); }
    },
  };
}
