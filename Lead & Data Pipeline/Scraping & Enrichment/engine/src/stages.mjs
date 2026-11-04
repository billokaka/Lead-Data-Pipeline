// stages.mjs: the five steps of the pipeline. Each takes a row a worker claimed and works through the provider
// interface (providers/index.mjs).
//   - Fenced: a row's lease is renewed when its work starts, and every write ends with "and claimed_by = <this worker>",
//     so a worker whose lease ran out (and whose row another machine took) can change nothing.
//   - Every paid call carries the row's job, so the job's ceiling covers the whole pipeline, not only the sourcing.
//   - A step never overwrites a filled field with an empty one (playbook §3.6).
// v1.1, 2026-10-29, after the reviewer's attack (work-records/2026-10-29-scraping-enrichment.md).

import { decideOwner, ownSiteEmailFor, patterns, isFreemail, isRoleAddress, looksLikeEmail, normEmail, splitName, verdict, ownerRole, normName } from './rules.mjs';
import { SpendRefused } from './money.mjs';
import { makeDomainChecker } from './domaincheck.mjs';

const LEASE_SECONDS = 1800;
const ID = { companies: 'company_id', people: 'person_id' };
export class LostLease extends Error {}

// renews the lease when a row's work starts; false when another worker has it now
async function hold(ctx, table, id) {
  const r = await ctx.db.query(`update ${table} set claimed_until = now() + make_interval(secs => $3) where ${ID[table]} = $1 and claimed_by = $2 returning ${ID[table]}`,
    [id, ctx.worker, LEASE_SECONDS]);
  return r.length === 1;
}
// a fenced update: sets the fields, releases the lease, and only if this worker still holds the row
async function write(ctx, table, id, fields) {
  const keys = Object.keys(fields);
  const r = await ctx.db.query(
    `update ${table} set ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}${keys.length ? ', ' : ''}claimed_by = null, claimed_until = null
     where ${ID[table]} = $1 and claimed_by = $2 returning ${ID[table]}`, [id, ctx.worker, ...keys.map((k) => fields[k])]);
  if (r.length !== 1) throw new LostLease(`${table} ${id}: the lease went to another worker; nothing written`);
}

// ---- 1. source: a job's places x queries x sources into import_companies, then the existing loader ---------
export async function runSource(ctx, job) {
  const { db, providers, log } = ctx;
  const p = job.params ?? {};
  const max = Math.min(Number(p.max_companies) || 200, 5000);
  const industry = job.industry_code ? (await db.one('select name from industries where industry_code = $1', [job.industry_code]))?.name : null;
  let added = 0, stopped = null;
  const put = async (tool, item) => {
    if (added >= max || !item?.name) return;
    await db.query(
      `insert into import_companies (source_tool, company_name, website, industry, location, city, state, phone, linkedin_url, job_id,
         google_place_id, google_category, rating, review_count)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [tool, item.name, item.website ?? null, industry ?? item.category ?? null, item.address ?? item.location ?? null, item.city ?? null,
        item.state ?? null, item.phone ?? null, item.linkedin ?? null, job.job_id, item.placeId ?? null, item.category ?? null,
        Number.isFinite(item.rating) ? item.rating : null, Number.isFinite(item.reviews) ? item.reviews : null]);
    added++;
  };
  try {
    for (const source of p.sources ?? ['google_maps']) {
      if (source === 'google_maps') {
        // Maps has no paging (one call returns up to 100 places): coverage comes from several queries per place
        for (const place of p.places ?? []) for (const query of p.queries ?? [industry]) {
          if (added >= max || ctx.signal?.aborted) break;
          const r = await providers.maps({ query, place, jobId: job.job_id });
          for (const it of r.items) await put('google_maps', it);
        }
      } else {
        const r = await providers.companies({ source, params: p, industry, limit: max - added, jobId: job.job_id });
        for (const it of r.items) await put(source, it);
      }
      if (added >= max) break;
    }
  } catch (e) {
    if (!(e instanceof SpendRefused)) throw e;
    stopped = e.message;
    log(`job ${job.job_id}: stopped early: ${e.message}`);
  }
  const loaded = await db.query('select * from load_imports_locked($1)', ['other']);
  const applied = await db.one('select apply_job_imports($1) as n', [job.job_id]);
  // the new companies start the pipeline at the domain check (free DNS before any spend); set here so a hand import does not
  await db.query(`update companies set enrichment_stage = 'to_check_domain' where last_job_id = $1 and enrichment_stage in ('not_queued', 'to_read')`, [job.job_id]);
  const progress = { rows_found: added, loaded, companies_updated: applied?.n ?? 0, ...(stopped ? { stopped } : {}) };
  // fenced: a paused or cancelled job, or one another worker took, is not marked done
  await db.query(`update enrichment_jobs set status = 'done', finished_at = now(), progress = $3, claimed_by = null, claimed_until = null
    where job_id = $1 and claimed_by = $2 and status = 'running'`, [job.job_id, ctx.worker, progress]);
  return progress;
}

// ---- 1b. domain check: free DNS before any money (2026-11-03). A dead domain (no DNS, refused, parked, null MX, no
// MX, the mail host gone) ends here as dead_domain; anything else goes on to the website read. A live, non-gateway
// domain also gets its catch-all answer (one paid probe, cached 21 days), so the email step never pays for it again
export async function runDomainCheck(ctx, c) {
  if (!(await hold(ctx, 'companies', c.company_id))) return;
  const d = c.website_domain;
  if (!d) return write(ctx, 'companies', c.company_id, { enrichment_stage: 'to_read', stage_note: 'no website: the domain was not checked' });
  ctx.domains ??= makeDomainChecker({ db: ctx.db });
  const f = await ctx.domains.check(d);
  if (f.verdict === 'dead') return write(ctx, 'companies', c.company_id, { enrichment_stage: 'dead_domain', stage_note: `domain: ${f.reason}` });
  if (f.verdict === 'alive' && ctx.providers?.isCatchAll) {
    try { await ctx.domains.catchAll(d, { providers: ctx.providers, jobId: c.last_job_id }); }
    catch (e) { if (!(e instanceof SpendRefused)) throw e; }          // no money for the probe: the email step asks later
  }
  return write(ctx, 'companies', c.company_id, { enrichment_stage: 'to_read', stage_note: f.verdict === 'alive' ? null : `domain ${f.verdict}: ${f.reason}` });
}

// a fresh catch-all answer from the domain cache, or null (no table yet, no row, or out of date)
async function cachedCatchAll(db, domain) {
  try {
    const r = await db.one('select is_catch_all from email_domains where domain = $1 and catch_all_expires_at > now()', [domain]);
    return typeof r?.is_catch_all === 'boolean' ? r.is_catch_all : null;
  } catch { return null; }
}

// ---- 2. site read: the firm's own pages, the fit answers with quotes, owner names, every email printed ---------
const PAGES = ['', '/contact', '/contact-us', '/about', '/about-us'];

export async function runSiteRead(ctx, c) {
  const { db, providers } = ctx;
  if (!(await hold(ctx, 'companies', c.company_id))) return;
  const done = (stage, extra = {}) => write(ctx, 'companies', c.company_id, {
    enrichment_stage: stage, stage_note: extra.note ?? null, ...(extra.read ? { site_read: extra.read } : {}),
    ...(extra.status ? { status_code: extra.status } : {}) });
  if (!c.website) return done('needs_review', { note: 'no website to read' });
  const pages = [];
  for (const path of PAGES) {
    const page = await providers.fetchPage({ url: siteUrl(c.website, path), companyId: c.company_id, jobId: c.last_job_id });
    if (page?.text && !pages.some((x) => x.text === page.text)) pages.push({ path: path || '/', text: page.text });
    if (pages.length >= 5) break;
  }
  if (!pages.length) return done('needs_review', { note: 'the website could not be read' });
  const ind = c.industry_code ? await db.one('select name, description from industries where industry_code = $1', [c.industry_code]) : null;
  const industry = ind?.name ?? 'its industry';
  // the lean read: code keeps only the lines worth judging; the model sees those, or nothing at all
  const lean = leanExtract(pages);
  const codeOnly = !lean.ownerHits && !lean.chainHits && categoryMatches(c.google_category, ind);
  const read = codeOnly
    ? { answers: [{ key: 'is_target', answer: true, quote: null, by: 'google_category' }], owners: [] }
    : await providers.siteRead({ pages: lean.pieces, industry, companyName: c.company_name, companyId: c.company_id, jobId: c.last_job_id });
  // a quote that is not on the page is dropped; an owner counts only when the quote itself names them with an owner word
  const all = squash(pages.map((x) => x.text).join(' \n '));
  const onPage = (q) => Boolean(q) && squash(q).length >= 8 && all.includes(squash(q));
  const answers = (read.answers ?? []).filter((a) => a.by === 'google_category' || onPage(a.quote));
  const owners = (read.owners ?? []).filter((o) => o.name && onPage(o.quote) && quoteNames(o.quote, o.name)
    && /\b(owner|owners|owned by|founder|founded by|co-?founder|president|ceo|principal|proprietor|managing partner|run by)\b/i.test(o.quote));
  const emails = [];
  for (const pg of pages) for (const m of pg.text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const e = normEmail(m[0]);
    if (looksLikeEmail(e) && !emails.some((x) => x.email === e) && !/\.(png|jpe?g|gif|webp|svg)$/.test(e)) emails.push({ email: e, page: pg.path });
  }
  const fit = answers.find((a) => a.key === 'is_target')?.answer;
  const independent = answers.find((a) => a.key === 'is_independent')?.answer;
  const saved = { read_at: new Date().toISOString(), answers, owners, emails, pages: pages.map((x) => x.path),
    method: codeOnly ? 'code_only' : 'model', chars_sent: codeOnly ? 0 : lean.chars };
  // not a fit is a stage, not a permanent status: a person can look at the not_fit list and put a firm back
  if (fit === false || independent === false) return done('not_fit', { note: fit === false ? `the site says it is not ${industry}` : 'part of a group or chain', read: saved });
  if (fit !== true) return done('needs_review', { note: 'the site did not say clearly what the firm does', read: saved });
  return done('to_find_owner', { read: saved, status: c.status_code === 'new' ? 'researched' : undefined });
}

// the lines worth a model's time: the top of the home and about pages, and every window around an owner or chain word
const OWNER_WORDS = /\b(owner|owners|owned by|founder|founded by|co-?founder|president|ceo|principal|proprietor|managing partner|run by)\b/gi;
const CHAIN_WORDS = /\b(franchise|franchisee|franchising|subsidiary|a division of|part of the|member of the|locations nationwide|nationwide|corporate office|our locations|\d+ locations|independently owned and operated)\b/gi;
const HEAD = 1500, WINDOW = 160, MAX_WINDOWS = 8, MAX_CHARS = 6000;
export function leanExtract(pages) {
  const pieces = [];
  let ownerHits = 0, chainHits = 0;
  for (const pg of pages) {
    const text = String(pg.text ?? '');
    const keep = [];
    if (pg.path === '/' || /about/.test(pg.path)) keep.push([0, Math.min(HEAD, text.length)]);
    for (const [re, count] of [[OWNER_WORDS, 'o'], [CHAIN_WORDS, 'c']]) {
      let n = 0;
      for (const m of text.matchAll(re)) {
        if (count === 'o') ownerHits++; else chainHits++;
        if (n++ >= MAX_WINDOWS) continue;
        keep.push([Math.max(0, m.index - WINDOW), Math.min(text.length, m.index + m[0].length + WINDOW)]);
      }
    }
    // merge overlapping windows, so each piece is one exact stretch of the page (quotes stay checkable)
    keep.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const k of keep) { const last = merged.at(-1); if (last && k[0] <= last[1]) last[1] = Math.max(last[1], k[1]); else merged.push([...k]); }
    const part = merged.map(([a, b]) => text.slice(a, b).trim()).filter(Boolean).join('\n…\n');
    if (part) pieces.push({ path: pg.path, text: part });
  }
  let chars = 0;
  const capped = [];
  for (const p of pieces) { if (chars >= MAX_CHARS) break; const t = p.text.slice(0, MAX_CHARS - chars); chars += t.length; capped.push({ path: p.path, text: t }); }
  return { pieces: capped, ownerHits, chainHits, chars };
}

// a Google category that plainly names the trade ("Plumber" for Plumbing), and is not a supplier, school or the like
const NOT_THE_TRADE = /\b(supply|supplies|supplier|store|shop|wholesal\w*|distributor|manufacturer|school|association|agency for|rental|repair parts)\b/i;
const GENERIC = new Set(['commercial', 'residential', 'contractors', 'contractor', 'companies', 'company', 'services', 'service', 'systems', 'independent', 'reserve', 'vertical', 'collection', 'maintenance', 'grounds', 'anything', 'listed']);
export function categoryMatches(category, industry) {
  const cat = String(category ?? '').toLowerCase();
  if (!cat || !industry || NOT_THE_TRADE.test(cat)) return false;
  const words = `${industry.name ?? ''} ${industry.description ?? ''}`.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const stems = [...new Set(words.filter((w) => !GENERIC.has(w)).map((w) => w.slice(0, 5)))];
  const catWords = cat.match(/[a-z]{4,}/g) ?? [];
  return stems.some((s) => catWords.some((w) => w.startsWith(s)));
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const quoteNames = (quote, name) => { const n = splitName(name); return Boolean(n?.last) && normName(quote).includes(n.last) && normName(quote).includes(n.first); };
function siteUrl(website, path) {
  const base = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  try { const u = new URL(base); return `${u.origin}${path}`; } catch { return base; }
}

// ---- 3. owner: candidates from every source until two agree; one person row, waiting for approval ---------------
export async function runOwner(ctx, c) {
  const { db, providers } = ctx;
  if (!(await hold(ctx, 'companies', c.company_id))) return;
  const read = c.site_read ?? {};
  const candidates = (read.owners ?? []).map((o) => ({ name: o.name, title: o.title ?? null, source: 'website', url: c.website, quote: o.quote }));
  // people an uploaded list already named at this firm are candidates too (one source each, never confirmed alone)
  const listed = await db.query(`select first_name, last_name, owner_sources from people
    where company_id = $1 and enrichment_stage in ('not_queued', 'awaiting_approval') and jsonb_array_length(coalesce(owner_sources, '[]'::jsonb)) > 0`, [c.company_id]);
  for (const p of listed) for (const s of p.owner_sources) {
    if (s.source !== 'website') candidates.push({ ...s, name: [p.first_name, p.last_name].filter(Boolean).join(' ') });
  }
  // cheapest first: Leadocean (inside the deal), a web search (a tenth of a cent), BlitzAPI, then Apollo (a credit per match)
  for (const source of ['leadocean', 'web_search', 'blitzapi', 'apollo']) {
    if (decideOwner(candidates).confirmed) break;
    try {
      const found = await providers.owners({ source, company: c, city: c.city, state: c.state_code ?? '', companyId: c.company_id, jobId: c.last_job_id });
      for (const f of found ?? []) if (f?.name) candidates.push({ ...f, source });
    } catch (e) { if (!(e instanceof SpendRefused)) throw e; break; }
  }
  const d = decideOwner(candidates);
  if (!d.owner) {
    return write(ctx, 'companies', c.company_id, { enrichment_stage: 'no_owner_found', stage_note: candidates.length ? 'names found, none with an owner title' : 'no owner name found' });
  }
  // "Dr. Jane Smith Jr." is stored as Jane Smith; the spelling of the name is kept, only titles and suffixes go
  const words = d.owner.name.replace(/\b(mr|mrs|ms|dr|jr|sr|ii|iii|iv|phd|md|esq|cpa|pe)\.?(?=\s|$)/gi, ' ').trim().split(/\s+/).filter(Boolean);
  const first = cap(words[0]), last = words.length > 1 ? words.slice(1).map(cap).join(' ') : null;
  // each source keeps what a later step needs: the email Apollo's match already returned, Leadocean's person id, the profile
  const sources = d.owner.sources.map((s) => ({ source: s.source, url: s.url ?? null, quote: s.quote ? String(s.quote).slice(0, 300) : null, title: s.title ?? null,
    ...(s.linkedin ? { linkedin: s.linkedin } : {}), ...(s.leadoceanId ? { leadoceanId: s.leadoceanId } : {}),
    ...(s.apolloEmail ? { apolloEmail: s.apolloEmail, apolloEmailStatus: s.apolloEmailStatus ?? null } : {}) }));
  const note = [d.confirmed ? null : 'not confirmed by two independent sources', d.disagreement ? 'another name was also put forward' : null].filter(Boolean).join('; ') || null;
  const linkedin = d.owner.sources.find((s) => s.linkedin)?.linkedin ?? null;
  const title = d.owner.sources.map((s) => s.title).find((t) => t && ownerRole(t)) ?? null;
  const existing = await db.one(`select person_id, owner_sources, owner_confirmed from people where company_id = $1 and lower(first_name) = $2 and lower(coalesce(last_name,'')) = $3`,
    [c.company_id, first.toLowerCase(), (last ?? '').toLowerCase()]);
  if (existing) {
    // sources are added, never replaced; a confirmed owner never becomes unconfirmed
    const merged = [...(existing.owner_sources ?? [])];
    for (const s of sources) if (!merged.some((m) => m.source === s.source && m.url === s.url)) merged.push(s);
    // a person waiting outside the pipeline (from a list, or queued by hand) now waits for a person's approval
    await db.query(`update people set owner_sources = $2, owner_confirmed = owner_confirmed or $3, role = coalesce(role, $4), designation = coalesce(designation, $5),
        linkedin_url = coalesce(linkedin_url, $6), stage_note = $7, last_job_id = coalesce(last_job_id, $8),
        enrichment_stage = case when enrichment_stage = 'not_queued' then 'awaiting_approval' else enrichment_stage end
      where person_id = $1 and enrichment_stage in ('awaiting_approval', 'needs_review', 'not_queued')`,
      [existing.person_id, JSON.stringify(merged), d.confirmed, d.owner.role, title, linkedin, note, c.last_job_id]);
  } else {
    try {
      await db.query(`insert into people (company_id, first_name, last_name, designation, role, owner_sources, owner_confirmed, enrichment_stage, stage_note,
          linkedin_url, source, last_job_id) values ($1,$2,$3,$4,$5,$6,$7,'awaiting_approval',$8,$9,'enrichment',$10)`,
        [c.company_id, first, last, title, d.owner.role, JSON.stringify(sources), d.confirmed, note, linkedin, c.last_job_id]);
    } catch (e) {
      if (e.code !== '23505') throw e;   // the same person from another worker or another profile: the unique index kept one row
    }
  }
  return write(ctx, 'companies', c.company_id, { enrichment_stage: 'owners_found', stage_note: note });
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---- 5. email: provider lane, then own-site lane, then the verified-pattern lane (D9-1, D9-2) ---------------------
export async function runEmail(ctx, p) {
  const { db, providers } = ctx;
  if (!(await hold(ctx, 'people', p.person_id))) return;
  // an email already there (typed by a person, or found before) is never replaced: it goes to verification
  if (p.email) return write(ctx, 'people', p.person_id, { enrichment_stage: 'to_verify', stage_note: 'kept the email already on the row' });
  const c = await db.one('select * from companies where company_id = $1', [p.company_id]);
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
  const domain = c.website_domain;
  const set = (fields, stage, note = null) => write(ctx, 'people', p.person_id, { ...fields, enrichment_stage: stage, stage_note: note });
  const taken = async (email) => Boolean(await db.one('select 1 from people where email = $1 and person_id <> $2', [email, p.person_id]));
  const meta = { personId: p.person_id, jobId: p.last_job_id };
  const waiting = (e) => set({}, 'to_find_email', `waiting: ${e.message}`);

  // a. providers: only an address on the company's own domain, never guessed, never personal, never a role address
  if (domain) {
    for (const source of ['apollo', 'leadocean', 'kitt', 'tomba']) {
      let r;
      try { r = await providers.findEmail({ source, name, first: p.first_name, last: p.last_name, domain, company: c, person: p, ...meta }); }
      catch (e) { if (e instanceof SpendRefused) return waiting(e); throw e; }
      const email = normEmail(r?.email);
      if (!email || !looksLikeEmail(email) || r.generated || isFreemail(email) || isRoleAddress(email) || email.split('@')[1] !== domain) continue;
      if (await taken(email)) return set({}, 'needs_review', `${email} already belongs to another person`);
      return set({ email, email_method: 'provider', email_lane: 'main', email_provider: source, email_source: `${source}${r.ref ? ': ' + r.ref : ''}`, email_is_freemail: false }, 'to_verify');
    }
  }
  // b. an address the firm's own site prints for the owner or the business
  const namedOnSite = (p.owner_sources ?? []).some((s) => s.source === 'website');
  const own = ownSiteEmailFor(name, domain, c.site_read?.emails ?? [], { ownerNamedOnSite: namedOnSite });
  if (own && !(await taken(own.email))) {
    return set({ email: own.email, email_method: 'own_site', email_lane: 'verified', email_provider: 'website', email_source: `website: ${own.why}`, email_is_freemail: own.freemail }, 'to_verify');
  }
  // c. the verified-pattern lane: never on a catch-all domain; the first pattern verifier A calls valid
  const list = patterns(name, domain);
  if (!list.length) return set({}, 'no_email', domain ? 'no surname for patterns' : 'no company domain');
  let catchAll = await cachedCatchAll(db, domain);
  if (catchAll === null) {
    try { catchAll = await providers.isCatchAll({ domain, ...meta }); } catch (e) { if (e instanceof SpendRefused) return waiting(e); throw e; }
  }
  if (catchAll === true) return set({ email_catch_all: true }, 'needs_review', 'catch-all domain: patterns cannot be checked');
  if (catchAll !== false) return set({}, 'needs_review', 'could not tell whether the domain is catch-all');
  for (const email of list) {
    if (await taken(email)) continue;
    let a;
    try { a = await providers.verify({ which: 'a', email, ...meta }); } catch (e) { if (e instanceof SpendRefused) return waiting(e); throw e; }
    const v = verdict(a?.result);
    if (v === 'catch_all') return set({ email_catch_all: true }, 'needs_review', 'catch-all domain: patterns cannot be checked');
    if (v === 'valid') {
      return set({ email, email_method: 'pattern', email_lane: 'verified', email_provider: 'pattern', email_source: `pattern ${list.indexOf(email) + 1} of ${list.length}`,
        email_is_freemail: false, email_catch_all: false, verifier_a: JSON.stringify({ tool: a.tool, result: a.result, at: new Date().toISOString() }) }, 'to_verify');
    }
  }
  return set({ email_catch_all: false }, 'no_email', `none of ${list.length} patterns verified`);
}

// ---- 6. verify: two independent verifiers must both say valid; catch-all leaves the lanes ----------------------------
export async function runVerify(ctx, p) {
  const { providers } = ctx;
  if (!(await hold(ctx, 'people', p.person_id))) return;
  const now = () => new Date().toISOString();
  const meta = { personId: p.person_id, jobId: p.last_job_id };
  let a, b;
  try {
    a = p.verifier_a?.result ? p.verifier_a : await providers.verify({ which: 'a', email: p.email, ...meta }).then((r) => ({ tool: r.tool, result: r.result, at: now() }));
    // the second (dearer) check only runs when the first said valid: a no from either is already a no
    if (verdict(a.result) === 'valid') {
      const rb = await providers.verify({ which: 'b', email: p.email, ...meta });
      b = { tool: rb.tool, result: rb.result, at: now() };
    } else b = { tool: null, result: 'skipped', at: now() };
  } catch (e) {
    if (e instanceof SpendRefused) return write(ctx, 'people', p.person_id, { stage_note: `waiting: ${e.message}` });
    throw e;
  }
  const va = verdict(a.result), vb = verdict(b.result);
  const ev = { verifier_a: JSON.stringify(a), verifier_b: JSON.stringify(b) };
  if (va === 'valid' && vb === 'valid') {
    // a person marked do_not_contact keeps that status; only the evidence is written
    const dnc = p.status_code === 'do_not_contact';
    return write(ctx, 'people', p.person_id, { ...ev, email_catch_all: false, email_checked_at: new Date().toISOString().slice(0, 10),
      ...(dnc ? {} : { status_code: 'verified' }), enrichment_stage: 'verified', stage_note: dnc ? 'verified, but do not contact' : null });
  }
  if (va === 'catch_all' || vb === 'catch_all') return write(ctx, 'people', p.person_id, { ...ev, email_catch_all: true, enrichment_stage: 'needs_review', stage_note: 'catch-all domain: not sent in either lane' });
  if (va === 'invalid' || vb === 'invalid') {
    // a found address that fails is dropped (never sent); one a person typed is kept for a person to look at
    if (p.email_method === 'manual' || !p.email_method) return write(ctx, 'people', p.person_id, { ...ev, enrichment_stage: 'needs_review', stage_note: `${p.email} failed verification` });
    return write(ctx, 'people', p.person_id, { ...ev, enrichment_stage: 'no_email', stage_note: `${p.email} failed verification`, email: null, email_method: null, email_lane: null, email_is_freemail: null });
  }
  return write(ctx, 'people', p.person_id, { ...ev, enrichment_stage: 'needs_review', stage_note: 'the verifiers could not decide' });
}
