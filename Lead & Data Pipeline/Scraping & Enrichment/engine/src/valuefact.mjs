// valuefact.mjs: the value-fact line (operator, 2026-11-01). For each verified row, Haiku 5.5 reads the value-fact
// prompt (prompts/value-fact-prompt.md, word for word, as the system message) and one row, and answers LINE, FALLBACK
// or SUPPRESS. Code checks every line against the prompt's hard rules it can test; a line that fails goes to REVIEW
// with the reason, never into value_fact. Progress is saved per email, so a stopped run carries on without paying twice.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, createHash } from 'node:crypto';
import { parseCsv } from './csv.mjs';
import { SpendRefused } from './money.mjs';

export const PROMPT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts', 'value-fact-prompt.md');
export const VF_AFTER_EMAIL = ['value_fact'];
export const VF_AT_END = ['value_fact_result', 'value_fact_signal'];
const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// the system message: the prompt file as written, without its title line
export const systemPrompt = (file = PROMPT_FILE) => readFileSync(file, 'utf8').replace(/^# .*\n/, '').trim();

// "Nashville, United States" or "Cleveland, Cuyahoga County, Ohio, United States" -> "Nashville" / "Cleveland, Ohio"
function cityOf(companyLocation, location) {
  const parts = String(companyLocation || location || '').split(',').map((s) => s.trim()).filter((s) => s && !/united states|county/i.test(s));
  return parts.slice(0, 2).join(', ');
}

// one row as the prompt's inputs; only the row's own facts (the owner's personal bio is left out on purpose)
// the prompt wants about half of all generated lines to end on the bare fact; one row at a time can't count, so half
// the rows (a fixed pick by email) are told to (operator's go, 2026-11-01: 107 of 116 test lines had a closer)
export const bareFact = (email) => (createHash('md5').update(String(email ?? '').toLowerCase()).digest()[0] & 1) === 0;

// "a HVAC" / "a accounting" in a filled template line -> "an ..."
export const fixArticle = (line) => String(line ?? '').replace(/\b([Aa]) (HVAC|IT|accounting|architecture|electrical|elevator|engineering|environmental|excavation|insurance|interior|irrigation|appliance|auto|asphalt|aerospace|industrial)\b/g, (m, a, w) => `${a}n ${w}`);

export function rowInput(get, sequence) {
  const input = {
    company_name: get('companyName'),
    trade: get('companyIndustry'),
    city: cityOf(get('companyLocation'), get('location')),
    description: get('companyDescription').slice(0, 2500),
    founded: get('companyFoundedOn'),
    employees: get('companySize'),
    sequence,
  };
  const ending = bareFact(get('email')) ? '\n\nFor this row: if you write a LINE, end it on the bare fact, with no closer.' : '';
  return `${JSON.stringify(input, null, 1)}\n\nThe trade field is a broad industry label; if the description names the trade itself (HVAC, plumbing, roofing, property management...), use that word for {trade}.${ending}`;
}

// the prompt's hard rules that code can test
const BANNED = /\b(impressive|great|amazing|love|congrats|congratulations|i noticed|i saw)\b/i;
const CORPORATE = /\b(portfolio|presence|solutions|footprint)\b/i;
const TRADE_WORDS = new Set(['inc', 'llc', 'ltd', 'corp', 'company', 'the', 'and', 'group', 'services', 'service', 'solutions', 'systems', 'plumbing', 'heating',
  'cooling', 'air', 'hvac', 'electric', 'electrical', 'roofing', 'construction', 'mechanical', 'management', 'property', 'properties', 'contractors', 'contracting',
  'enterprises', 'industries', 'home', 'homes', 'building', 'builders', 'pest', 'control', 'cleaning', 'landscaping', 'lawn', 'auto', 'repair', 'insurance',
  'agency', 'realty', 'real', 'estate', 'restoration', 'remodeling', 'painting', 'concrete', 'paving', 'fire', 'security', 'water', 'energy', 'solar', 'family',
  'sons', 'son', 'brothers', 'bros', 'associates', 'partners', 'international', 'usa', 'america', 'american', 'national', 'commercial', 'residential', 'pro', 'pros']);
export function checkLine(out, { companyName, sequence, city = '' }) {
  if (!out || !['LINE', 'FALLBACK', 'SUPPRESS'].includes(out.result)) return 'the answer was not LINE, FALLBACK or SUPPRESS';
  if (out.result === 'SUPPRESS') return null;
  const line = String(out.line ?? '').trim();
  // a FALLBACK with no line: the library has no approved line for this industry (it covers trades, professional
  // services, software and property management only); said plainly, never invented
  if (!line) return out.result === 'FALLBACK' ? 'no fallback line in the library for this industry' : `${out.result} with no line`;
  if (/[—–]/.test(line)) return 'an em or en dash';
  if (/\{(trade|city)\}/.test(line)) return 'an unfilled {trade} or {city}';
  // the city's own words ("Great Barrington") are not compliments
  const cityWords = String(city ?? '').split(/[^A-Za-z]+/).filter((w) => w.length > 2);
  const noCity = cityWords.reduce((s, w) => s.replace(new RegExp(`\\b${w}\\b`, 'g'), ' '), line);
  if (BANNED.test(noCity)) return 'a banned word (compliment or "I noticed")';
  if (CORPORATE.test(line)) return 'a corporate word';
  if (sequence === 'A' && /\bbuyers?\b/i.test(line)) return 'mentions buyers in sequence A';
  // the company's own name: two words of it side by side, written as a name (capitalized, not at the start of the
  // line) and at least one distinctive. Lowercase "air duct cleaning" or "window cleaning" is the work, not the name
  // (the full run held 140 good lines back on that)
  const skip = new Set(String(city ?? '').toLowerCase().split(/[^a-z]+/));
  const words = String(companyName ?? '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter((w) => w && !['inc', 'llc', 'ltd', 'corp', 'co'].includes(w));
  const tokens = line.replace(/[^A-Za-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i + 1 < words.length; i++) {
    const distinctive = [words[i], words[i + 1]].some((w) => w.length > 2 && !TRADE_WORDS.has(w) && !skip.has(w));
    if (!distinctive) continue;
    for (let j = 0; j + 1 < tokens.length; j++) {
      const same = tokens[j].toLowerCase() === words[i] && tokens[j + 1].toLowerCase() === words[i + 1];
      const asName = [tokens[j], tokens[j + 1]].some((t, n) => /^[A-Z]/.test(t) && j + n > 0);
      if (same && asName) return 'uses the company name';
    }
  }
  if (line.split(/\s+/).length > 45) return 'too long';
  return null;
}

export function loadDone(file) {
  const done = new Map();
  if (!existsSync(file)) return done;
  // a line { email, f: null } puts a row back to be written again (used to rewrite rows under a changed rule)
  for (const l of readFileSync(file, 'utf8').split('\n')) { if (!l.trim()) continue; try { const x = JSON.parse(l); if (x.f === null) done.delete(x.email); else done.set(x.email, x.f); } catch { /* a cut-off line is skipped */ } }
  return done;
}

// the run: up to `limit` rows not done yet (random when `sample`), saved per row; stops cleanly at a budget or the cap
// retryReview: only the rows that went to REVIEW, once more each (a REVIEW row is never retried twice)
export async function runValueFacts({ input, limit, providers, jobId, sequence = 'A', sample = false, retryReview = false, concurrency = 6, log = () => {}, system = systemPrompt() }) {
  const [header, ...rows] = parseCsv(readFileSync(input, 'utf8'));
  const k = (n) => header.indexOf(n);
  if (k('email') < 0) throw new Error('no email column');
  const base = input.replace(/\.csv$/i, '');
  const progress = `${base}.valuefact.progress.jsonl`;
  const done = loadDone(progress);
  const again = (e) => { const f = done.get(e); return f && f.result === 'REVIEW' && !f.retried; };
  let todo = rows.map((r, i) => i).filter((i) => rows[i][k('email')] && rows[i][k('email_status')] !== 'duplicate'
    && (retryReview ? again(rows[i][k('email')]) : !done.has(rows[i][k('email')])));
  if (sample) for (let i = todo.length - 1; i > 0; i--) { const j = randomInt(i + 1); [todo[i], todo[j]] = [todo[j], todo[i]]; }
  todo = todo.slice(0, limit);
  let n = 0, errors = 0, stopped = null;
  const queue = [...todo];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length && !stopped) {
      const i = queue.shift();
      const get = (c) => (k(c) >= 0 ? String(rows[i][k(c)] ?? '').trim() : '');
      try {
        const out = await providers.valueFact({ system, user: rowInput(get, sequence), jobId });
        const problem = checkLine(out, { companyName: get('companyName'), sequence, city: get('companyLocation') });
        const f = problem ? { result: 'REVIEW', line: '', signal: `${problem}: ${String(out?.line ?? '').slice(0, 200)}` }
          : { result: out.result, line: out.result === 'SUPPRESS' ? '' : fixArticle(String(out.line).trim()), signal: String(out.signal ?? '').slice(0, 200) };
        if (retryReview) f.retried = true;
        appendFileSync(progress, JSON.stringify({ email: get('email'), f }) + '\n');
        done.set(get('email'), f);
        if (++n % 20 === 0) log(`${n} of ${todo.length} rows done`);
      } catch (e) {
        if (e instanceof SpendRefused) { stopped = e.message; break; }
        errors++; log(`row ${i + 2}: ${e.message}`);
      }
    }
  }));
  return { header, rows, done, processed: n, planned: todo.length, errors, stopped, base, picked: todo };
}

// the file with value_fact right after email and the two check columns at the end; `only` limits it to some rows
export function writeValueFacts({ header, rows, done, out, only = null }) {
  const e = header.indexOf('email') + 1;
  const lines = [[...header.slice(0, e), ...VF_AFTER_EMAIL, ...header.slice(e), ...VF_AT_END].map(esc).join(',')];
  const pick = only ? only.map((i) => rows[i]) : rows;
  for (const r of pick) {
    const f = done.get(r[e - 1]) ?? {};
    lines.push([...r.slice(0, e), f.line ?? '', ...r.slice(e), f.result ?? '', f.signal ?? ''].map(esc).join(','));
  }
  writeFileSync(out, '﻿' + lines.join('\r\n') + '\r\n');
  return out;
}
