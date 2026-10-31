// organize.mjs: the results file, organized (operator, 2026-10-30). Every column is kept. Rows are sorted industry by
// industry (companyIndustry, blank last), then verified first, then catch-all, not found and the rest, then company
// name. Rows whose email_status is "duplicate" (their address already belongs to another row) are moved to their own
// file, so the organized file holds each address once and nothing is lost.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv } from './csv.mjs';

const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const ORDER = ['verified', 'catch_all', 'not_found', 'unknown', 'not_owner', 'hold_state', 'pending'];
// a UTF-8 mark first, so Excel shows accented names correctly; every reader of these files strips it
const write = (file, header, rows) => writeFileSync(file, '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n');

export function organize(input, { industryColumn = 'companyIndustry' } = {}) {
  const [header, ...rows] = parseCsv(readFileSync(input, 'utf8'));
  const k = (n) => header.indexOf(n);
  const ind = k(industryColumn) >= 0 ? k(industryColumn) : k('industry');
  const st = k('email_status'), co = k('companyName') >= 0 ? k('companyName') : k('company');
  if (st < 0) throw new Error('no email_status column: organize a results file');
  const dup = rows.filter((r) => r[st] === 'duplicate');
  const keep = rows.filter((r) => r[st] !== 'duplicate');
  const rank = (s) => { const i = ORDER.indexOf(s); return i < 0 ? ORDER.length : i; };
  const name = (r) => String(r[ind] ?? '').trim();
  keep.sort((a, b) => (!name(a)) - (!name(b)) || name(a).localeCompare(name(b)) || rank(a[st]) - rank(b[st])
    || String(a[co] ?? '').localeCompare(String(b[co] ?? '')));
  const base = input.replace(/\.csv$/i, '');
  write(`${base}-organized.csv`, header, keep);
  write(`${base}-duplicates-removed.csv`, header, dup);
  // the file to send from: only the rows with a verified email, in the same order
  write(`${base}-verified-only.csv`, header, keep.filter((r) => r[st] === 'verified'));
  // the per-industry counts, for the summary
  const by = new Map();
  for (const r of keep) {
    const n = name(r) || '(no industry)';
    const x = by.get(n) ?? { rows: 0, verified: 0, catch_all: 0, not_found: 0 };
    x.rows++; if (r[st] in x) x[r[st]]++;
    by.set(n, x);
  }
  return { organized: `${base}-organized.csv`, duplicates: `${base}-duplicates-removed.csv`, verifiedOnly: `${base}-verified-only.csv`, rows: rows.length, kept: keep.length, removed: dup.length,
    industries: [...by].map(([industry, x]) => ({ industry, ...x })).sort((a, b) => b.verified - a.verified) };
}
