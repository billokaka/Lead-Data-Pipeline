// "Enrich this list" (2026-10-29): the CSV reader, the plan (what each row needs, nothing paid twice), the import,
// a listed owner counted as one source only, and the cheapest-first order.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { fromPglite } from '../src/db.mjs';
import { runOnce } from '../src/worker.mjs';
import { parseCsv, readList, domainOf } from '../src/csv.mjs';
import { planList, importList } from '../src/csvjob.mjs';

const here = dirname(fileURLToPath(import.meta.url));
async function freshDb() {
  const pg = new PGlite();
  await pg.exec('create role anon; create role authenticated;');
  await pg.exec(readFileSync(join(here, '..', '..', 'sql', 'icp-database-v1-run-in-supabase.sql'), 'utf8'));
  await pg.exec(readFileSync(join(here, '..', '..', 'sql', 'v1.3-enrichment.sql'), 'utf8'));
  await pg.exec(readFileSync(join(here, '..', '..', 'sql', 'v1.4-domains.sql'), 'utf8'));
  return fromPglite(pg);
}

test('the CSV reader: quotes, commas and line breaks inside quotes, a BOM, blank lines', () => {
  const rows = parseCsv('﻿name,notes\r\n"Ace, Inc.","said ""hi""\nthen left"\r\n\r\nBob,x');
  assert.deepEqual(rows, [['name', 'notes'], ['Ace, Inc.', 'said "hi"\nthen left'], ['Bob', 'x']]);
});

test('columns are matched by their usual names; a person\'s phone is never read; a Maps "name" is the company', () => {
  const apollo = readList('First Name,Last Name,Title,Company,Website,Email,Phone,City,State\nJoe,Ruiz,Owner,Ace Plumbing,https://www.aceplumb.com,joe@aceplumb.com,555-1234,Worcester,MA');
  assert.equal(apollo.hasPeople, true);
  assert.equal(apollo.rows[0].company_phone, null, 'the person\'s phone is dropped');
  assert.equal(apollo.rows[0].designation, 'Owner');
  assert.ok(apollo.unused.includes('Phone'));
  const maps = readList('name,website,phone,city,state\nAce Plumbing,aceplumb.com,555-1234,Worcester,MA');
  assert.equal(maps.hasPeople, false);
  assert.equal(maps.rows[0].company_name, 'Ace Plumbing');
  assert.equal(maps.rows[0].company_phone, '555-1234', 'a company list keeps the business phone');
  assert.equal(domainOf('https://www.AcePlumb.com/contact'), 'aceplumb.com');
});

let db, plan, result;
const CSV = [
  'First Name,Last Name,Title,Company,Website,Email,City,State',
  'Joe,Ruiz,Owner,Ace Plumbing,aceplumb.com,joe@aceplumb.com,Worcester,MA',       // owner with a work email: verify only
  'Ann,Lee,Founder,Lee Plumbing,leeplumb.com,annlee@gmail.com,Lowell,MA',          // personal email: dropped, the engine finds one
  'Pat,Kim,Office Manager,Kim Plumbing,kimplumb.com,pat@kimplumb.com,Salem,MA',    // not an owner (D6-1)
  'Sam,Hill,Owner,Done Plumbing,doneplumb.com,,Boston,MA',                         // the firm was already worked
  'Max,Oak,Owner,West Plumbing,westplumb.com,max@westplumb.com,Fresno,CA',         // a hold state
  'Vic,Ray,Owner,Ray Plumbing,rayplumb.com,vic@rayplumb.com,Quincy,MA',            // already verified this month
  ',,,,,,,',
  ',,,No Site Plumbing,,,Lynn,MA',                                                 // a firm with no person
].join('\n');

before(async () => {
  db = await freshDb();
  await db.query(`insert into companies (company_name, website, city, state_code, industry_code, enrichment_stage) values
    ('Done Plumbing','doneplumb.com','Boston','MA','plumbing','owners_found'), ('Ray Plumbing','rayplumb.com','Quincy','MA','plumbing','owners_found')`);
  await db.query(`insert into people (company_id, first_name, last_name, email, status_code, enrichment_stage, email_checked_at)
    values ((select company_id from companies where company_name = 'Ray Plumbing'), 'Vic', 'Ray', 'vic@rayplumb.com', 'verified', 'verified', current_date)`);
  plan = await planList(db, readList(CSV), { domainOf, apolloCreditUsd: 0.01 });
});

test('the plan: what each row needs, what is already done, and a cost with a cap', () => {
  const k = plan.count;
  assert.equal(k.not_owner, 1);
  assert.equal(k.emails_dropped, 1);
  assert.equal(k.already_done, 1, 'Vic was verified this month');
  assert.equal(k.in_hold_state, 1, 'West Plumbing is in CA');
  assert.equal(k.firms_already_worked, 2, 'Done and Ray Plumbing');
  assert.equal(k.firms_to_work, 4, 'Ace, Lee, Kim and No Site');
  assert.equal(k.emails_to_verify, 1, 'Joe only');
  assert.equal(k.owners_to_find_email, 2, 'Ann (dropped email) and Sam (none listed)');
  assert.ok(plan.expectedUsd > 0 && plan.expectedUsd < plan.suggestedCapUsd + 0.001);
});

test('the import queues only what is not done, and a listed owner is one source with a main-lane email', async () => {
  const job = await db.one(`insert into enrichment_jobs (kind, industry_code, requested_by, max_cost_usd, status) values ('enrich','plumbing','T',5,'running') returning job_id`);
  result = await importList(db, plan, { jobId: job.job_id, tool: 'apollo', industryCode: 'plumbing', person: 'T' });
  const co = Object.fromEntries((await db.query('select company_name, enrichment_stage from companies')).map((c) => [c.company_name, c.enrichment_stage]));
  assert.equal(co['Ace Plumbing'], 'to_read');
  assert.equal(co['No Site Plumbing'], 'to_read');
  assert.equal(co['Done Plumbing'], 'owners_found', 'a firm already worked is not paid for again');
  assert.equal(co['Ray Plumbing'], 'owners_found');
  const joe = await db.one(`select role, owner_sources, owner_confirmed, email, email_method, email_lane, enrichment_stage from people where first_name = 'Joe'`);
  assert.equal(joe.role, 'owner');
  assert.deepEqual(joe.owner_sources.map((s) => s.source), ['apollo']);
  assert.equal(joe.owner_confirmed, false, 'one source is never confirmed');
  assert.equal(joe.email_method, 'provider');
  assert.equal(joe.email_lane, 'main');
  assert.equal(joe.enrichment_stage, 'not_queued', 'waits for the owner step to find a second source');
  const ann = await db.one(`select email from people where first_name = 'Ann'`);
  assert.equal(ann.email, null, 'the personal address from the list was not kept');
  const pat = await db.one(`select role, owner_sources from people where first_name = 'Pat'`);
  assert.equal(pat.role, null, 'the office manager is never an owner');
  const vic = await db.one(`select enrichment_stage, status_code from people where first_name = 'Vic'`);
  assert.equal(vic.enrichment_stage, 'verified');
});

test('the owner step counts the list as one source, finds a second, and keeps one row for the person', async () => {
  const ace = await db.one(`select company_id from companies where company_name = 'Ace Plumbing'`);
  await db.query(`update companies set enrichment_stage = 'not_queued' where company_name <> 'Ace Plumbing' and enrichment_stage = 'to_read'`);
  await db.query(`update companies set enrichment_stage = 'to_find_owner' where company_id = $1`, [ace.company_id]);
  const order = [];
  const ctx = { db, worker: 'w', config: { person: 'T', allowSpend: true, concurrency: 1 }, log: () => {}, redact: (s) => s, providers: {
    owners: async ({ source }) => { order.push(source); return source === 'web_search' ? [{ name: 'Joe Ruiz', title: 'Owner', url: 'https://search.example' }] : []; } } };
  await runOnce(ctx, { steps: ['owner'] });
  assert.deepEqual(order, ['leadocean', 'web_search'], 'cheapest first, and it stops once two sources agree');
  const joes = await db.query(`select owner_confirmed, enrichment_stage, owner_sources from people where first_name = 'Joe'`);
  assert.equal(joes.length, 1, 'no second row for the same person');
  assert.equal(joes[0].owner_confirmed, true);
  assert.equal(joes[0].enrichment_stage, 'awaiting_approval', 'shown to a person before any email money');
  assert.deepEqual(joes[0].owner_sources.map((s) => s.source).sort(), ['apollo', 'web_search']);
});

test('the dearer second verifier runs only when the first said valid', async () => {
  const d = await freshDb();
  const co = await d.one(`insert into companies (company_name, website, state_code, industry_code) values ('V Co','vco.com','MA','hvac') returning company_id`);
  await d.query(`insert into people (company_id, first_name, last_name, email, role, owner_confirmed, enrichment_stage, email_method, email_lane, email_provider, email_is_freemail)
    values ($1,'Bad','One','bad@vco.com','owner',true,'to_verify','provider','main','apollo',false), ($1,'Good','Two','good@vco.com','owner',true,'to_verify','provider','main','apollo',false)`, [co.company_id]);
  const calls = [];
  const ctx = { db: d, worker: 'w', config: { person: 'T', allowSpend: true, concurrency: 1 }, log: () => {}, redact: (s) => s, providers: {
    verify: async ({ which, email }) => { calls.push(`${which}:${email}`); return { tool: which, result: email.startsWith('bad') ? 'invalid' : 'valid' }; } } };
  await runOnce(ctx, { steps: ['verify'] });
  assert.deepEqual(calls.sort(), ['a:bad@vco.com', 'a:good@vco.com', 'b:good@vco.com']);
  const r = Object.fromEntries((await d.query('select first_name, enrichment_stage from people')).map((p) => [p.first_name, p.enrichment_stage]));
  assert.equal(r.Bad, 'no_email');
  assert.equal(r.Good, 'verified');
});
