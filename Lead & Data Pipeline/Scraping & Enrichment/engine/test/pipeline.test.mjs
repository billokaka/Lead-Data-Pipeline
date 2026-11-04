// The whole pipeline on a made-up town, with fake providers, on PGlite running the real SQL
// (workflows/blueprints v1.1 + v1.2 combined, then sql/v1.3). Nothing reaches a real service.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { fromPglite } from '../src/db.mjs';
import { makeSpender } from '../src/money.mjs';
import { runUntilIdle, decideOwners, runOnce } from '../src/worker.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_BASE = join(here, '..', '..', 'sql', 'icp-database-v1-run-in-supabase.sql');
const SQL_V13 = join(here, '..', '..', 'sql', 'v1.3-enrichment.sql');

// ---- the made-up town ------------------------------------------------------------------------------------
const SHOPS = [
  { name: 'Ace Plumbing', website: 'aceplumb.com', address: '1 Main St, Worcester, MA 01608', placeId: 'p1',
    page: 'Ace Plumbing serves Worcester. A family plumbing company. Owner Joe Ruiz has 20 years experience. Call info@aceplumb.com' },
  { name: "Bob's Plumbing", website: 'bobplumb.com', address: '2 Elm St, Worcester, MA 01608', placeId: 'p2',
    page: "Bob's Plumbing is an independent plumbing company. Founded by Bob Lee in 1998. Email boblee1998@gmail.com for a quote." },
  { name: 'Cal Plumbing', website: 'calplumb.com', address: '3 Oak St, Worcester, MA 01608', placeId: 'p3',
    page: 'Cal Plumbing, a local independent plumbing company run by its owner Cal Diaz.' },
  { name: 'Dan Plumbing', website: 'danplumb.com', address: '4 Pine St, Worcester, MA 01608', placeId: 'p4',
    page: 'Dan Plumbing is a local plumbing company. Owner Dan Fox.' },
  { name: 'Eve Plumbing Group', website: 'eveplumb.com', address: '5 Ash St, Worcester, MA 01608', placeId: 'p5',
    page: 'Eve Plumbing Group is a national franchise of plumbing companies with 300 locations.' },
  { name: 'Fay Plumbing', website: null, address: '6 Birch St, Worcester, MA 01608', placeId: 'p6', page: null },
];
const WEB_OWNERS = { 'Ace Plumbing': 'Joe Ruiz', "Bob's Plumbing": 'Bob Lee', 'Dan Plumbing': 'Dan Fox' };
const APOLLO_OWNERS = { 'calplumb.com': { name: 'Cal Diaz', title: 'Owner' } };
const PROVIDER_EMAILS = { 'aceplumb.com': { email: 'joe.ruiz@aceplumb.com' }, 'calplumb.com': { email: 'cal@calplumb.com', generated: true } };
const CATCH_ALL = new Set(['danplumb.com']);
const LIVE = new Set(['joe.ruiz@aceplumb.com', 'boblee1998@gmail.com', 'cdiaz@calplumb.com']);

function fakeProviders(paid) {
  const cost = (provider, step, usd, fn) => (args) => paid({ provider, step, estUsd: usd, jobId: args.jobId, companyId: args.companyId, personId: args.personId }, () => fn(args));
  return {
    maps: cost('treg', 'maps', 0.01, ({ place }) => ({ result: { items: place === 'Worcester, MA' ? SHOPS : [], more: false } })),
    companies: async () => ({ items: [] }),
    fetchPage: async ({ url }) => {
      const shop = SHOPS.find((s) => s.website && url.includes(s.website));
      return shop && url.endsWith(shop.website) ? { text: shop.page } : null;   // only the home page exists
    },
    siteRead: cost('openrouter', 'site_read', 0.002, ({ pages, companyName }) => {
      const t = pages.map((p) => p.text).join(' ');
      const owner = t.match(/(?:Owner|Founded by|owner) ([A-Z][a-z]+ [A-Z][a-z]+)/);
      return { result: {
        answers: [
          { key: 'is_target', answer: /plumbing compan/i.test(t), quote: (t.match(/[^.]*plumbing compan[^.]*/i) ?? [''])[0] },
          { key: 'is_independent', answer: !/franchise/i.test(t), quote: (t.match(/[^.]*(independent|franchise|local|family)[^.]*/i) ?? [''])[0] },
          { key: 'made_up', answer: true, quote: 'a sentence that is not on the page' },
        ],
        owners: owner ? [{ name: owner[1], title: 'Owner', quote: owner[0] }] : [],
      } };
    }),
    owners: cost('treg', 'owner', 0.005, ({ source, company }) => {
      if (source === 'web_search' && WEB_OWNERS[company.company_name]) return { result: [{ name: WEB_OWNERS[company.company_name], title: 'Owner', url: 'https://search.example' }] };
      if (source === 'apollo' && APOLLO_OWNERS[company.website_domain]) return { result: [APOLLO_OWNERS[company.website_domain]] };
      return { result: [] };
    }),
    findEmail: cost('treg', 'email_find', 0.005, ({ source, domain }) => ({ result: source === 'leadocean' ? (PROVIDER_EMAILS[domain] ?? null) : null })),
    isCatchAll: cost('treg', 'catch_all', 0.002, ({ domain }) => ({ result: CATCH_ALL.has(domain) })),
    verify: cost('treg', 'verify', 0.002, ({ which, email }) => ({ result: { tool: which === 'a' ? 'tomba' : 'millionverifier',
      result: CATCH_ALL.has(email.split('@')[1]) ? 'catch_all' : LIVE.has(email) ? 'valid' : 'invalid' } })),
  };
}

let db, ctx;
before(async () => {
  const pg = new PGlite();
  await pg.exec('create role anon; create role authenticated;');
  await pg.exec(readFileSync(SQL_BASE, 'utf8'));
  await pg.exec(readFileSync(SQL_V13, 'utf8'));
  await pg.exec(readFileSync(join(here, '..', '..', 'sql', 'v1.4-domains.sql'), 'utf8'));
  db = fromPglite(pg);
  const config = { person: 'Tester', batch: 25, allowSpend: true, secrets: () => [] };
  const paid = makeSpender({ db, config });
  // the made-up town's domains all take mail: a fake DNS (the real one would call them dead), cached in the real table
  const { makeDomainChecker } = await import('../src/domaincheck.mjs');
  const fakeQuery = async (type, name) => (type === 'MX' ? { code: 'ok', answers: [{ exchange: 'aspmx.l.google.com', priority: 1 }] } : type === 'A' ? { code: 'ok', answers: ['1.2.3.4'] } : { code: 'nodata', answers: [] });
  ctx = { db, config, providers: fakeProviders(paid), log: () => {}, redact: (s) => s, domains: makeDomainChecker({ db, query: fakeQuery, withAge: false }) };
  await db.query(`update budgets set daily_usd = 100 where provider = 'total'`);
  // a shop in a hold state, already in the table: it must never be worked
  await db.query(`insert into companies (company_name, website, state_code, industry_code) values ('Gus Plumbing','gusplumb.com','CA','plumbing')`);
});

test('a sourcing job fills the town, reads the sites, finds the owners, and stops at approval', async () => {
  await db.query(`insert into enrichment_jobs (kind, industry_code, params, requested_by, max_cost_usd)
    values ('source','plumbing','{"sources":["google_maps"],"places":["Worcester, MA"],"queries":["plumber"],"max_companies":50}','Tester',5)`);
  const r = await runUntilIdle(ctx, { minutes: 1 });
  assert.equal(r.errors, 0);
  const stage = async (name) => (await db.one('select enrichment_stage, status_code, stage_note, site_read from companies where company_name = $1', [name]));
  assert.equal((await stage('Ace Plumbing')).enrichment_stage, 'owners_found');
  assert.equal((await stage('Eve Plumbing Group')).enrichment_stage, 'not_fit');
  assert.equal((await stage('Eve Plumbing Group')).status_code, 'new', 'not a fit is a stage a person can undo, not a permanent status');
  assert.equal((await stage('Fay Plumbing')).enrichment_stage, 'needs_review');
  assert.equal((await stage('Gus Plumbing')).enrichment_stage, 'to_read', 'the hold-state shop was never touched');
  const ace = await stage('Ace Plumbing');
  assert.ok(!ace.site_read.answers.some((a) => a.key === 'made_up'), 'a quote not on the page is dropped');
  assert.deepEqual(ace.site_read.emails.map((e) => e.email), ['info@aceplumb.com']);
  const people = await db.query('select first_name, last_name, enrichment_stage, owner_confirmed from people order by first_name');
  assert.deepEqual(people.map((p) => [p.first_name, p.owner_confirmed, p.enrichment_stage]), [
    ['Bob', true, 'awaiting_approval'], ['Cal', true, 'awaiting_approval'], ['Dan', true, 'awaiting_approval'], ['Joe', true, 'awaiting_approval']]);
  const rows = await db.one(`select count(*)::int n from people where enrichment_stage = 'to_find_email'`);
  assert.equal(rows.n, 0, 'nothing spends email credits before approval');
});

test('after approval: provider lane, own-site lane, pattern lane, catch-all held back', async () => {
  const ids = (await db.query(`select person_id from people where enrichment_stage = 'awaiting_approval'`)).map((x) => x.person_id);
  const d = await decideOwners(db, { personIds: ids, decision: 'approve', by: 'Tester' });
  assert.equal(d.changed, 4);
  await runUntilIdle(ctx, { minutes: 1 });
  const p = async (first) => db.one('select email, email_method, email_lane, email_is_freemail, enrichment_stage, status_code, email_catch_all, stage_note from people where first_name = $1', [first]);
  const joe = await p('Joe');
  assert.deepEqual([joe.email, joe.email_method, joe.email_lane, joe.enrichment_stage], ['joe.ruiz@aceplumb.com', 'provider', 'main', 'verified']);
  const bob = await p('Bob');
  assert.deepEqual([bob.email, bob.email_method, bob.email_lane, bob.email_is_freemail, bob.enrichment_stage], ['boblee1998@gmail.com', 'own_site', 'verified', true, 'verified']);
  const cal = await p('Cal');
  assert.deepEqual([cal.email, cal.email_method, cal.email_lane, cal.enrichment_stage], ['cdiaz@calplumb.com', 'pattern', 'verified', 'verified'],
    'the provider\'s generated address was refused; the pattern was verified twice');
  const dan = await p('Dan');
  assert.deepEqual([dan.email, dan.email_catch_all, dan.enrichment_stage], [null, true, 'needs_review'], 'no pattern on a catch-all domain');

  const main = (await db.query('select email from outreach_ready_people')).map((x) => x.email);
  const verified = (await db.query('select email from outreach_ready_verified_lane order by email')).map((x) => x.email);
  assert.deepEqual(main, ['joe.ruiz@aceplumb.com']);
  assert.deepEqual(verified, ['boblee1998@gmail.com', 'cdiaz@calplumb.com']);
  const byIndustry = await db.one(`select count(*)::int n from people_directory where industry = 'Plumbing' and status = 'Verified'`);
  assert.equal(byIndustry.n, 3, 'searchable by industry');
});

test('every paid call is logged with the person and the job; the job carries its cost', async () => {
  const c = await db.one(`select count(*)::int n, count(*) filter (where requested_by = 'Tester')::int mine, sum(usd)::float usd from costs`);
  assert.ok(c.n > 10 && c.mine === c.n);
  const job = await db.one('select status, cost_usd::float cost, progress from enrichment_jobs order by job_id limit 1');
  assert.equal(job.status, 'done');
  assert.ok(job.cost > 0);
  assert.equal(job.progress.rows_found, 6);
});

test('budgets stop paid calls, and the rows wait instead of failing', async () => {
  SHOPS.push({ name: 'Hal Plumbing', website: 'halplumb.com', page: 'Hal Plumbing is a local plumbing company. Owner Hal Moe.' });
  await db.query(`insert into companies (company_name, website, city, state_code, industry_code) values ('Hal Plumbing','halplumb.com','Worcester','MA','plumbing')`);
  await db.query(`update budgets set daily_usd = 0 where provider = 'total'`);
  const before = await db.one('select count(*)::int n from costs');
  await runOnce(ctx);
  const after = await db.one('select count(*)::int n from costs');
  assert.equal(after.n, before.n, 'no paid call went out');
  const hal = await db.one(`select enrichment_stage, stage_note from companies where company_name = 'Hal Plumbing'`);
  assert.equal(hal.enrichment_stage, 'to_read');
  assert.match(hal.stage_note, /budget/);
  await db.query(`update budgets set daily_usd = 100 where provider = 'total'`);
});

test('the pause switch stops every engine', async () => {
  await db.query(`update flags set value = true, set_by = 'Tester', reason = 'test' where name = 'enrichment_paused'`);
  const r = await runOnce(ctx);
  assert.equal(r.paused, true);
  await db.query(`update flags set value = false, set_by = 'Tester', reason = 'test' where name = 'enrichment_paused'`);
});

test('a one-source owner is not approved unless the person checked them', async () => {
  const co = await db.one(`insert into companies (company_name, website, state_code, industry_code, enrichment_stage) values ('Ivy Plumbing','ivyplumb.com','MA','plumbing','owners_found') returning company_id`);
  const p = await db.one(`insert into people (company_id, first_name, last_name, role, owner_sources, owner_confirmed) values ($1,'Ivy','Lane','owner','[{"source":"web_search"}]',false) returning person_id`, [co.company_id]);
  const a = await decideOwners(db, { personIds: [p.person_id], decision: 'approve', by: 'Tester' });
  assert.equal(a.changed, 0);
  assert.deepEqual(a.not_approved_one_source, [p.person_id]);
  const b = await decideOwners(db, { personIds: [p.person_id], decision: 'approve', by: 'Tester', checkedOwnerIds: [p.person_id] });
  assert.equal(b.changed, 1);
  const row = await db.one('select owner_confirmed, owner_sources, enrichment_stage from people where person_id = $1', [p.person_id]);
  assert.equal(row.owner_confirmed, true);
  assert.equal(row.owner_sources.at(-1).source, 'manual');
});
