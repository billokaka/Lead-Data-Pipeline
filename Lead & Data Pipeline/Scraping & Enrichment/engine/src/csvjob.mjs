// csvjob.mjs: "enrich this list". planList() reads the database only and says what each row needs and what it should
// cost; importList() writes the rows (after the person said yes) and queues only the work that is not done yet.
// A row already worked is never paid for twice; an uploaded list is one owner source, so a second one is still found.

import { normEmail, looksLikeEmail, isFreemail, isRoleAddress, ownerRole } from './rules.mjs';

// [assumed] per-step dollars until the 40-firm run gives real ones; "max" is every paid tool in the chain running
export const RATES = {
  site: { exp: 0.0026, max: 0.0048 },                 // 3 page reads + the lean model call (skipped on some sites)
  owner: { exp: 0.002, max: 0.003 },                  // Leadocean free, a web search, BlitzAPI; Apollo's credit is added below
  email: { exp: 0.0067, max: 0.0301 },                // Kitt (paid only when found), Tomba, then the catch-all probe and 8 patterns
  verify: { exp: 0.0089, max: 0.0107 },               // MillionVerifier, then Tomba only when the first said valid
  ownerFoundShare: 0.6,                               // companies with no listed owner that end with one
};
export const TOOL_KIND = { apollo: 'apollo', lemlist: 'lemlist', sales_navigator: 'sales_navigator', leadocean: 'leadocean', google_maps: 'csv', other: 'csv' };

// a listed email is kept only when it could be a provider email: the firm's own domain, not personal, not a role address
function listEmail(row, domainOf) {
  const e = normEmail(row.email);
  if (!e) return { email: null };
  if (!looksLikeEmail(e)) return { email: null, why: 'not an email' };
  if (isFreemail(e)) return { email: null, why: 'a personal address (allowed only from the firm\'s own site)' };
  if (isRoleAddress(e)) return { email: null, why: 'a role address' };
  const site = domainOf(row.website);
  if (site && e.split('@')[1] !== site) return { email: null, why: 'not on the firm\'s own domain' };
  return { email: e };
}

export async function planList(db, list, { domainOf, apolloCreditUsd = 0.01 }) {
  const rows = list.rows.map((r, i) => ({ ...r, n: i + 2 }));   // n = the line in the file
  const skipped = [];
  const usable = [];
  for (const r of rows) {
    if (!r.company_name && !r.website && !(r.email && !isFreemail(normEmail(r.email) ?? ''))) { skipped.push({ n: r.n, why: 'no company, website or work email' }); continue; }
    const name = r.full_name ?? [r.first_name, r.last_name].filter(Boolean).join(' ');
    const role = list.hasPeople && name ? ownerRole(r.designation ?? '') : null;
    const em = listEmail(r, domainOf);
    usable.push({ ...r, name: name || null, role, email: em.email, emailDropped: em.why ?? null });
  }
  const domains = [...new Set(usable.map((r) => domainOf(r.website) ?? (r.email ? r.email.split('@')[1] : null)).filter(Boolean))];
  const known = new Map((await db.query(`select website_domain, enrichment_stage, state_code from companies where website_domain = any($1)`, [domains]))
    .map((c) => [c.website_domain, c]));
  const emails = usable.map((r) => r.email).filter(Boolean);
  const people = new Map((await db.query(`select email, status_code, enrichment_stage, email_checked_at >= current_date - 90 as recent from people where email = any($1)`, [emails]))
    .map((p) => [p.email, p]));
  const hold = new Set((await db.query('select state_code from us_states where is_on_hold')).map((s) => s.state_code));

  const firms = new Map();     // one entry per company the list names
  const count = { rows: rows.length, skipped: skipped.length, not_owner: 0, emails_dropped: 0, already_done: 0, in_hold_state: 0 };
  for (const r of usable) {
    const d = domainOf(r.website) ?? (r.email ? r.email.split('@')[1] : null);
    const k = d ?? `${(r.company_name ?? '').toLowerCase()}|${(r.city ?? '').toLowerCase()}`;
    const f = firms.get(k) ?? { known: d ? known.get(d) : null, owners: 0, ownersNoEmail: 0, toVerify: 0, state: r.state };
    if (r.emailDropped) count.emails_dropped++;
    if (list.hasPeople && r.name && !r.role) count.not_owner++;
    if (r.role) {
      const p = r.email ? people.get(r.email) : null;
      if (p && (p.status_code === 'do_not_contact' || (p.enrichment_stage === 'verified' && p.recent))) count.already_done++;
      else { f.owners++; if (r.email) f.toVerify++; else f.ownersNoEmail++; }
    }
    firms.set(k, f);
  }
  let work = 0, done = 0, holdN = 0, toVerify = 0, ownersNoEmail = 0, firmsNoOwner = 0;
  for (const f of firms.values()) {
    const stage = f.known?.enrichment_stage;
    const state = f.known?.state_code ?? (f.state ? String(f.state).trim().toUpperCase().slice(0, 2) : null);
    if (state && hold.has(state)) { holdN++; continue; }
    // a firm already past the website and owner steps is not worked again; one where no owner was found is, if the list names one
    if (stage && !['not_queued', 'to_read'].includes(stage) && !(stage === 'no_owner_found' && f.owners)) { done++; toVerify += f.toVerify; ownersNoEmail += f.ownersNoEmail; continue; }
    work++; toVerify += f.toVerify; ownersNoEmail += f.ownersNoEmail;
    if (!f.owners) firmsNoOwner++;
  }
  count.in_hold_state = holdN;
  const ownerRate = { exp: RATES.owner.exp + 0.3 * apolloCreditUsd, max: RATES.owner.max + apolloCreditUsd };
  const foundOwners = firmsNoOwner * RATES.ownerFoundShare;
  const expected = work * (RATES.site.exp + ownerRate.exp) + (ownersNoEmail + foundOwners) * (RATES.email.exp + 0.6 * RATES.verify.exp) + toVerify * RATES.verify.exp;
  const max = work * (RATES.site.max + ownerRate.max) + (ownersNoEmail + firmsNoOwner) * (RATES.email.max + RATES.verify.max) + toVerify * RATES.verify.max;
  return {
    usable, skipped,
    count: { ...count, firms: firms.size, firms_to_work: work, firms_already_worked: done, owners_to_find_email: ownersNoEmail, emails_to_verify: toVerify, firms_without_listed_owner: firmsNoOwner },
    expectedUsd: Math.round(expected * 100) / 100,
    suggestedCapUsd: Math.max(0.5, Math.ceil(max * 100) / 100),
  };
}

export async function importList(db, plan, { jobId, tool, industryCode, person }) {
  const kind = TOOL_KIND[tool] ?? 'csv';
  const companyIds = new Set();
  const personIds = [];
  const others = [];
  const ids = [];
  for (const r of plan.usable) {
    if (r.name || r.email) {
      const row = await db.one(`insert into import_people (source_tool, first_name, last_name, full_name, designation, email, linkedin_url, company_name, company_website,
          company_industry, company_location, company_city, company_state, company_phone, company_linkedin_url, notes)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning import_id`,
        [tool, r.first_name, r.last_name, r.first_name || r.last_name ? null : r.full_name, r.designation, r.email, r.person_linkedin, r.company_name, r.website,
          r.industry, r.location, r.city, r.state, r.company_phone, r.company_linkedin, `list job ${jobId}`]);
      ids.push({ table: 'import_people', id: row.import_id, r });
    } else {
      const row = await db.one(`insert into import_companies (source_tool, company_name, website, industry, location, city, state, phone, linkedin_url, job_id, notes)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning import_id`,
        [tool, r.company_name, r.website, r.industry, r.location, r.city, r.state, r.company_phone, r.company_linkedin, jobId, `list job ${jobId}`]);
      ids.push({ table: 'import_companies', id: row.import_id, r });
    }
  }
  const loaded = await db.query('select * from load_imports_locked($1)', [tool]);
  const result = { added: 0, merged: 0, needs_review: 0, owners_listed: 0 };
  for (const x of ids) {
    const got = await db.one(`select import_status, company_id${x.table === 'import_people' ? ', person_id' : ''} from ${x.table} where import_id = $1`, [x.id]);
    if (!got) continue;
    result[got.import_status] = (result[got.import_status] ?? 0) + 1;
    if (got.company_id) companyIds.add(got.company_id);
    if (got.person_id && x.r.role) personIds.push({ id: got.person_id, r: x.r });
    else if (got.person_id) others.push(got.person_id);
  }
  // a listed person who is not an owner by title stays out of the pipeline (D6-1), never in the approval list
  if (others.length) await db.query(`update people set enrichment_stage = 'not_queued', stage_note = 'from a list; not an owner by title'
    where person_id = any($1) and enrichment_stage = 'awaiting_approval' and role is null and not owner_confirmed`, [others]);
  // the listed owners: one source each, their role, and a listed email marked as a provider email (main lane).
  // An unconfirmed one waits outside the approval list until the owner step finds a second source
  for (const { id, r } of personIds) {
    const src = { source: kind, title: r.designation ?? null, url: null, quote: null, ...(r.person_linkedin ? { linkedin: r.person_linkedin } : {}) };
    const n = await db.query(`update people set role = coalesce(role, $2), designation = coalesce(designation, $3), last_job_id = $4,
        owner_sources = case when coalesce(owner_sources, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('source', $5::text)) then owner_sources
                             else coalesce(owner_sources, '[]'::jsonb) || jsonb_build_array($6::jsonb) end,
        email_method = case when email is not null and email = $7 and email_method is null then 'provider' else email_method end,
        email_lane = case when email is not null and email = $7 and email_method is null then 'main' else email_lane end,
        email_provider = case when email is not null and email = $7 and email_method is null then $5 else email_provider end,
        email_is_freemail = case when email is not null and email = $7 and email_method is null then false else email_is_freemail end,
        enrichment_stage = case when owner_confirmed then enrichment_stage else 'not_queued' end
      where person_id = $1 and enrichment_stage in ('not_queued', 'awaiting_approval') and status_code <> 'do_not_contact'
        returning person_id`,
      [id, r.role, r.designation, jobId, kind, JSON.stringify(src), r.email]);
    if (n.length) result.owners_listed++;
  }
  // queue only what is not done: a new firm starts at the website step; one where no owner was found goes back to the owner step
  const q = await db.query(`update companies c set last_job_id = $2, industry_code = coalesce(c.industry_code, $3),
      enrichment_stage = case when c.enrichment_stage = 'not_queued' then 'to_read' else 'to_find_owner' end, stage_note = null
    where c.company_id = any($1) and (c.enrichment_stage = 'not_queued'
      or (c.enrichment_stage = 'no_owner_found' and exists (select 1 from people p where p.company_id = c.company_id and p.last_job_id = $2)))
    returning company_id`, [[...companyIds], jobId, industryCode]);
  result.firms_queued = q.length;
  result.loaded = loaded;
  result.by = person;
  return result;
}
