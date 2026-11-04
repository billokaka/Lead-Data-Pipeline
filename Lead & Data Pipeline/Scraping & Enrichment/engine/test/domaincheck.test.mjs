// The domain pre-filter (2026-11-03): every DNS answer mapped to the right verdict, providers and gateways, the cache,
// the catch-all spend rules, the address flags and verifier, and v1.4 on top of v1 to v1.3. A fake resolver: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { fromPglite } from '../src/db.mjs';
import { addressFlags, providerOf, lookupDomain, makeDomainChecker, checkDomains, verifyAddress } from '../src/domaincheck.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = (f) => readFileSync(join(here, '..', '..', 'sql', f), 'utf8');

// a fake DNS: zone[name][type] = answers, or a code string ('nxdomain', 'refused', 'servfail', 'timeout')
function fakeDns(zone) {
  const calls = [];
  const query = async (type, name) => {
    calls.push(`${type} ${name}`);
    const z = zone[name];
    if (z === undefined) return { code: 'nxdomain', answers: [] };
    if (typeof z === 'string') return { code: z, answers: [] };
    const a = z[type];
    if (a === undefined) return { code: 'nodata', answers: [] };
    if (typeof a === 'string') return { code: a, answers: [] };
    return { code: 'ok', answers: a };
  };
  return { query, calls };
}
const mx = (...hosts) => hosts.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 }));
const ZONE = {
  'goodco.com': { MX: mx('aspmx.l.google.com', 'alt1.aspmx.l.google.com'), NS: ['ns1.cloudflare.com'], TXT: [['v=spf1 include:_spf.google.com -all']] },
  '_dmarc.goodco.com': { TXT: [['v=DMARC1; p=none']] },
  'aspmx.l.google.com': { A: ['142.250.1.26'] },
  'msco.com': { MX: mx('msco-com.mail.protection.outlook.com'), NS: ['ns1.msco.com'] },
  'msco-com.mail.protection.outlook.com': { A: ['52.101.1.1'] },
  'gateco.com': { MX: mx('mxa-001.gateco.pphosted.com'), NS: ['ns1.gateco.com'] },
  'mxa-001.gateco.pphosted.com': { A: ['67.231.1.1'] },
  'baggagenanny.com': 'refused',
  'parkedco.com': { MX: mx('mx.sedoparking.com'), NS: ['ns1.sedoparking.com'] },
  'nullmx.com': { MX: [{ exchange: '', priority: 0 }], NS: ['ns1.x.com'] },
  'webonly.com': { NS: ['ns1.x.com'], A: ['1.2.3.4'] },
  'nothing.com': { NS: ['ns1.x.com'] },
  'gonemx.com': { MX: mx('mail.gonemx-old.com'), NS: ['ns1.x.com'] },
  'flaky.com': { MX: 'servfail' },
};

test('stage 2: every DNS answer gets the right verdict and reason', async () => {
  const { query } = fakeDns(ZONE);
  const v = async (d) => (await lookupDomain(d, { query }));
  const good = await v('goodco.com');
  assert.equal(good.verdict, 'alive'); assert.equal(good.provider, 'google_workspace'); assert.equal(good.has_spf, true); assert.equal(good.has_dmarc, true); assert.equal(good.is_gateway, false);
  assert.equal((await v('msco.com')).provider, 'microsoft_365');
  const gate = await v('gateco.com'); assert.equal(gate.provider, 'proofpoint'); assert.equal(gate.is_gateway, true); assert.equal(gate.verdict, 'alive');
  assert.equal(gate.has_spf, false, 'no TXT record means no SPF');
  for (const [d, verdict, status] of [['baggagenanny.com', 'dead', 'refused'], ['no-such-domain.com', 'dead', 'nxdomain'], ['parkedco.com', 'dead', 'parked'],
    ['nullmx.com', 'dead', 'null_mx'], ['webonly.com', 'weak', 'no_mx'], ['nothing.com', 'dead', 'no_mx'], ['gonemx.com', 'dead', 'mx_unresolved'], ['flaky.com', 'unknown', 'servfail'],
    ['not a domain', 'unknown', 'bad_domain'], ['facebook.com', 'unknown', 'platform']]) {
    const f = await v(d);
    assert.equal(f.verdict, verdict, `${d}: ${f.verdict} ${f.dns_status}`); assert.equal(f.dns_status, status, d);
  }
});

test('parking: whole host names of parking services only; ordinary DNS hosts with the word in them are not parked', async () => {
  const { isParked } = await import('../src/domaincheck.mjs');
  assert.equal(isParked(['ns1.sedoparking.com']), true);
  assert.equal(isParked(['ns1.bodis.com']), true);
  assert.equal(isParked(['ns1.dns-parking.com', 'ns2.dns-parking.com']), false, 'Hostinger ordinary DNS');
  assert.equal(isParked(['ns1.namebrightdns.com']), false);
  assert.equal(isParked(['ns1.notbodis.com']), false, 'a suffix must match on a dot');
});

test('providers: suffixes and gateways', () => {
  assert.deepEqual(providerOf(['acme-com.mail.protection.outlook.com']), { provider: 'microsoft_365', is_gateway: false });
  assert.deepEqual(providerOf(['us-smtp-inbound-1.mimecast.com']), { provider: 'mimecast', is_gateway: true });
  assert.deepEqual(providerOf(['mx1.acme.iphmx.com']), { provider: 'cisco', is_gateway: true });
  assert.deepEqual(providerOf(['mail.acme.com']), { provider: 'other', is_gateway: false });
  assert.deepEqual(providerOf([]), { provider: 'none', is_gateway: false });
  assert.deepEqual(providerOf(['notgoogle.com']), { provider: 'other', is_gateway: false }, 'a suffix must match on a dot');
});

test('the domain age from RDAP marks a domain bought again recently; a failed RDAP never blocks', async () => {
  const { query } = fakeDns(ZONE);
  const today = new Date('2026-11-03');
  const young = await lookupDomain('goodco.com', { query, rdap: async () => '2026-10-01', today });
  assert.equal(young.domain_age_days, 33); assert.equal(young.recently_registered, true);
  const failed = await lookupDomain('goodco.com', { query, rdap: async () => null, today });
  assert.equal(failed.verdict, 'alive'); assert.equal(failed.domain_age_days, null);
});

test('stage 1: the address alone', () => {
  const f = (e) => addressFlags(e);
  assert.equal(f('  Joe.Smith@GoodCo.com ').email, 'joe.smith@goodco.com');
  assert.equal(f('mailto:joe@goodco.com').syntax_ok, true);
  assert.equal(f('joe@@goodco.com').syntax_ok, false);
  assert.equal(f('info@goodco.com').is_role, true);
  assert.equal(f('joe@gmail.com').is_free, true);
  assert.equal(f('joe@mailinator.com').is_disposable, true);
  assert.equal(f('xkcdqwrt@goodco.com').is_gibberish, true);
  assert.equal(f('joe+news@goodco.com').is_alias, true);
  assert.equal(f('joe@gmial.com').did_you_mean, 'joe@gmail.com');
  assert.equal(f('joe@goodco.com').did_you_mean, null);
});

async function freshDb() {
  const pg = new PGlite();
  await pg.exec('create role anon; create role authenticated;');
  await pg.exec(SQL('icp-database-v1-run-in-supabase.sql'));
  await pg.exec(SQL('v1.3-enrichment.sql'));
  await pg.exec(SQL('v1.4-domains.sql'));
  return fromPglite(pg);
}

test('v1.4 on top of v1 to v1.3: the cache tables, the new stages, RLS on; it runs again safely', async () => {
  const pg = new PGlite();
  await pg.exec('create role anon; create role authenticated;');
  for (const f of ['icp-database-v1-run-in-supabase.sql', 'v1.3-enrichment.sql', 'v1.4-domains.sql', 'v1.4-domains.sql']) await pg.exec(SQL(f));
  const db = fromPglite(pg);
  const r = await db.one(`select (select count(*) from information_schema.tables where table_name in ('email_domains','email_checks'))::int t,
    (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity)::int no_rls`);
  assert.deepEqual(r, { t: 2, no_rls: 0 });
  const co = await db.one(`insert into companies (company_name, website, state_code, industry_code, enrichment_stage) values ('A','a.com','MA','hvac','to_check_domain') returning company_id`);
  await db.query(`update companies set enrichment_stage = 'dead_domain' where company_id = $1`, [co.company_id]);
  await assert.rejects(db.query(`update companies set enrichment_stage = 'nonsense' where company_id = $1`, [co.company_id]));
});

test('the cache: a second check makes no DNS query; dead and alive are saved with their lifetimes', async () => {
  const db = await freshDb();
  const { query, calls } = fakeDns(ZONE);
  const checker = makeDomainChecker({ db, query, withAge: false });
  const first = await checkDomains(['goodco.com', 'baggagenanny.com', 'GoodCo.com'], checker);
  assert.equal(first.size, 2, 'one check per domain, whatever its case');
  const n = calls.length;
  const again = makeDomainChecker({ db, query, withAge: false });
  const g = await again.check('goodco.com');
  assert.equal(g.source, 'cached'); assert.equal(calls.length, n, 'no DNS on a fresh cache row');
  const rows = await db.query(`select domain, verdict, (expires_at - checked_at) > interval '13 days' long from email_domains order by domain`);
  assert.deepEqual(rows.map((r) => [r.domain, r.verdict, r.long]), [['baggagenanny.com', 'dead', false], ['goodco.com', 'alive', true]]);
});

test('catch-all: paid only for a live, non-gateway domain, once, through the provider', async () => {
  const db = await freshDb();
  const { query } = fakeDns(ZONE);
  const probes = [];
  const providers = { isCatchAll: async ({ domain }) => { probes.push(domain); return domain === 'msco.com'; } };
  const checker = makeDomainChecker({ db, query, withAge: false });
  assert.deepEqual(await checker.catchAll('baggagenanny.com', { providers }), { is_catch_all: null, source: 'not probed: the domain is not alive' });
  assert.deepEqual(await checker.catchAll('gateco.com', { providers }), { is_catch_all: true, source: 'gateway' });
  assert.deepEqual(await checker.catchAll('msco.com', { providers }), { is_catch_all: true, source: 'millionverifier' });
  assert.deepEqual(await checker.catchAll('goodco.com', { providers }), { is_catch_all: false, source: 'millionverifier' });
  const fresh = makeDomainChecker({ db, query, withAge: false });
  assert.equal((await fresh.catchAll('msco.com', { providers })).source, 'cached (millionverifier)');
  assert.deepEqual(probes, ['msco.com', 'goodco.com'], 'no probe for a dead or gateway domain, and none twice');
});

test('verifying an address: free checks first, then one paid check, then the cache', async () => {
  const db = await freshDb();
  const { query } = fakeDns(ZONE);
  const checker = makeDomainChecker({ db, query, withAge: false });
  const paid = [];
  const providers = { isCatchAll: async ({ domain }) => domain === 'msco.com', verify: async ({ email }) => { paid.push(email); return { tool: 'millionverifier', result: email.startsWith('joe') ? 'valid' : 'invalid' }; } };
  const v = (e) => verifyAddress(e, { checker, providers, db });
  assert.equal((await v('joe@goodco.com')).status, 'valid');
  assert.equal((await v('ann@goodco.com')).status, 'invalid');
  assert.equal((await v('joe@baggagenanny.com')).status, 'dead_domain');
  assert.equal((await v('joe@msco.com')).status, 'catch_all');
  assert.equal((await v('joe@@goodco.com')).status, 'bad_syntax');
  assert.equal((await v('joe@mailinator.com')).status, 'disposable');
  assert.deepEqual(paid, ['joe@goodco.com', 'ann@goodco.com'], 'paid only where the free checks could not decide');
  const again = await v('joe@goodco.com');
  assert.equal(again.source, 'cached'); assert.equal(paid.length, 2);
  assert.equal(again.quality, 'good');
});

// ---- one test per finding of the reviewer's attack (2026-11-03) ----------------------------------------------------
test('#2 a "dead" answer needs both resolvers; one resolver alone never kills a firm', async () => {
  const { twoResolvers } = await import('../src/domaincheck.mjs');
  const r = (code) => async () => ({ code, answers: code === 'ok' ? [{ exchange: 'mx.x.com', priority: 1 }] : [] });
  assert.equal((await twoResolvers(r('nxdomain'), r('ok'))).code, 'ok');
  assert.equal((await twoResolvers(r('nxdomain'), r('nxdomain'))).code, 'nxdomain');
  assert.equal((await twoResolvers(r('refused'), r('timeout'))).code, 'servfail', 'unconfirmed: unknown, not dead');
  assert.equal((await twoResolvers(r('timeout'), r('ok'))).code, 'ok');
});

test('#1 #5 a transient failure is unknown, never dead; every MX host is asked; AAAA counts', async () => {
  const { query } = fakeDns({
    'nomx-flaky.com': { NS: ['ns1.x.com'], A: 'timeout', AAAA: 'timeout' },
    'thirdmx.com': { MX: mx('gone1.thirdmx.com', 'gone2.thirdmx.com', 'mx3.thirdmx.com'), NS: ['ns1.x.com'] }, 'mx3.thirdmx.com': { A: ['1.1.1.1'] },
    'v6only.com': { MX: mx('mx.v6only.com'), NS: ['ns1.x.com'] }, 'mx.v6only.com': { AAAA: ['2001:db8::1'] },
    'mxflaky.com': { MX: mx('mx.mxflaky.com'), NS: ['ns1.x.com'] }, 'mx.mxflaky.com': { A: 'nodata', AAAA: 'timeout' },
  });
  assert.equal((await lookupDomain('nomx-flaky.com', { query })).verdict, 'unknown');
  assert.equal((await lookupDomain('thirdmx.com', { query })).verdict, 'alive', 'the third MX host works');
  assert.equal((await lookupDomain('v6only.com', { query })).verdict, 'alive');
  assert.equal((await lookupDomain('mxflaky.com', { query })).verdict, 'unknown', 'an AAAA timeout is unsure');
});

test('#3 #14 a bad domain never crashes a run and is never saved; a trailing dot hits the same cache row', async () => {
  const db = await freshDb();
  const { query } = fakeDns(ZONE);
  const checker = makeDomainChecker({ db, query, withAge: false });
  const all = await checkDomains(['bad domain!!', 'goodco.com.', 'facebook.com'], checker);
  assert.equal(all.get('bad domain!!').verdict, 'unknown');
  const n = (await db.query('select domain from email_domains')).map((r) => r.domain);
  assert.deepEqual(n, ['goodco.com'], 'only a real domain is saved, without its trailing dot');
  assert.equal((await checker.check('GOODCO.COM.')).source, 'cached');
});

test('#4 a dead website host under a live firm domain is judged by the firm domain', async () => {
  const { query } = fakeDns({ ...ZONE, 'shop.goodco.com': 'nxdomain' });
  const checker = makeDomainChecker({ query, withAge: false });
  const f = await checker.check('shop.goodco.com');
  assert.equal(f.verdict, 'alive'); assert.match(f.reason, /checked goodco\.com/);
});

test('#11 a parking nameserver with a real Google or Microsoft MX still takes mail', async () => {
  const { query } = fakeDns({ 'oddns.com': { MX: mx('aspmx.l.google.com'), NS: ['ns1.sedoparking.com'] }, 'aspmx.l.google.com': { A: ['1.1.1.1'] } });
  assert.equal((await lookupDomain('oddns.com', { query })).verdict, 'alive');
});

test('#7 #8 an undecided probe is cached; two asks at once, or two runs on one database, pay once', async () => {
  const db = await freshDb();
  const { query } = fakeDns(ZONE);
  let probes = 0;
  const slow = { isCatchAll: async ({ domain }) => { probes++; await new Promise((r) => setTimeout(r, 20)); return domain === 'msco.com' ? null : false; } };
  const a = makeDomainChecker({ db, query, withAge: false }), b = makeDomainChecker({ db, query, withAge: false });
  await a.check('goodco.com'); await b.check('goodco.com');
  const [x, y, z] = await Promise.all([a.catchAll('goodco.com', { providers: slow }), a.catchAll('goodco.com', { providers: slow }), b.catchAll('goodco.com', { providers: slow })]);
  assert.equal(probes, 1, 'one probe for three asks across two runs');
  assert.equal(x.is_catch_all, false); assert.ok([y.source, z.source].every((s) => /millionverifier|being probed|cached/.test(s)));
  assert.equal((await a.catchAll('msco.com', { providers: slow })).source, 'undecided');
  assert.equal((await a.catchAll('msco.com', { providers: slow })).source, 'cached (undecided)');
  assert.equal(probes, 2, 'an undecided answer is not paid for again');
});

test('#9 a change of verdict, provider or gateway clears the old catch-all answer', async () => {
  const db = await freshDb();
  let zone = { ...ZONE };
  const query = async (t, n) => fakeDns(zone).query(t, n);
  const c1 = makeDomainChecker({ db, query, withAge: false });
  await c1.catchAll('goodco.com', { providers: { isCatchAll: async () => true } });
  await db.query(`update email_domains set expires_at = now() - interval '1 second' where domain = 'goodco.com'`);
  zone = { ...ZONE, 'goodco.com': { MX: mx('mxa-001.gateco.pphosted.com'), NS: ['ns1.cloudflare.com'] } };
  await makeDomainChecker({ db, query, withAge: false }).check('goodco.com');
  const r = await db.one(`select provider, is_catch_all, catch_all_source from email_domains where domain = 'goodco.com'`);
  assert.deepEqual(r, { provider: 'proofpoint', is_catch_all: null, catch_all_source: null });
});

test('#10 #15 a cached address answer is dropped when its domain dies; a weak domain costs no paid check', async () => {
  const db = await freshDb();
  let zone = { ...ZONE };
  const query = async (t, n) => fakeDns(zone).query(t, n);
  const paid = [];
  const providers = { isCatchAll: async () => false, verify: async ({ email }) => { paid.push(email); return { tool: 'millionverifier', result: 'valid' }; } };
  const v = (e, c) => verifyAddress(e, { checker: c, providers, db });
  assert.equal((await v('joe@goodco.com', makeDomainChecker({ db, query, withAge: false }))).status, 'valid');
  await db.query(`update email_domains set expires_at = now() - interval '1 second'`);
  zone = { ...ZONE, 'goodco.com': 'nxdomain' };
  assert.equal((await v('joe@goodco.com', makeDomainChecker({ db, query, withAge: false }))).status, 'dead_domain');
  const weak = await v('ann@webonly.com', makeDomainChecker({ db, query, withAge: false }));
  assert.equal(weak.status, 'unknown'); assert.equal(weak.substatus, 'no_mx');
  assert.deepEqual(paid, ['joe@goodco.com'], 'no paid check on the dead or the weak domain');
});

test('#12 #13 disposable is the exact domain; the age counts as checked only when RDAP answered', async () => {
  assert.equal(addressFlags('joe@mail.goodco.com').is_disposable, false);
  assert.equal(addressFlags('joe@mailinator.com').is_disposable, true);
  const db = await freshDb();
  const { query } = fakeDns(ZONE);
  await makeDomainChecker({ db, query, rdap: async () => null }).check('goodco.com');
  assert.equal((await db.one(`select age_checked_at from email_domains where domain = 'goodco.com'`)).age_checked_at, null);
});

test('verify-list: every row kept, one answer per address, the paid check only where needed', async () => {
  const { mkdtempSync, writeFileSync: wf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { runVerifyList } = await import('../src/verifylist.mjs');
  const { parseCsv } = await import('../src/csv.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'vl-')); const input = join(dir, 'l.csv');
  wf(input, 'name,email\nJoe,joe@goodco.com\nJoe again,JOE@goodco.com\nDead,x@baggagenanny.com\nTemp,a@mailinator.com\nNone,\n');
  const { query } = fakeDns(ZONE);
  const paid = [];
  const providers = { isCatchAll: async () => false, verify: async ({ email }) => { paid.push(email); return { tool: 'millionverifier', result: 'valid' }; } };
  const r = await runVerifyList({ input, checker: makeDomainChecker({ query, withAge: false }), providers, concurrency: 1 });
  assert.equal(r.rows, 5); assert.equal(r.unique_addresses, 3);
  assert.deepEqual(paid, ['joe@goodco.com'], 'one paid check, for the one address the free checks could not decide');
  const [h, ...rows] = parseCsv(readFileSync(r.file, 'utf8'));
  assert.deepEqual(rows.map((x) => x[h.indexOf('verify_status')]), ['valid', 'valid', 'dead_domain', 'disposable', '']);
});

test('the website check: live, a bot wall is not down, an error page, a for-sale page, a redirect to another firm', async () => {
  const { websiteVerdict } = await import('../src/domaincheck.mjs');
  const w = (p) => websiteVerdict({ finalUrl: 'https://goodco.com/', ...p }, 'goodco.com');
  assert.equal(w({ status: 200, html: '<h1>Good Co plumbing</h1>' }).website_status, 'live');
  assert.equal(w({ status: 403, html: 'Attention Required! | Cloudflare' }).website_status, 'blocked', 'a bot wall is a live site');
  assert.equal(w({ status: 0 }).website_status, 'down');
  assert.equal(w({ status: 404 }).website_status, 'error');
  assert.equal(w({ status: 200, html: 'This domain is for sale! Buy this domain today' }).website_status, 'for_sale');
  assert.deepEqual(w({ status: 200, html: 'ok', finalUrl: 'https://www.bigbuyer.com/locations' }), { website_status: 'live', website_redirects_to: 'bigbuyer.com' });
  assert.equal(w({ status: 200, html: 'ok', finalUrl: 'https://www.goodco.com/home' }).website_redirects_to, null);
});

test('the index check: Common Crawl first (free); the paid Google search only when it never saw the domain; cached', async () => {
  const db = await freshDb();
  const { query } = fakeDns(ZONE);
  const seen = { 'goodco.com': true, 'msco.com': false, 'gateco.com': null };
  const searches = [];
  const providers = { googleIndexed: async ({ domain }) => { searches.push(domain); return { indexed: domain === 'msco.com', results: domain === 'msco.com' ? 4 : 0 }; } };
  const checker = makeDomainChecker({ db, query, withAge: false, crawlSeen: async (d) => seen[d] });
  assert.deepEqual(await checker.indexed('goodco.com', { providers }), { google_indexed: true, google_source: 'commoncrawl' });
  assert.deepEqual(await checker.indexed('msco.com', { providers }), { google_indexed: true, google_source: 'serper' });
  assert.deepEqual(await checker.indexed('gateco.com', { providers }), { google_indexed: false, google_source: 'serper' }, 'no Common Crawl answer: Google decides');
  assert.equal((await checker.indexed('baggagenanny.com', { providers })).google_source, 'not checked: no live domain');
  const again = makeDomainChecker({ db, query, withAge: false, crawlSeen: async () => { throw new Error('must not be asked'); } });
  assert.equal((await again.indexed('msco.com', { providers })).google_source, 'cached (serper)');
  assert.deepEqual(searches, ['msco.com', 'gateco.com'], 'one paid search each, none for the crawled, dead or cached ones');
  const free = makeDomainChecker({ query, withAge: false, crawlSeen: async () => false });
  assert.equal((await free.indexed('goodco.com')).google_source, 'commoncrawl: not seen (no paid search)', 'no providers: nothing paid');
});

test('the website check is cached and skipped for a domain with no DNS', async () => {
  const db = await freshDb();
  const { query } = fakeDns(ZONE);
  let probes = 0;
  const checker = makeDomainChecker({ db, query, withAge: false, probe: async () => { probes++; return { status: 200, html: 'ok', finalUrl: 'https://goodco.com/' }; } });
  assert.equal((await checker.website('goodco.com')).website_status, 'live');
  assert.equal((await checker.website('baggagenanny.com')).website_status, 'down');
  const again = makeDomainChecker({ db, query, withAge: false, probe: async () => { probes++; return { status: 0 }; } });
  assert.equal((await again.website('goodco.com')).source, 'cached');
  assert.equal(probes, 1);
});
