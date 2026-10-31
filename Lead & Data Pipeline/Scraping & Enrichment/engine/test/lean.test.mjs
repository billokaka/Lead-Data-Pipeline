// The lean site read (2026-10-29): code keeps only the lines worth judging, and skips the model when there is nothing to judge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { fromPglite } from '../src/db.mjs';
import { runOnce } from '../src/worker.mjs';
import { leanExtract, categoryMatches } from '../src/stages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const plumbing = { name: 'Plumbing', description: 'Plumbing contractors' };

test('the extract keeps the page top and the owner and chain lines, as exact stretches of the page, within the cap', () => {
  const filler = 'We fix pipes and drains across the county. '.repeat(200);
  const home = `Ace Plumbing, a plumbing company in Worcester. ${filler} Owner Joe Ruiz started the shop in 1998. ${filler} We are not a franchise.`;
  const r = leanExtract([{ path: '/', text: home }]);
  assert.equal(r.ownerHits, 1);
  assert.equal(r.chainHits, 1);
  const sent = r.pieces.map((p) => p.text).join(' ');
  assert.match(sent, /Owner Joe Ruiz started the shop/);
  assert.match(sent, /not a franchise/);
  assert.ok(r.chars <= 6000 && r.chars < home.length / 3, `sent ${r.chars} of ${home.length}`);
  for (const piece of r.pieces[0].text.split('\n…\n')) assert.ok(home.includes(piece), 'every piece is copied from the page');
});

test('a Google category matches the trade by its stem, but never a supplier or store', () => {
  assert.equal(categoryMatches('Plumber', plumbing), true);
  assert.equal(categoryMatches('HVAC contractor', { name: 'HVAC', description: 'Heating, ventilation and air conditioning contractors' }), true);
  assert.equal(categoryMatches('Plumbing supply store', plumbing), false);
  assert.equal(categoryMatches('Real estate agency', plumbing), false);
  assert.equal(categoryMatches('Commercial real estate agency', { name: 'Janitorial', description: 'Commercial cleaning and janitorial services' }), false);
  assert.equal(categoryMatches(null, plumbing), false);
});

async function freshDb() {
  const pg = new PGlite();
  await pg.exec('create role anon; create role authenticated;');
  await pg.exec(readFileSync(join(here, '..', '..', 'sql', 'icp-database-v1-run-in-supabase.sql'), 'utf8'));
  await pg.exec(readFileSync(join(here, '..', '..', 'sql', 'v1.3-enrichment.sql'), 'utf8'));
  return fromPglite(pg);
}

test('no owner or chain lines and a matching category: no model call, the firm moves on, the emails are kept', async () => {
  const db = await freshDb();
  await db.query(`insert into companies (company_name, website, city, state_code, industry_code, google_category, enrichment_stage)
    values ('Quiet Plumbing','quietplumb.com','Boston','MA','plumbing','Plumber','to_read'), ('Talky Plumbing','talkyplumb.com','Boston','MA','plumbing','Plumber','to_read')`);
  const pages = { 'quietplumb.com': 'Quiet Plumbing. Drains, heaters, leaks. Call us or write to office@quietplumb.com.',
                  'talkyplumb.com': 'Talky Plumbing. Owner Sam Hill answers the phone.' };
  let modelCalls = 0;
  const ctx = { db, worker: 'w', config: { person: 'T', allowSpend: true, concurrency: 1 }, log: () => {}, redact: (s) => s, providers: {
    fetchPage: async ({ url }) => { const k = Object.keys(pages).find((d) => url.endsWith(d)); return k ? { text: pages[k] } : null; },
    siteRead: async ({ pages: sent }) => { modelCalls++; assert.match(sent[0].text, /Owner Sam Hill/);
      return { answers: [{ key: 'is_target', answer: true, quote: 'Talky Plumbing' }], owners: [{ name: 'Sam Hill', title: 'Owner', quote: 'Owner Sam Hill answers the phone' }] }; } } };
  await runOnce(ctx, { steps: ['site read'] });
  assert.equal(modelCalls, 1, 'only the site with an owner line went to the model');
  const quiet = await db.one(`select enrichment_stage, site_read from companies where company_name = 'Quiet Plumbing'`);
  assert.equal(quiet.enrichment_stage, 'to_find_owner');
  assert.equal(quiet.site_read.method, 'code_only');
  assert.deepEqual(quiet.site_read.emails.map((e) => e.email), ['office@quietplumb.com']);
  const talky = await db.one(`select enrichment_stage, site_read from companies where company_name = 'Talky Plumbing'`);
  assert.equal(talky.site_read.method, 'model');
  assert.deepEqual(talky.site_read.owners.map((o) => o.name), ['Sam Hill']);
});

test('no category (an Apollo or Leadocean row) always goes to the model', async () => {
  const db = await freshDb();
  await db.query(`insert into companies (company_name, website, city, state_code, industry_code, enrichment_stage) values ('Db Plumbing','dbplumb.com','Boston','MA','plumbing','to_read')`);
  let modelCalls = 0;
  const ctx = { db, worker: 'w', config: { person: 'T', allowSpend: true, concurrency: 1 }, log: () => {}, redact: (s) => s, providers: {
    fetchPage: async () => ({ text: 'Db Plumbing fixes pipes.' }),
    siteRead: async () => { modelCalls++; return { answers: [{ key: 'is_target', answer: true, quote: 'Db Plumbing fixes pipes' }], owners: [] }; } } };
  await runOnce(ctx, { steps: ['site read'] });
  assert.equal(modelCalls, 1);
});
