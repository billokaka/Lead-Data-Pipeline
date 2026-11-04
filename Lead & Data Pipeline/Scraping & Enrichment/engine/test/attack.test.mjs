// One test per finding of the reviewer's attack (2026-10-29), so each fix stays fixed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { fromPglite } from '../src/db.mjs';
import { makeSpender } from '../src/money.mjs';
import { runOnce } from '../src/worker.mjs';
import { decideOwner, ownerRole } from '../src/rules.mjs';
import { namesFromSnippets, makeProviders } from '../src/providers/index.mjs';
import { isPublicHost } from '../src/providers/http.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let db;
const fresh = async (setup = '') => {
  const pg = new PGlite();
  await pg.exec('create role anon; create role authenticated;');
  await pg.exec(readFileSync(join(here, '..', '..', 'sql', 'icp-database-v1-run-in-supabase.sql'), 'utf8'));
  if (setup) await pg.exec(setup);
  await pg.exec(readFileSync(join(here, '..', '..', 'sql', 'v1.3-enrichment.sql'), 'utf8'));
  await pg.exec(readFileSync(join(here, '..', '..', 'sql', 'v1.4-domains.sql'), 'utf8'));
  return fromPglite(pg);
};
before(async () => { db = await fresh(`insert into companies (company_name, website, state_code, industry_code) values ('Hand Co','handco.com','MA','hvac');
  insert into people (company_id, first_name, email, status_code) values ((select company_id from companies limit 1),'Ann','ann@handco.com','not_interested');`); });

test('#3 #7 hand-entered rows are kept out of the engine on the first run', async () => {
  assert.equal((await db.one(`select enrichment_stage from companies where company_name='Hand Co'`)).enrichment_stage, 'not_queued');
  assert.equal((await db.one(`select enrichment_stage from people where first_name='Ann'`)).enrichment_stage, 'not_queued');
});

test('#1 a dry run (spend off) burns no attempts and stops at once', async () => {
  await db.query(`insert into companies (company_name, website, city, state_code, industry_code) values ('Dry Co','dryco.com','Boston','MA','hvac')`);
  const config = { person: 'T', allowSpend: false, concurrency: 2 };
  const ctx = { db, config, log: () => {}, redact: (s) => s, providers: makeProviders({ config: { ...config, keys: { openrouter: 'x' }, testBase: 'http://127.0.0.1:9' }, paid: makeSpender({ db, config }) }) };
  ctx.providers.fetchPage = async () => ({ text: 'Dry Co is an HVAC company.' });
  for (let i = 0; i < 6; i++) await runOnce(ctx);
  const c = await db.one(`select attempts, enrichment_stage, stage_note, claimed_by from companies where company_name='Dry Co'`);
  assert.equal(c.attempts, 0);
  assert.equal(c.enrichment_stage, 'to_read');
  assert.match(c.stage_note, /switched off/);
  assert.equal(c.claimed_by, null);
});

test('#1 a real error counts an attempt; the fifth sends the row to a person', async () => {
  await db.query(`insert into companies (company_name, website, city, state_code, industry_code) values ('Err Co','errco.com','Boston','MA','hvac')`);
  const ctx = { db, config: { person: 'T', allowSpend: true, concurrency: 1 }, log: () => {}, redact: (s) => s,
    providers: { fetchPage: async () => { throw new Error('boom'); } } };
  for (let i = 0; i < 5; i++) await runOnce(ctx, { steps: ['site read'] });
  const c = await db.one(`select attempts, enrichment_stage, stage_note from companies where company_name='Err Co'`);
  assert.equal(c.attempts, 5);
  assert.equal(c.enrichment_stage, 'needs_review');
  assert.match(c.stage_note, /boom/);
});

test('#2 a worker whose lease went to another worker can write nothing', async () => {
  const co = await db.one(`insert into companies (company_name, website, city, state_code, industry_code, enrichment_stage) values ('Lease Co','leaseco.com','Boston','MA','hvac','to_read') returning company_id`);
  await db.query(`update companies set enrichment_stage='not_queued' where company_id <> $1 and enrichment_stage='to_read'`, [co.company_id]);
  const slow = { db, worker: 'slow', config: { person: 'slow', allowSpend: true, concurrency: 1 }, log: () => {}, redact: (s) => s, providers: {
    fetchPage: async () => {
      // while the slow worker reads, its lease runs out and a fast worker takes the row
      await db.query(`update companies set claimed_by = 'fast', claimed_until = now() + interval '1 hour' where company_id = $1`, [co.company_id]);
      return { text: 'Lease Co is an HVAC company. Owner Al Bo.' };
    },
    siteRead: async () => ({ answers: [{ key: 'is_target', answer: true, quote: 'Lease Co is an HVAC company' }], owners: [] }) } };
  await runOnce(slow, { steps: ['site read'] });
  const c = await db.one('select enrichment_stage, claimed_by from companies where company_id = $1', [co.company_id]);
  assert.equal(c.enrichment_stage, 'to_read', 'the slow worker wrote nothing');
  assert.equal(c.claimed_by, 'fast', 'and did not clear the fast worker\'s lease');
});

test('#3 a budget of 0 stops even a tool that costs nothing in dollars', async () => {
  await db.query(`insert into budgets (provider, daily_usd, updated_by) values ('leadocean', 0, 'T') on conflict (provider) do update set daily_usd = 0`);
  assert.equal((await db.one(`select budget_allows('leadocean', 0) ok`)).ok, false);
});

test('#3 the pause switch is read before every paid call', async () => {
  await db.query(`update flags set value = true, set_by='T', reason='t' where name='enrichment_paused'`);
  const paid = makeSpender({ db, config: { person: 'T', allowSpend: true } });
  await assert.rejects(paid({ provider: 'treg', step: 'x', estUsd: 0 }, async () => ({ result: 1 })), /paused/);
  await db.query(`update flags set value = false, set_by='T', reason='t' where name='enrichment_paused'`);
});

test('#4 a miss stays a miss (null), never the wrapper object', async () => {
  const paid = makeSpender({ db, config: { person: 'T', allowSpend: true } });
  assert.equal(await paid({ provider: 'treg', step: 'x', estUsd: 0 }, async () => ({ result: null, usd: 0 })), null);
});

test('#5 Tomba: undeliverable is invalid; valid needs the server\'s own yes', async () => {
  const answers = { u: { result: 'undeliverable', status: 'invalid', smtp_check: false }, v: { result: 'deliverable', status: 'valid', smtp_check: true },
    n: { result: 'deliverable', status: 'valid', smtp_check: false } };
  const srv = createServer((req, res) => { const k = new URL(req.url, 'http://x').searchParams.get('email')[0]; res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { email: answers[k] } })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = makeProviders({ config: { testBase: `http://127.0.0.1:${srv.address().port}`, keys: { treg: 't' } }, paid: async (m, fn) => (await fn()).result });
  assert.equal((await p.verify({ which: 'b', email: 'u@x.com' })).result, 'invalid');
  assert.equal((await p.verify({ which: 'b', email: 'v@x.com' })).result, 'valid');
  assert.equal((await p.verify({ which: 'b', email: 'n@x.com' })).result, 'unknown');
  srv.close();
});

test('#6 web-search names: about this company, no "Meet", no street words, the snippet\'s own title', () => {
  const r = namesFromSnippets([{ title: 'Ace Plumbing', snippet: 'Meet Joe Ruiz, owner of Ace Plumbing in Worcester.' }, { title: 'Other Co', snippet: 'Owner Sam Hill runs Other Co.' },
    { title: 'Ace Plumbing reviews', snippet: 'Business owner Google Reviews for Ace Plumbing' }], 'Ace Plumbing', 'aceplumb.com');
  assert.deepEqual(r.map((x) => [x.name, x.title]), [['Joe Ruiz', 'owner']]);
});

test('#10 former owners and partner managers are not owners; the people databases count once; a CEO needs the site', () => {
  for (const t of ['Former Owner', 'Past President', 'Product Owner', 'Partner Manager', 'Ex-CEO']) assert.equal(ownerRole(t), null, t);
  assert.equal(decideOwner([{ name: 'Joe Ruiz', title: 'Owner', source: 'apollo' }, { name: 'Joe Ruiz', title: 'Owner', source: 'leadocean' }]).confirmed, false);
  assert.equal(decideOwner([{ name: 'Joe Ruiz', title: 'CEO', source: 'apollo' }, { name: 'Joe Ruiz', title: 'CEO', source: 'web_search' }]).confirmed, false);
  assert.equal(decideOwner([{ name: 'Joe Ruiz', title: 'CEO', source: 'website' }, { name: 'Joe Ruiz', title: 'CEO', source: 'apollo' }]).confirmed, true);
});

test('#9 a provider email on another domain, or a role address, is refused', async () => {
  const d = await fresh();
  const co = await d.one(`insert into companies (company_name, website, state_code, industry_code, enrichment_stage) values ('Dom Co','domco.com','MA','hvac','owners_found') returning company_id`);
  const p = await d.one(`insert into people (company_id, first_name, last_name, role, owner_confirmed, enrichment_stage) values ($1,'Joe','Ruiz','owner',true,'to_find_email') returning person_id`, [co.company_id]);
  const emails = { apollo: 'joe@formerjob.com', leadocean: 'info@domco.com', kitt: null, tomba: null };
  const ctx = { db: d, config: { person: 'T', allowSpend: true, concurrency: 1 }, log: () => {}, redact: (s) => s, providers: {
    findEmail: async ({ source }) => (emails[source] ? { email: emails[source] } : null), isCatchAll: async () => true } };
  await runOnce(ctx, { steps: ['email'] });
  const r = await d.one('select email, enrichment_stage from people where person_id = $1', [p.person_id]);
  assert.equal(r.email, null, 'neither the old employer\'s address nor info@ was taken');
});

test('no model key stops the run without counting an attempt', async () => {
  const d = await fresh();
  await d.query(`insert into companies (company_name, website, city, state_code, industry_code, enrichment_stage) values ('Key Co','keyco.com','Boston','MA','hvac','to_read')`);
  const config = { person: 'T', allowSpend: true, concurrency: 1 };
  const ctx = { db: d, config, log: () => {}, redact: (s) => s, providers: makeProviders({ config: { ...config, keys: {}, testBase: 'http://127.0.0.1:9' }, paid: makeSpender({ db: d, config }) }) };
  ctx.providers.fetchPage = async () => ({ text: 'Key Co is an HVAC company.' });
  await runOnce(ctx, { steps: ['site read'] });
  const c = await d.one(`select attempts, enrichment_stage, stage_note from companies where company_name='Key Co'`);
  assert.equal(c.attempts, 0);
  assert.equal(c.enrichment_stage, 'to_read');
  assert.match(c.stage_note, /no model key/);
});

test('#12 private addresses, in every form, are never fetched', async () => {
  for (const h of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::', '[::1]', '172.20.0.1', 'fe80::1', '100.64.0.1', 'x.localhost'])
    assert.equal(await isPublicHost(h), false, h);
});
