// verifylist.mjs: checks the addresses a list already has (operator, 2026-11-03), file to file. Free checks first
// (syntax, disposable, the domain's DNS, the cache); then the catch-all answer (cached per domain); then one paid
// MillionVerifier check only where the free ones could not decide. Every row is kept, the result columns added.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv } from './csv.mjs';
import { verifyAddress } from './domaincheck.mjs';
import { SpendRefused } from './money.mjs';

export const VERIFY_COLUMNS = ['verify_status', 'verify_quality', 'verify_substatus', 'verify_checked_by', 'did_you_mean', 'is_role', 'is_free', 'is_disposable'];
const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export async function runVerifyList({ input, checker, providers, db = null, jobId = null, concurrency = 8, log = () => {} }) {
  const [header, ...rows] = parseCsv(readFileSync(input, 'utf8'));
  const e = ['email', 'Email', 'email_address', 'work_email'].map((c) => header.indexOf(c)).find((i) => i >= 0);
  if (e === undefined) throw new Error('no email column (email, Email, email_address or work_email)');
  const emails = [...new Set(rows.map((r) => String(r[e] ?? '').trim().toLowerCase()).filter(Boolean))];
  const results = new Map(), queue = [...emails];
  let stopped = null, n = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, emails.length || 1) }, async () => {
    while (queue.length && !stopped) {
      const em = queue.shift();
      try { results.set(em, await verifyAddress(em, { checker, providers, db, jobId })); }
      catch (err) { if (err instanceof SpendRefused) { stopped = err.message; break; } results.set(em, { status: 'unknown', quality: 'risky', substatus: `error: ${String(err.message).slice(0, 80)}` }); }
      if (++n % 100 === 0) log(`${n} of ${emails.length} addresses checked`);
    }
  }));
  const cols = (em) => { const r = results.get(em); return r ? [r.status, r.quality, r.substatus ?? '', r.checked_by ?? '', r.did_you_mean ?? '', r.is_role ?? '', r.is_free ?? '', r.is_disposable ?? ''] : ['', '', 'not checked yet', '', '', '', '', '']; };
  const out = input.replace(/\.csv$/i, '') + '-verified.csv';
  writeFileSync(out, '﻿' + [[...header, ...VERIFY_COLUMNS], ...rows.map((r) => [...r, ...cols(String(r[e] ?? '').trim().toLowerCase())])].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n');
  const t = {}; for (const r of results.values()) t[r.status] = (t[r.status] ?? 0) + 1;
  const paid = [...results.values()].filter((r) => /millionverifier/.test(r.checked_by ?? '') && r.source !== 'cached').length;
  return { rows: rows.length, unique_addresses: emails.length, checked: results.size, paid_checks: paid, stopped, by_status: t, file: out };
}
