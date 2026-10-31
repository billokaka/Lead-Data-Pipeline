// config.mjs: every setting comes from the environment, or from a .env file named by ENRICH_ENV_FILE
// (only the names below are read from it). Keys are never accepted from a tool argument and never printed.

import { readFileSync } from 'node:fs';

const NAMES = ['SUPABASE_DB_URL', 'SUPABASE_DB_CA_FILE', 'TREG_API_KEY', 'APOLLO_API_KEY', 'LEADOCEAN_API_KEY', 'LEMLIST_API_KEY',
  'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'ENRICH_PERSON', 'ENRICH_ALLOW_SPEND', 'ENRICH_SITE_MODEL', 'ENRICH_BATCH',
  'ENRICH_MAX_JOB_USD', 'ENRICH_TEST_BASE_URL', 'ENRICH_DB_INSECURE_TLS', 'ENRICH_APOLLO_CREDIT_USD', 'ENRICH_CONCURRENCY', 'ENRICH_MODEL_IN_USD_PER_M', 'ENRICH_MODEL_OUT_USD_PER_M',
  'SMARTLEAD_API_KEY', 'ENRICH_SMARTLEAD_USD_PER_FIND'];

function fromFile(path) {
  const out = {};
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { throw new Error(`ENRICH_ENV_FILE cannot be read: ${path}`); }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && NAMES.includes(m[1])) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export function loadConfig(env = process.env) {
  const file = env.ENRICH_ENV_FILE ? fromFile(env.ENRICH_ENV_FILE) : {};
  const get = (n) => { const v = String(env[n] ?? '').trim(); return v && !v.startsWith('${') ? v : (file[n] ?? '').trim(); };
  const num = (n, d, min, max) => {
    const v = get(n); if (!v) return d;
    const x = Number(v); if (!Number.isFinite(x) || x < min || x > max) throw new Error(`${n} must be a number from ${min} to ${max}`); return x;
  };

  const dbUrl = get('SUPABASE_DB_URL');
  if (!dbUrl) throw new Error('SUPABASE_DB_URL is not set (Supabase: Project Settings > Database > Connection string, session pooler)');
  if (!/^postgres(ql)?:\/\//.test(dbUrl)) throw new Error('SUPABASE_DB_URL must start with postgresql://');
  const person = get('ENRICH_PERSON');
  if (!person) throw new Error('ENRICH_PERSON is not set: the name of the person using this engine, for the usage log (e.g. Abdullah)');

  const testBase = get('ENRICH_TEST_BASE_URL');
  if (testBase && !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(testBase)) throw new Error('ENRICH_TEST_BASE_URL may only be http://127.0.0.1:<port> (tests only)');

  return Object.freeze({
    dbUrl,
    dbCaFile: get('SUPABASE_DB_CA_FILE') || null,
    dbInsecureTls: /^(true|1|yes)$/i.test(get('ENRICH_DB_INSECURE_TLS')),
    person,
    keys: Object.freeze({
      treg: get('TREG_API_KEY') || null,
      apollo: get('APOLLO_API_KEY') || null,
      leadocean: get('LEADOCEAN_API_KEY') || null,
      lemlist: get('LEMLIST_API_KEY') || null,
      smartlead: get('SMARTLEAD_API_KEY') || null,
      openrouter: get('OPENROUTER_API_KEY') || null,
      anthropic: get('ANTHROPIC_API_KEY') || null,
    }),
    // paid calls are off until the operator says so (the plan: "the operator's go before any paid call")
    allowSpend: /^(true|1|yes)$/i.test(get('ENRICH_ALLOW_SPEND')),
    // the small model that reads websites: Anthropic direct when its key is set, else OpenRouter (model ids differ)
    siteModel: get('ENRICH_SITE_MODEL') || (get('ANTHROPIC_API_KEY') ? 'claude-haiku-5-5' : 'anthropic/claude-haiku-4.5'),
    // [assumed] prices for the cost log where a tool does not report its own: set them from your plan
    modelInUsdPerM: num('ENRICH_MODEL_IN_USD_PER_M', 1, 0, 100),
    modelOutUsdPerM: num('ENRICH_MODEL_OUT_USD_PER_M', 5, 0, 500),
    apolloCreditUsd: num('ENRICH_APOLLO_CREDIT_USD', 0.01, 0, 10),
    // Smartlead's SmartProspect does not publish a price per found email: [assumed] until set from the plan
    smartleadFindUsd: num('ENRICH_SMARTLEAD_USD_PER_FIND', 0.01, 0, 10),
    concurrency: num('ENRICH_CONCURRENCY', 4, 1, 16),
    batch: num('ENRICH_BATCH', 25, 1, 200),
    maxJobUsd: num('ENRICH_MAX_JOB_USD', 50, 0, 5000),
    testBase: testBase || null,
    secrets() { return Object.values(this.keys).filter(Boolean).concat([dbUrl]); },
  });
}

// removes every secret from a text before it is shown or logged
export function redact(config, text) {
  let t = String(text ?? '');
  for (const s of config.secrets()) if (s && s.length >= 8) t = t.split(s).join('[secret removed]');
  return t.replace(/(postgres(?:ql)?:\/\/[^:@\s]+:)[^@\s]+@/gi, '$1[removed]@').replace(/(api[_-]?key|token)=[^&"'\s]+/gi, '$1=[removed]');
}
