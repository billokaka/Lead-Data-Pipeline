// listemail.mjs: email enrichment of a list, file in and file out. No contact is written to Supabase; only the job
// row and one costs row per paid call are, because that is how the budgets and the job's cap are enforced.
//   - who: owners, CEOs, founders and co-founders by job title (a former, product or partner "owner" never)
//   - order: Leadocean (by LinkedIn, inside the deal), then Apollo's match and Smartlead's SmartProspect find, split
//     half and half over the rows. A tool out of credits is switched off for the rest of the run
//   - an address its own provider marks verified is accepted with no paid check (operator, 2026-10-29, D9-5); when
//     none has one, the first unverified address (or the list's own) gets one MillionVerifier check. No patterns
//   - progress is saved after every row (a .progress.jsonl beside the results), so a stopped run carries on
// Every original column is kept, in its order; email_status and its columns follow email, the details go at the end.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, extname } from 'node:path';
import { parseCsv, domainOf } from './csv.mjs';
import { ownerRole, normEmail, looksLikeEmail, isFreemail, isRoleAddress, verdict } from './rules.mjs';
import { SpendRefused } from './money.mjs';

// the fields each done row keeps in the progress file (the results file's columns are AFTER_EMAIL and AT_END, below)
export const ADDED = ['enrich_status', 'enrich_reason', 'enrich_email', 'enrich_source', 'enrich_lane', 'enrich_verifier_a', 'enrich_verifier_b',
  'enrich_checked_at', 'enrich_catchall_email', 'enrich_note'];
const TITLE = /\b(owner|owners|co-?owner|ceo|chief executive|founder|co-?founder|cofounder|founding)\b/i;
// "President" alone is run too and counts as an owner (operator, 2026-10-29, D9-6); the column notes it.
// "Vice President" never counts (ownerRole refuses it).
const PRESIDENT = /\bpresident\b/i;
export const eligibleTitle = (t) => (TITLE.test(String(t ?? '')) || PRESIDENT.test(String(t ?? ''))) && Boolean(ownerRole(t));
// the operator approved plain "President" as an owner title (D9-6, 2026-10-29); the column still says so, for the record
export const titleCheck = (t) => (!TITLE.test(String(t ?? '')) && PRESIDENT.test(String(t ?? '')) ? 'president (approved as owner, D9-6)'
  : !eligibleTitle(t) ? 'not an owner by title' : '');

// an email domain that is plainly the same firm's: a subdomain of the website, the same name under another ending,
// or a name sharing its first 6 letters (raybrownac.com for raybrownairandheat.com). Another business never is.
const label = (d) => String(d ?? '').toLowerCase().split('.').slice(0, -1).join('').replace(/[^a-z0-9]/g, '');
export function nearDomain(emailDomain, siteDomain) {
  const e = String(emailDomain ?? '').toLowerCase(), s = String(siteDomain ?? '').toLowerCase();
  if (!e || !s) return false;
  if (e === s || e.endsWith(`.${s}`) || s.endsWith(`.${e}`)) return true;
  const a = label(e.split('.').slice(-2).join('.')), b = label(s.split('.').slice(-2).join('.'));
  if (a.length < 6 || b.length < 6) return a === b && a.length > 0;
  let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return a === b || k >= 6 || (a.length >= 6 && b.includes(a)) || (b.length >= 6 && a.includes(b));
}

const col = (h, ...names) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
export function readRows(path) {
  const all = parseCsv(readFileSync(path, 'utf8'));
  const [header, ...rows] = all;
  const at = {
    first: col(header, 'firstName', 'First Name', 'first_name'), last: col(header, 'lastName', 'Last Name', 'last_name'),
    email: col(header, 'email', 'Email'), linkedin: col(header, 'linkedinUrl', 'LinkedIn', 'linkedin_url'),
    title: col(header, 'jobTitle', 'Title', 'title'), company: col(header, 'companyName', 'Company', 'company'),
    website: col(header, 'companyWebsite', 'Website', 'website'), location: col(header, 'location', 'Location'),
  };
  for (const k of ['first', 'last', 'title', 'website']) if (at[k] < 0) throw new Error(`no ${k} column in the file`);
  return { header, rows, at };
}

// "Cleveland, Cuyahoga County, Ohio, United States" -> Ohio's code, from us_states
export function stateOf(location, states) {
  const parts = String(location ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length || !/united states|^usa?$/i.test(parts.at(-1))) return null;
  for (const p of parts.slice(0, -1).reverse()) { const s = states.get(p.toLowerCase()); if (s) return s; }
  return null;
}

const esc = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const now = () => new Date().toISOString();

// one row (operator, 2026-10-29, "avoid pay per use", D9-5): ask the three providers for an address they mark verified
// themselves; that is accepted with no paid check. Only when none of them has one, the best unverified address gets
// ONE cheap check (MillionVerifier). No patterns. A provider's own catch-all answer is kept apart at no cost.
export async function enrichRow(row, at, { providers, jobId, index = 0 }) {
  const g = (k) => (at[k] >= 0 ? String(row[at[k]] ?? '').trim() : '');
  const first = g('first'), last = g('last'), name = `${first} ${last}`.trim();
  const domain = domainOf(g('website'));
  const li = g('linkedin');
  const tried = [];
  const unverified = [];   // addresses a provider gave without its own "verified": the first gets the one paid check
  let caught = null;       // the first address a provider (or the check) called catch-all: kept apart, never in email
  // a provider's address is used only when it could be the owner's own work address; the same firm's other domain is
  // used too, in the stricter lane and flagged
  const usable = (email) => {
    const e = normEmail(email);
    if (!e || !looksLikeEmail(e) || isFreemail(e) || isRoleAddress(e)) return null;
    const ed = e.split('@')[1];
    if (!domain || ed === domain) return { email: e, near: false };
    return nearDomain(ed, domain) ? { email: e, near: true } : null;
  };
  const accept = (u, source, a, checked) => ({
    enrich_status: 'verified', enrich_email: u.email, enrich_source: source,
    enrich_lane: !domain || u.near || checked ? 'verified' : 'main',
    enrich_verifier_a: a, enrich_verifier_b: '', enrich_checked_at: now(),
    enrich_note: [!domain ? 'no website: the domain was not checked' : u.near ? `email domain differs from the website (${domain})` : null,
      tried.length ? tried.join(' | ') : null].filter(Boolean).join(' | ') || null,
  });
  const status = (ref, fallback) => String(ref ?? fallback).replace(/^\w+ /, '');
  // what one provider gave: verified by itself -> accepted; catch-all by itself -> kept apart; else -> waits for the check
  const take = (x, source) => {
    if (!x?.email) return null;
    const u = usable(x.email);
    if (!u) { tried.push(`${source} ${x.email}: not used (${x.ref ?? 'not the firm’s own address'})`); return null; }
    if (/catch.?all/i.test(x.ref ?? '')) { tried.push(`${source} ${u.email}: catch_all (by ${source})`); caught ??= u.email; return null; }
    if (!x.generated) return accept(u, source, `${source}:${status(x.ref, 'verified')}`, false);
    tried.push(`${source} ${u.email}: ${status(x.ref, 'not verified')}`);
    if (!unverified.some((v) => v.u.email === u.email)) unverified.push({ u, source });
    return null;
  };
  const end = (f) => ({ ...f, enrich_catchall_email: caught, enrich_note: tried.join(' | ') || null });

  // the list's own address counts as unverified: it gets the one check if nothing better turns up
  const own = normEmail(g('email'));
  if (own && looksLikeEmail(own)) unverified.push({ u: { email: own, near: false }, source: 'list' });
  if (li) {
    const r = take(await providers.findEmail({ source: 'leadocean', name, first, last, domain, person: { owner_sources: [], linkedin_url: li }, jobId }), 'leadocean');
    if (r) return r;
  }
  // Apollo and Smartlead share the work: half the rows ask Apollo first, half Smartlead; the other only on a miss
  const asks = [
    async () => (li ? take(await providers.apolloMatch({ linkedin: li, first, last, domain, jobId }), 'apollo') : null),
    async () => (providers.smartleadFind && domain ? take(await providers.smartleadFind({ first, last, domain, jobId }), 'smartlead') : null),
  ];
  for (const ask of (index % 2 ? [asks[1], asks[0]] : asks)) { const r = await ask(); if (r) return r; }

  // nothing verified by its own provider: one cheap check, on the first unverified address only
  if (!unverified.length) {
    return end({ enrich_status: caught ? 'catch_all' : 'not_found', enrich_reason: caught ? 'catch-all: an address cannot be proved' : 'no provider had an address' });
  }
  const { u, source } = unverified[0];
  const a = await providers.verify({ which: 'a', email: u.email, jobId });
  const v = verdict(a?.result);
  tried.push(`${source} ${u.email}: ${v} (one check)`);
  if (v === 'valid') return accept(u, source, `${a.tool}:${a.result}`, true);
  if (v === 'catch_all') { caught ??= u.email; return end({ enrich_status: 'catch_all', enrich_reason: 'catch-all: an address cannot be proved' }); }
  return end({ enrich_status: v === 'invalid' ? 'not_found' : 'unknown', enrich_reason: v === 'invalid' ? 'the only address failed its check' : 'the check could not decide' });
}

// a slow tool must not hold the whole run up (2026-10-29: Leadocean went from 2 to 60 seconds a lookup): each lookup
// gets `ms`; after `strikes` slow ones in a row the tool is skipped for `restMs`, then tried again. A skipped or slow
// lookup is a miss, so the row goes on to the next tool. The late answer is still logged by paid(), and dropped.
export function patient(fn, { ms = 15000, strikes = 5, restMs = 10 * 60000, name = 'a tool', log = () => {}, clock = Date.now } = {}) {
  let slow = 0, until = 0;
  return async (args) => {
    if (clock() < until) return null;
    let timer;
    const LATE = Symbol('late');
    const late = new Promise((ok) => { timer = setTimeout(() => ok(LATE), ms); });
    const p = fn(args);
    p.catch(() => {});
    const r = await Promise.race([p, late]).finally(() => clearTimeout(timer));
    if (r !== LATE) { slow = 0; return r; }
    if (++slow >= strikes) { until = clock() + restMs; slow = 0; log(`${name} is slow (${strikes} lookups over ${ms / 1000}s in a row): skipped for ${restMs / 60000} minutes`); }
    return null;
  };
}

// the second pass (operator, 2026-10-29), on the rows the first pass left without an email (not found or unknown):
// Leadocean once more (free; many rows were done while it was too slow to ask), then Kitt through treg, which is
// charged only when it finds an address; a Kitt find gets one MillionVerifier check.
// A row is tried once (kitt_tried), and whatever it holds is kept when Kitt finds nothing.
export const kittWorthTrying = (f) => f && ['not_found', 'unknown'].includes(f.enrich_status) && !f.kitt_tried;
export async function kittRow(row, at, prevIn, { providers, jobId }) {
  let prev = prevIn;
  const g = (k) => (at[k] >= 0 ? String(row[at[k]] ?? '').trim() : '');
  const first = g('first'), last = g('last'), name = `${first} ${last}`.trim();
  const domain = domainOf(g('website'));
  const keep = (note) => ({ ...prev, kitt_tried: true, leadocean_retried: true, enrich_note: [prev.enrich_note, note].filter(Boolean).join(' | ') || null });
  // Leadocean first (free in the deal): rows done while it was slow never got to ask it
  const li = g('linkedin');
  if (li && !prev.leadocean_retried) {
    const lo = await providers.findEmail({ source: 'leadocean', name, first, last, domain, person: { owner_sources: [], linkedin_url: li }, jobId });
    const e = normEmail(lo?.email);
    const own = e && looksLikeEmail(e) && !isFreemail(e) && !isRoleAddress(e) && (!domain || e.split('@')[1] === domain || nearDomain(e.split('@')[1], domain));
    if (own && !lo.generated && !/catch.?all/i.test(lo.ref ?? '')) {
      return { ...prev, kitt_tried: true, leadocean_retried: true, enrich_status: 'verified', enrich_reason: null, enrich_email: e, enrich_source: 'leadocean',
        enrich_lane: domain && e.split('@')[1] === domain ? 'main' : 'verified', enrich_verifier_a: `leadocean:${String(lo.ref ?? 'verified').replace(/^\w+ /, '')}`,
        enrich_verifier_b: '', enrich_checked_at: now(), enrich_note: [prev.enrich_note, `leadocean (second pass) ${e}: verified`].filter(Boolean).join(' | ') };
    }
    if (own && /catch.?all/i.test(lo.ref ?? '')) prev = { ...prev, enrich_catchall_email: prev.enrich_catchall_email || e };
  }
  if (!domain || !first || !last) return { ...keep('kitt: not tried (no website or no full name)'), leadocean_retried: true };
  const k = await providers.findEmail({ source: 'kitt', name, first, last, domain, jobId });
  const e = normEmail(k?.email);
  if (!e || k.generated || !looksLikeEmail(e) || isFreemail(e) || isRoleAddress(e) || e.split('@')[1] !== domain) {
    return keep(k?.email ? `kitt ${k.email}: not used (guessed or not the firm's own address)` : 'kitt: none');
  }
  const a = await providers.verify({ which: 'a', email: e, jobId });
  const v = verdict(a?.result);
  if (v === 'valid') {
    return { ...prev, kitt_tried: true, enrich_status: 'verified', enrich_reason: null, enrich_email: e, enrich_source: 'kitt', enrich_lane: 'main',
      enrich_verifier_a: `${a.tool}:${a.result}`, enrich_verifier_b: '', enrich_checked_at: now(),
      enrich_note: [prev.enrich_note, `kitt ${e}: valid (one check)`].filter(Boolean).join(' | ') };
  }
  if (v === 'catch_all') return { ...keep(`kitt ${e}: catch_all`), enrich_status: 'catch_all', enrich_reason: 'catch-all: an address cannot be proved', enrich_catchall_email: prev.enrich_catchall_email || e };
  return keep(`kitt ${e}: ${v} (one check)`);
}

// the test run's rows that the stricter rules left without an address, worth one more look under the new ones
export const worthRedo = (f) => f && (f.enrich_status === 'not_found' || f.enrich_status === 'catch_all' || f.enrich_status === 'unknown')
  && /: not used \((apollo|leadocean) verified\)/.test(f.enrich_note ?? '');

export function paths(input, outDir) {
  const stem = basename(input, extname(input)).replace(/[^\w.-]+/g, '_');
  return { stem, progress: join(outDir, `${stem}.progress.jsonl`), out: join(outDir, `${stem}-enriched.csv`), report: join(outDir, `${stem}-report.md`) };
}

export function loadProgress(file) {
  const done = new Map();
  if (!existsSync(file)) return done;
  for (const line of readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { const x = JSON.parse(line); done.set(x.i, x.f); } catch { /* a cut-off last line is skipped */ } }
  return done;
}

// the run: up to `limit` eligible rows not done yet; stops cleanly at a budget or the job's cap
// redo: rows already done that the stricter first rules left without an address are run once more (first, before new rows)
export async function runList({ input, outDir, limit, providers, jobId, states, concurrency = 4, log = () => {}, redo = false, skipHold = false, patience = {}, kitt = false, allTitles = false }) {
  mkdirSync(outDir, { recursive: true });
  const { header, rows, at } = readRows(input);
  const p = paths(input, outDir);
  const done = loadProgress(p.progress);
  const slowTools = { ...providers, findEmail: patient(providers.findEmail, { ...patience, name: 'Leadocean', log }),
    ...(providers.apolloMatch ? { apolloMatch: patient(providers.apolloMatch, { ...patience, name: 'Apollo', log }) } : {}),
    ...(providers.smartleadFind ? { smartleadFind: patient(providers.smartleadFind, { ...patience, name: 'Smartlead', log }) } : {}) };
  // Kitt looks the address up live, so it gets longer before it counts as slow
  const kittTools = { ...providers, findEmail: patient(providers.findEmail, { ms: 45000, strikes: 5, name: 'Kitt', log, ...patience }) };
  const todo = [];
  if (redo) for (const [i, f] of done) if (todo.length < limit && worthRedo(f)) todo.push(i);
  if (kitt) for (const [i, f] of done) if (todo.length < limit && kittWorthTrying(f)) todo.push(i);
  // hold-state rows can be left for later (operator, 2026-10-29): they can't be emailed until the states are cleared
  const held = (r) => skipHold && Boolean(stateOf(r[at.location], states)?.hold);
  if (!kitt) for (let i = 0; i < rows.length && todo.length < limit; i++) if (!done.has(i) && (allTitles || eligibleTitle(rows[i][at.title])) && !held(rows[i])) todo.push(i);
  let stopped = null, errors = 0, n = 0, inARow = 0;
  const queue = [...todo];
  const worker = async () => {
    while (queue.length && !stopped) {
      const i = queue.shift();
      try {
        const f = kitt ? await kittRow(rows[i], at, done.get(i), { providers: kittTools, jobId })
          : await enrichRow(rows[i], at, { providers: slowTools, jobId, index: i });
        appendFileSync(p.progress, JSON.stringify({ i, f }) + '\n');
        done.set(i, f);
        inARow = 0;
        if (++n % 10 === 0) log(`${n} of ${todo.length} rows done`);
      } catch (e) {
        if (e instanceof SpendRefused) { stopped = e.message; break; }
        errors++; log(`row ${i + 2}: ${e.message}`);       // not saved: the next run tries it again
        // many failures in a row means a tool is down or a key is wrong, not bad rows: stop rather than grind on
        if (++inARow >= 15) { stopped = `15 rows failed in a row; the last: ${e.message}`; break; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  writeOutput({ header, rows, at, done, out: p.out, states, skipHold });
  return { processed: n, planned: todo.length, errors, stopped, ...p };
}

// the results file (operator, 2026-10-29): one email column. Right after it: email_status, email_source, email_lane,
// catchall_email. Every other original column in its order. At the end: state, state_on_hold, title_check,
// checked_by, checked_at, enrich_note. One address is never given to two rows.
export const AFTER_EMAIL = ['email_status', 'email_source', 'email_lane', 'catchall_email'];
export const AT_END = ['state', 'state_on_hold', 'title_check', 'checked_by', 'checked_at', 'enrich_note'];
const STATUS = { verified: 'verified', catch_all: 'catch_all', not_found: 'not_found', unknown: 'unknown', duplicate_email: 'duplicate', pending: 'pending' };

export function writeOutput({ header, rows, at, done, out, states, skipHold = false }) {
  const owner = new Map();
  // an address the list already holds belongs to that row
  if (at.email >= 0) rows.forEach((r, i) => { const e = normEmail(r[at.email]); if (e && !owner.has(e)) owner.set(e, i); });
  const cut = at.email >= 0 ? at.email + 1 : header.length;
  const lines = [[...header.slice(0, cut), ...AFTER_EMAIL, ...header.slice(cut), ...AT_END].map(esc).join(',')];
  rows.forEach((r, i) => {
    const state = stateOf(r[at.location], states);
    const f = { ...(done.get(i) ?? (eligibleTitle(r[at.title])
      ? (skipHold && state?.hold ? { enrich_status: 'hold_state', enrich_reason: 'hold state: left for later' } : { enrich_status: 'pending', enrich_reason: 'not run yet' })
      : { enrich_status: 'not_owner', enrich_reason: 'not an owner, CEO, founder, co-founder or president by title' })) };
    // rows done before the catch-all column existed: the provider's address is in the note
    if (f.enrich_status !== 'verified' && !f.enrich_catchall_email) {
      const note = String(f.enrich_note ?? '');
      // an address a check, or the provider itself, called catch-all, and only one that passes the domain rule
      const site = domainOf(r[at.website]);
      const cands = [...note.matchAll(/(?:apollo|leadocean|smartlead|list) (\S+@\S+?): (?:catch_all|not used \([a-z]+ catch_all\))/gi)].map((m) => normEmail(m[1]));
      f.enrich_catchall_email = cands.find((e) => !isRoleAddress(e) && !isFreemail(e) && (!site || nearDomain(e.split('@')[1], site))) ?? '';
    }
    const row = [...r];
    while (row.length < header.length) row.push('');
    let status = STATUS[f.enrich_status] ?? (f.enrich_status === 'skipped' ? 'not_owner' : f.enrich_status);
    let note = [f.enrich_reason, f.enrich_note].filter(Boolean).join(' | ');
    if (f.enrich_status === 'verified') {
      const prev = owner.get(f.enrich_email);
      if (prev !== undefined && prev !== i) {
        status = 'duplicate';
        note = `same email as row ${prev + 2}${note ? ' | ' + note : ''}`;
      } else {
        owner.set(f.enrich_email, i);
        // the verified address goes in the one email column; a listed address is never overwritten
        const listed = normEmail(row[at.email]);
        if (at.email >= 0 && !listed) row[at.email] = f.enrich_email;
        else if (listed && listed !== f.enrich_email) note = `the list's own email is kept; the verified one is ${f.enrich_email}${note ? ' | ' + note : ''}`;
      }
    } else if (f.enrich_status === 'duplicate_email') status = 'duplicate';
    // an address was found but couldn't be proved: that's catch_all, not "not found", whatever came after it
    if (!['verified', 'duplicate'].includes(status) && f.enrich_catchall_email) status = 'catch_all';
    // a listed email that did not pass is said plainly, so nobody sends to it by mistake
    if (status !== 'verified' && at.email >= 0 && normEmail(row[at.email])) note = `the list's email is NOT verified${note ? ' | ' + note : ''}`;
    const verified = status === 'verified';
    const lane = verified ? (f.enrich_lane === 'main' ? 'main' : 'separate') : '';
    const checkedBy = verified ? [f.enrich_verifier_a, f.enrich_verifier_b].filter(Boolean).join(', ') : '';
    const after = [status, verified ? f.enrich_source ?? '' : '', lane, f.enrich_catchall_email ?? ''];
    // the operator approved the hold states for list outreach (D9-7, 2026-10-30): the column keeps the fact, marked approved
    const end = [state?.code ?? '', state ? (state.hold ? 'approved (D9-7)' : 'no') : '', titleCheck(r[at.title]), checkedBy, verified ? f.enrich_checked_at ?? '' : '', note];
    lines.push([...row.slice(0, cut), ...after, ...row.slice(cut), ...end].map(esc).join(','));
  });
  writeFileSync(out, lines.join('\r\n') + '\r\n');
  return out;
}
