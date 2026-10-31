// Email enrichment of a list, file to file (2026-10-29). The operator's rules: owners, CEOs, founders, co-founders and
// "President" (flagged); Leadocean first, then Apollo and Smartlead split half and half; an address its own provider
// marks verified is taken with no paid check; otherwise one cheap check on the first unverified address; no patterns;
// hold states can be left for later. Every column and row kept; no address given to two rows; a stopped run carries on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv } from '../src/csv.mjs';
import { runList, eligibleTitle, stateOf, nearDomain, titleCheck, AFTER_EMAIL, AT_END } from '../src/listemail.mjs';
import { SpendRefused } from '../src/money.mjs';

const states = new Map([['ohio', { code: 'OH', hold: false }], ['california', { code: 'CA', hold: true }]]);
const HEAD = 'firstName,lastName,email,linkedinUrl,location,companyName,jobTitle,companyWebsite,summary';
const OH = '"Akron, Ohio, United States"';
const ROWS = [
  `Jim,Lo,,https://linkedin.com/in/jim,"Cleveland, Cuyahoga County, Ohio, United States",Lo HVAC,President/Owner,lohvac.com,"said ""hi"", then\nleft"`, // 0 Leadocean verified
  `Amy,Ap,,https://linkedin.com/in/amy,${OH},Ap Pest,CEO,appest.com,`,              // 1 (odd) Smartlead first: nothing; Apollo verified
  `Pat,Pa,,https://linkedin.com/in/pat,${OH},Pa Roof,Founder,paroof.com,`,          // 2 (even) Apollo guess only, then Smartlead nothing: one check, valid
  `Cat,Ca,,https://linkedin.com/in/cat,${OH},Ca Co,Co-Founder,cat.com,`,            // 3 Smartlead says Catch_All
  `Sue,Op,,https://linkedin.com/in/sue,${OH},Op Co,Operations Manager,opco.com,`,   // 4 not an owner: skipped
  `Ben,Ex,,https://linkedin.com/in/ben,${OH},Ex Co,Former Owner,exco.com,`,         // 5 a former owner: skipped
  `Jim,Lo,,https://linkedin.com/in/jim2,"Cleveland, Ohio, United States",Lo HVAC,Owner,lohvac.com,`, // 6 the lookalike: the same address again
  `Lia,Li,lia@lico.com,https://linkedin.com/in/lia,${OH},Li Co,Owner,lico.com,`,    // 7 nothing from the providers: the list's own gets the check
  `Zed,Ze,,https://linkedin.com/in/zed,${OH},Zed Heating,President,zedheat.com,`,  // 8 Smartlead Valid on a near domain
  `Nia,No,,https://linkedin.com/in/nia,${OH},No Co,Owner,nofind.com,`,             // 9 nothing anywhere
  `Max,Ca,,https://linkedin.com/in/max,"Fresno, California, United States",Ca Pest,Owner,capest.com,`, // 10 a hold state
  `Don,Do,,https://linkedin.com/in/don,${OH},Do Co,Owner,doco.com,`,               // 11 a verified address on another business's domain
];
function fakes(calls) {
  return {
    findEmail: async ({ person }) => {
      calls.push(`leadocean:${person.linkedin_url}`);
      if (person.linkedin_url.endsWith('/jim') || person.linkedin_url.endsWith('/jim2')) return { email: 'jim@lohvac.com', generated: false, ref: 'leadocean verified' };
      if (person.linkedin_url.endsWith('/don')) return { email: 'don@budgetrooter.com', generated: false, ref: 'leadocean verified' };
      return null;
    },
    apolloMatch: async ({ linkedin }) => {
      calls.push(`apollo:${linkedin}`);
      if (linkedin.endsWith('/amy')) return { email: 'amy@appest.com', generated: false, ref: 'apollo verified' };
      if (linkedin.endsWith('/pat')) return { email: 'pat@paroof.com', generated: true, ref: 'apollo extrapolated' };
      return null;
    },
    smartleadFind: async ({ first, domain }) => {
      calls.push(`smartlead:${domain}`);
      if (first === 'Zed') return { email: 'zed@zedheating.com', generated: false, ref: 'smartlead Valid' };
      if (first === 'Cat') return { email: 'cat@cat.com', generated: true, ref: 'smartlead Catch_All' };
      return null;
    },
    verify: async ({ which, email }) => { calls.push(`${which}:${email}`); return { tool: 'millionverifier', result: ['pat@paroof.com', 'lia@lico.com'].includes(email) ? 'valid' : 'invalid' }; },
    isCatchAll: async () => { calls.push('catchall'); return false; },
  };
}
const setup = () => { const dir = mkdtempSync(join(tmpdir(), 'listemail-')); const input = join(dir, 'list.csv'); writeFileSync(input, [HEAD, ...ROWS].join('\r\n')); return { dir, input }; };
const read = (file) => { const [h, ...rows] = parseCsv(readFileSync(file, 'utf8')); return { h, rows, f: (i, k) => rows[i][h.indexOf(k)] }; };

test('who is run: owners, CEOs, founders, co-founders and presidents (flagged); never a former owner, a VP or a manager', () => {
  for (const t of ['Owner', 'President/Owner', 'CEO', 'Founder', 'Co-Founder', 'Co-Owner', 'Founder & CEO', 'President']) assert.equal(eligibleTitle(t), true, t);
  for (const t of ['Former Owner', 'Operations Manager', 'Product Owner', 'Vice President', 'Executive Vice President', 'Managing Partner', 'Office Manager']) assert.equal(eligibleTitle(t), false, t);
  assert.match(titleCheck('President'), /approved as owner/);
  assert.equal(titleCheck('President/Owner'), '');
  assert.equal(stateOf('Cleveland, Cuyahoga County, Ohio, United States', states).code, 'OH');
  assert.equal(stateOf('Lima, Peru', states), null);
});

test('a near domain is the same firm, another business never is', () => {
  for (const [e, w] of [['raybrownac.com', 'raybrownairandheat.com'], ['allbritewash.com', 'allbritepressurewash.com'], ['roofgeniusai.com', 'roofgenius.ai'],
    ['e-conoair.com', 'myeconoair.com'], ['mechsales.com', 'mechsalesmidwest.com'], ['northgeorgia.grassrootsturf.com', 'grassrootsturf.com'], ['roofmaxx.com', 'roofmaxx.info']])
    assert.equal(nearDomain(e, w), true, `${e} ~ ${w}`);
  for (const [e, w] of [['donscopiers.com', 'budgetrooter.com'], ['financialguide.com', 'fishwindowcleaning.com'], ['abc.com', 'abd.com'], ['gmail.com', 'lohvac.com']])
    assert.equal(nearDomain(e, w), false, `${e} !~ ${w}`);
});

test('provider-verified addresses cost no check; one cheap check otherwise; every column and row kept', async () => {
  const { dir, input } = setup();
  const calls = [];
  const r = await runList({ input, outDir: join(dir, 'out'), limit: 100, providers: fakes(calls), jobId: 1, states, concurrency: 1 });
  assert.equal(r.processed, 10, 'every eligible row: the manager and the former owner are not run');
  const { h, rows, f } = read(r.out);
  const orig = HEAD.split(','); const e = orig.indexOf('email') + 1;
  assert.deepEqual(h, [...orig.slice(0, e), ...AFTER_EMAIL, ...orig.slice(e), ...AT_END], 'one email column, its status beside it, every original column in order');
  assert.ok(!h.includes('enrich_email'), 'no second email column');
  assert.equal(rows.length, ROWS.length, 'every row is in the results');
  assert.equal(f(0, 'summary'), 'said "hi", then\nleft', 'a field with quotes, a comma and a line break survives');
  assert.equal(f(0, 'email_status'), 'verified'); assert.equal(f(0, 'email_source'), 'leadocean'); assert.equal(f(0, 'email_lane'), 'main'); assert.equal(f(0, 'email'), 'jim@lohvac.com');
  assert.equal(f(0, 'checked_by'), 'leadocean:verified');
  assert.equal(f(1, 'email_source'), 'apollo');
  assert.equal(f(2, 'email_status'), 'verified'); assert.equal(f(2, 'checked_by'), 'millionverifier:valid'); assert.equal(f(2, 'email_lane'), 'separate');
  assert.equal(f(3, 'email_status'), 'catch_all'); assert.equal(f(3, 'catchall_email'), 'cat@cat.com'); assert.equal(f(3, 'email'), '');
  assert.equal(f(4, 'email_status'), 'not_owner'); assert.equal(f(5, 'email_status'), 'not_owner');
  assert.equal(f(6, 'email_status'), 'duplicate'); assert.equal(f(6, 'email'), ''); assert.match(f(6, 'enrich_note'), /same email as row 2/);
  assert.equal(f(7, 'email_source'), 'list'); assert.equal(f(7, 'email'), 'lia@lico.com'); assert.equal(f(7, 'email_status'), 'verified');
  assert.equal(f(8, 'email_source'), 'smartlead'); assert.equal(f(8, 'email_lane'), 'separate', 'a near domain goes to the stricter lane');
  assert.match(f(8, 'title_check'), /approved as owner/); assert.match(f(8, 'enrich_note'), /differs from the website/);
  assert.equal(f(9, 'email_status'), 'not_found'); assert.equal(f(9, 'email_source'), '', 'no source without a verified email');
  assert.equal(f(11, 'email_status'), 'not_found', 'another business\'s address is never used, even "verified"');
  // the paid checks: exactly one each for Pat and Lia (no provider had a verified address); none for anyone else
  assert.deepEqual(calls.filter((c) => /^[ab]:/.test(c)).sort(), ['a:lia@lico.com', 'a:pat@paroof.com']);
  assert.ok(!calls.includes('catchall'), 'no pattern work at all');
  assert.ok(!calls.some((c) => c.includes('/sue') || c.includes('/ben')), 'nothing is asked for a skipped row');
});

test('a listed email that fails its check stays as it was, but says plainly it is not verified', async () => {
  const { dir, input } = setup();
  writeFileSync(input, [HEAD, `Bad,Li,bad@badco.com,https://linkedin.com/in/bad,${OH},Bad Co,Owner,badco.com,`].join('\n'));
  const calls = [];
  const r = await runList({ input, outDir: join(dir, 'out'), limit: 10, providers: fakes(calls), jobId: 1, states, concurrency: 1 });
  const { f } = read(r.out);
  assert.equal(f(0, 'email'), 'bad@badco.com', 'the original value is never removed');
  assert.equal(f(0, 'email_status'), 'not_found');
  assert.match(f(0, 'enrich_note'), /NOT verified/);
});

test('Apollo and Smartlead share the work: even rows ask Apollo first, odd rows Smartlead', async () => {
  const { dir, input } = setup();
  const calls = [];
  await runList({ input, outDir: join(dir, 'out'), limit: 100, providers: fakes(calls), jobId: 1, states, concurrency: 1 });
  const next = (who) => { const k = calls.indexOf(`leadocean:https://linkedin.com/in/${who}`); return calls.slice(k + 1).find((c) => /^(apollo|smartlead):/.test(c)); };
  assert.match(next('amy'), /^smartlead:/);   // index 1
  assert.match(next('pat'), /^apollo:/);      // index 2
  assert.match(next('cat'), /^smartlead:/);   // index 3
});

test('hold states can be left for later: not run, marked, still in the file', async () => {
  const { dir, input } = setup();
  const calls = [];
  const r = await runList({ input, outDir: join(dir, 'out'), limit: 100, providers: fakes(calls), jobId: 1, states, concurrency: 1, skipHold: true });
  assert.equal(r.processed, 9);
  assert.ok(!calls.some((c) => c.includes('/max')));
  const { f } = read(r.out);
  assert.equal(f(10, 'email_status'), 'hold_state'); assert.match(f(10, 'enrich_note'), /hold state/); assert.equal(f(10, 'state_on_hold'), 'approved (D9-7)');
});

test('a budget stop keeps what was done; the next run carries on without paying twice', async () => {
  const { dir, input } = setup();
  const calls = [];
  const p = fakes(calls);
  let budget = 3;
  const capped = { ...p, findEmail: async (a) => { if (budget-- <= 0) throw new SpendRefused('today\'s budget would be passed'); return p.findEmail(a); } };
  const r1 = await runList({ input, outDir: join(dir, 'out'), limit: 100, providers: capped, jobId: 1, states, concurrency: 1 });
  assert.match(r1.stopped, /budget/);
  const first = calls.length;
  const r2 = await runList({ input, outDir: join(dir, 'out'), limit: 100, providers: p, jobId: 2, states, concurrency: 1 });
  assert.equal(r1.processed + r2.processed, 10, 'every eligible row done once');
  assert.ok(!calls.slice(first).includes('leadocean:https://linkedin.com/in/jim'), 'a done row is not paid for again');
  assert.equal(read(r2.out).rows.filter((x) => x.includes('pending')).length, 0);
});

test('15 failures in a row stop the run (a key or a tool is down); nothing is saved for them', async () => {
  const { dir, input } = setup();
  writeFileSync(input, [HEAD, ...Array.from({ length: 30 }, (_, k) => `F${k},L${k},,https://linkedin.com/in/x${k},${OH},Co ${k},Owner,co${k}.com,`)].join('\n'));
  const broken = { findEmail: async () => { throw new Error('Leadocean answered 401'); } };
  const r = await runList({ input, outDir: join(dir, 'out'), limit: 100, providers: broken, jobId: 1, states, concurrency: 1 });
  assert.match(r.stopped, /15 rows failed in a row/);
  assert.equal(r.processed, 0);
  assert.equal(r.errors, 15);
});

test('a slow tool does not hold the run up: a miss after the wait, then skipped for a while, then tried again', async () => {
  const { patient } = await import('../src/listemail.mjs');
  let t = 0, calls = 0;
  const slowThenFast = async () => { calls++; if (calls <= 3) await new Promise((ok) => setTimeout(ok, 50)); return { email: 'x@y.com' }; };
  const notes = [];
  const f = patient(slowThenFast, { ms: 10, strikes: 2, restMs: 1000, name: 'Leadocean', log: (s) => notes.push(s), clock: () => t });
  assert.equal(await f({}), null, 'slow: a miss');
  assert.equal(await f({}), null, 'slow again: a miss, and now skipped');
  assert.match(notes[0], /Leadocean is slow/);
  assert.equal(await f({}), null); assert.equal(calls, 2, 'skipped: not even asked');
  t = 2000;
  assert.equal(await f({}), null, 'tried again after the rest, still slow');
  assert.equal(calls, 3);
  assert.deepEqual(await f({}), { email: 'x@y.com' }, 'fast again: used');
});

test('the Kitt second pass: only rows left without an email, once each; a find gets one check; a miss keeps the row as it was', async () => {
  const { dir, input } = setup();
  const calls = [];
  const out = join(dir, 'out');
  await runList({ input, outDir: out, limit: 100, providers: fakes(calls), jobId: 1, states, concurrency: 1 });
  const kittCalls = [];
  const withKitt = { ...fakes(calls),
    findEmail: async ({ source, name, domain }) => { kittCalls.push(`${source}:${name}`); if (source === 'leadocean') return name === 'Max Ca' ? { email: 'max@capest.com', generated: false, ref: 'leadocean verified' } : null; return name === 'Nia No' ? { email: `nia@${domain}`, generated: false } : name === 'Don Do' ? { email: 'don@elsewhere.com', generated: true } : null; },
    verify: async ({ email }) => ({ tool: 'millionverifier', result: email === 'nia@nofind.com' ? 'valid' : 'invalid' }) };
  const r = await runList({ input, outDir: out, limit: 100, providers: withKitt, jobId: 2, states, concurrency: 1, kitt: true });
  assert.deepEqual(kittCalls.sort(), ['kitt:Don Do', 'kitt:Nia No', 'leadocean:Don Do', 'leadocean:Max Ca', 'leadocean:Nia No'],
    'only the not-found rows; Leadocean first (free), Kitt only where Leadocean had nothing');
  assert.equal(read(join(out, 'list-enriched.csv')).f(10, 'email_source'), 'leadocean', 'a second-pass Leadocean find is used');
  const { f } = read(r.out);
  assert.equal(f(9, 'email_status'), 'verified'); assert.equal(f(9, 'email'), 'nia@nofind.com'); assert.equal(f(9, 'email_source'), 'kitt');
  assert.equal(f(11, 'email_status'), 'not_found', 'a guessed or off-domain Kitt answer is never used');
  assert.equal(f(0, 'email'), 'jim@lohvac.com', 'rows already verified are untouched');
  kittCalls.length = 0;
  await runList({ input, outDir: out, limit: 100, providers: withKitt, jobId: 3, states, concurrency: 1, kitt: true });
  assert.deepEqual(kittCalls, [], 'a row is tried by Kitt once only');
});
