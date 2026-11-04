// domainlist.mjs: the domain pre-filter on a CSV list, file to file (operator, 2026-11-03). Every row is kept: the
// verdict columns are added at the end, and the list is split into -alive (every row whose domain can take mail, or
// may) and -removed (dead domains). The DNS is free; the catch-all probe is paid and only runs when asked.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv, domainOf } from './csv.mjs';
import { checkDomains, onPlatform, normDomain } from './domaincheck.mjs';
import { FREEMAIL } from './rules.mjs';
import { SpendRefused } from './money.mjs';

export const DOMAIN_COLUMNS = ['domain', 'domain_verdict', 'domain_reason', 'mx_provider', 'mx_primary', 'is_gateway', 'has_spf', 'has_dmarc',
  'domain_age_days', 'recently_registered', 'is_catch_all', 'catch_all_source', 'website_status', 'website_redirects_to', 'google_indexed', 'google_source'];
const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const write = (file, header, rows) => writeFileSync(file, '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n');

// the company domain of a row: its website first (unless the "website" is a page on a shared platform such as
// Facebook or Wix), else a work email's domain (never a free mail host)
export function rowDomain(get) {
  for (const c of ['companyWebsite', 'website', 'company_website', 'company_url', 'domain', 'companyDomain', 'company_domain']) {
    const d = domainOf(get(c)); if (d && !onPlatform(normDomain(d))) return d;
  }
  const e = String(get('email') || get('Email') || '').toLowerCase();
  const d = e.includes('@') ? e.split('@')[1] : null;
  return d && !FREEMAIL.has(d) ? d : null;
}

// site: the free website check; indexed: Common Crawl, then (with providers) a paid Google search for the doubtful
export async function runDomainList({ input, checker, providers = null, catchAll = false, site = false, indexed = false, jobId = null, concurrency = 50, log = () => {} }) {
  const [header, ...rows] = parseCsv(readFileSync(input, 'utf8'));
  const k = (n) => header.indexOf(n);
  const domains = rows.map((r) => rowDomain((c) => (k(c) >= 0 ? String(r[k(c)] ?? '').trim() : '')));
  const before = checker.dnsLookups;
  const facts = await checkDomains(domains, checker, { concurrency, log });
  let probes = 0, stopped = null;
  if (catchAll) {
    // only live, non-gateway domains reach the paid probe; checker.catchAll skips cached ones and gateways
    const live = [...facts.values()].filter((f) => f.verdict === 'alive');
    const queue = [...live];
    await Promise.all(Array.from({ length: Math.min(8, queue.length || 1) }, async () => {
      while (queue.length && !stopped) {
        const f = queue.shift();
        try {
          const r = await checker.catchAll(f.domain, { providers, jobId });
          if (r.source === 'millionverifier') probes++;
          facts.set(f.domain, { ...facts.get(f.domain), is_catch_all: r.is_catch_all, catch_all_source: r.source });
        } catch (e) { if (e instanceof SpendRefused) { stopped = e.message; break; } log(`${f.domain}: ${e.message}`); }
      }
    }));
  }
  // the website (free) and the index (Common Crawl free, then a paid search) for every live or weak domain
  const pool = async (items, n, fn) => { const q = [...items]; await Promise.all(Array.from({ length: Math.min(n, q.length || 1) }, async () => { while (q.length && !stopped) await fn(q.shift()); })); };
  const kept = [...facts.values()].filter((f) => ['alive', 'weak'].includes(f.verdict));
  let searches = 0;
  if (site) await pool(kept, 20, async (f) => { const w = await checker.website(f.domain); facts.set(f.domain, { ...facts.get(f.domain), ...w }); });
  if (indexed) await pool(kept, 6, async (f) => {
    try {
      const g = await checker.indexed(f.domain, { providers, jobId });
      if (g.google_source === 'serper') searches++;
      facts.set(f.domain, { ...facts.get(f.domain), ...g });
    } catch (e) { if (e instanceof SpendRefused) stopped = e.message; else log(`${f.domain}: ${e.message}`); }
  });
  const cols = (d) => {
    const f = d ? facts.get(d) : null;
    if (!f) return [d ?? '', 'no_domain', 'no website or work email to check', ...Array(DOMAIN_COLUMNS.length - 3).fill('')];
    return [d, f.verdict, f.reason ?? '', f.provider ?? '', f.mx_primary ?? '', f.is_gateway ?? '', f.has_spf ?? '', f.has_dmarc ?? '',
      f.domain_age_days ?? '', f.recently_registered ?? '', f.is_catch_all ?? '', f.catch_all_source ?? '',
      f.website_status ?? '', f.website_redirects_to ?? '', f.google_indexed ?? '', f.google_source ?? ''];
  };
  const out = rows.map((r, i) => [...r, ...cols(domains[i])]);
  const head = [...header, ...DOMAIN_COLUMNS];
  const base = input.replace(/\.csv$/i, '');
  const vi = head.indexOf('domain_verdict');
  write(`${base}-domains.csv`, head, out);
  write(`${base}-alive.csv`, head, out.filter((r) => r[vi] !== 'dead'));
  write(`${base}-removed.csv`, head, out.filter((r) => r[vi] === 'dead'));
  const t = { rows: {}, domains: {} };
  for (const r of out) t.rows[r[vi]] = (t.rows[r[vi]] ?? 0) + 1;
  for (const f of facts.values()) t.domains[f.verdict] = (t.domains[f.verdict] ?? 0) + 1;
  const providersSeen = {}; for (const f of facts.values()) if (f.verdict === 'alive') providersSeen[f.provider] = (providersSeen[f.provider] ?? 0) + 1;
  const deadWhy = {}; for (const f of facts.values()) if (f.verdict === 'dead') deadWhy[f.dns_status] = (deadWhy[f.dns_status] ?? 0) + 1;
  const websites = {}, index = {}; for (const f of facts.values()) { if (f.website_status) websites[f.website_status] = (websites[f.website_status] ?? 0) + 1; if (f.google_source) index[`${f.google_indexed}:${String(f.google_source).split(' ')[0]}`] = (index[`${f.google_indexed}:${String(f.google_source).split(' ')[0]}`] ?? 0) + 1; }
  return { rows: rows.length, unique_domains: facts.size, dns_lookups: checker.dnsLookups - before, catch_all_probes: probes, google_searches: searches, websites, index, stopped,
    rows_by_verdict: t.rows, domains_by_verdict: t.domains, dead_because: deadWhy, providers: providersSeen,
    files: { all: `${base}-domains.csv`, alive: `${base}-alive.csv`, removed: `${base}-removed.csv` } };
}
