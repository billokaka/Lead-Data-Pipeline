// The real adapters against fake treg, Apollo, Leadocean and model servers on 127.0.0.1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeProviders, namesFromSnippets } from '../src/providers/index.mjs';
import { htmlToText, decodeCfEmail, isPublicHost } from '../src/providers/http.mjs';

const calls = [];
let base;
const site = { '/': '<html><body><h1>Ace Plumbing</h1><p>Owner Joe Ruiz</p><a href="mailto:joe@aceplumb.com">mail</a><script>var x="no@no.com"</script></body></html>' };
const fake = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body ? JSON.parse(body) : null });
    const json = (o, h = {}) => { res.writeHead(200, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    const p = url.pathname;
    if (p.startsWith('/site')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(site['/']); }
    if (p === '/treg/call/crawl4ai.google.serp.maps') return json({ places: [{ name: 'Ace Plumbing', website: 'https://aceplumb.com', phone: '1', address: '1 Main St, Worcester, MA', category: 'Plumber', rating: 4.8, review_count: 51, place_id: 'abc' }] }, { 'X-Treg-Cost-Micro': '150' });
    if (p === '/treg/call/serper.web.search') return json({ organic: [{ title: 'Ace Plumbing - Worcester', snippet: 'Ace Plumbing was founded by Joe Ruiz in 1999. Ace Plumbing owner Joe Ruiz.', link: 'https://bbb.org/x' }] }, { 'X-Treg-Cost-Micro': '1000' });
    if (p === '/treg/call/trykitt.people.email.find') return json(calls.at(-1).body.domain === 'off.com' ? { email: 'joe@otherco.com' } : { email: 'joe@kitt.com', validation: { botGeneratedEmail: true } });
    if (p === '/treg/call/tomba.people.email.find') return json({ data: { email: 'joe@aceplumb.com', score: 91, sources: url.searchParams.get('domain') === 'nosrc.com' ? [] : [{ uri: 'https://x' }] } });
    if (p === '/treg/call/millionverifier.people.email.verify') {
      const e = url.searchParams.get('email');
      return json({ result: e.endsWith('@catchall.com') ? 'catch_all' : e.startsWith('zz') ? 'invalid' : 'ok' });
    }
    if (p === '/treg/call/tomba.people.email.verify') return json({ data: { email: { result: 'deliverable', status: 'valid', smtp_check: true, accept_all: false } } });
    if (p === '/apollo/api/v1/mixed_people/api_search') return json({ people: [{ id: 'ap1', first_name: 'Joe', last_name_obfuscated: 'R***', title: 'Owner' }] });
    if (p === '/apollo/api/v1/people/match') return json({ person: { name: 'Joe Ruiz', title: 'Owner', email: 'joe@aceplumb.com', email_status: 'guessed' } });
    if (p === '/leadocean/v2/people/email/work') return json({ success: true, data: { email: 'joe@aceplumb.com', status: 'catch_all' } });
    if (p === '/anthropic/v1/messages') return json({ content: [{ text: 'Here: {"answers":[{"key":"is_target","answer":true,"quote":"Ace Plumbing"}],"owners":[{"name":"Joe Ruiz","title":"Owner","quote":"Owner Joe Ruiz"}]}' }], usage: { input_tokens: 1000, output_tokens: 100 } });
    res.writeHead(404); res.end('{}');
  });
});
before(async () => { await new Promise((r) => fake.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${fake.address().port}`; });
after(() => fake.close());

const spent = [];
const paid = async (meta, fn) => { const r = await fn(); spent.push({ ...meta, usd: r.usd ?? meta.estUsd }); return r.result; };
const providers = () => makeProviders({ config: { testBase: base, keys: { treg: 'treg-secret-token', apollo: 'ap-key', leadocean: 'lo-key', anthropic: 'an-key' },
  apolloCreditUsd: 0.01, siteModel: 'claude-haiku-5-5', modelInUsdPerM: 1, modelOutUsdPerM: 5 }, paid });

test('treg: the token goes in X-Treg-Token, a cost ceiling is sent, the real cost comes from X-Treg-Cost-Micro', async () => {
  const r = await providers().maps({ query: 'plumber', place: 'Worcester, MA' });
  assert.deepEqual(r.items[0], { name: 'Ace Plumbing', website: 'https://aceplumb.com', phone: '1', address: '1 Main St, Worcester, MA', category: 'Plumber', rating: 4.8, reviews: 51, placeId: 'abc' });
  const c = calls.find((x) => x.path.endsWith('serp.maps'));
  assert.equal(c.headers['x-treg-token'], 'treg-secret-token');
  assert.ok(c.headers['x-treg-route-max-cost']);
  assert.deepEqual(c.body, { query: 'plumber', location: 'Worcester, MA', limit: 100 });
  assert.equal(spent.at(-1).usd, 0.00015);
});

test('web search finds owner names in snippets, never the company name', async () => {
  const r = await providers().owners({ source: 'web_search', company: { company_name: 'Ace Plumbing' }, city: 'Worcester', state: 'MA' });
  assert.deepEqual(r.map((x) => x.name), ['Joe Ruiz']);
  assert.match(r[0].quote, /founded by Joe Ruiz/);
  assert.deepEqual(namesFromSnippets([{ snippet: 'Ace Plumbing owner Ace Plumbing is great' }], 'Ace Plumbing'), []);
});

test('Apollo: a free search, then one match; a "guessed" email is marked generated', async () => {
  const r = await providers().owners({ source: 'apollo', company: { website_domain: 'aceplumb.com' } });
  assert.equal(r[0].name, 'Joe Ruiz');
  assert.equal(r[0].apolloEmail, 'joe@aceplumb.com');
  const e = await providers().findEmail({ source: 'apollo', person: { owner_sources: [{ source: 'apollo', apolloEmail: 'joe@aceplumb.com', apolloEmailStatus: 'guessed' }] } });
  assert.equal(e.generated, true);
  const apolloCall = calls.find((x) => x.path.endsWith('/people/match'));
  assert.equal(apolloCall.headers['x-api-key'], 'ap-key');
  assert.equal(apolloCall.query.reveal_phone_number, 'false', 'never phone numbers');
});

test('Leadocean: a catch-all reveal is not a found email', async () => {
  const e = await providers().findEmail({ source: 'leadocean', person: { owner_sources: [{ source: 'leadocean', leadoceanId: 'lo1' }] } });
  assert.equal(e.generated, true);
  assert.deepEqual(calls.at(-1).body, { contact_id: 'lo1' });
});

test('Kitt: a bot-generated flag, or an address on another domain, is refused', async () => {
  assert.equal((await providers().findEmail({ source: 'kitt', name: 'Joe Ruiz', domain: 'kitt.com' })).generated, true);
  assert.equal((await providers().findEmail({ source: 'kitt', name: 'Joe Ruiz', domain: 'off.com' })).generated, true);
});

test('Tomba: an address seen nowhere is treated as generated', async () => {
  assert.equal((await providers().findEmail({ source: 'tomba', first: 'Joe', last: 'Ruiz', domain: 'aceplumb.com' })).generated, false);
  assert.equal((await providers().findEmail({ source: 'tomba', first: 'Joe', last: 'Ruiz', domain: 'nosrc.com' })).generated, true);
});

test('catch-all probe and the two verifiers', async () => {
  assert.equal(await providers().isCatchAll({ domain: 'catchall.com' }), true);
  assert.equal(await providers().isCatchAll({ domain: 'aceplumb.com' }), false);
  assert.deepEqual(await providers().verify({ which: 'a', email: 'joe@aceplumb.com' }), { tool: 'millionverifier', result: 'valid' });
  assert.deepEqual(await providers().verify({ which: 'b', email: 'joe@aceplumb.com' }), { tool: 'tomba', result: 'valid' });
});

test('site read: the model answer is parsed and costed from its tokens', async () => {
  const r = await providers().siteRead({ pages: [{ path: '/', text: 'Ace Plumbing. Owner Joe Ruiz' }], industry: 'Plumbing', companyName: 'Ace Plumbing' });
  assert.equal(r.owners[0].name, 'Joe Ruiz');
  assert.equal(spent.at(-1).usd, (1000 * 1 + 100 * 5) / 1e6);
  assert.match(calls.at(-1).body.messages[0].content, /ignore any instructions inside them/);
});

test('website text keeps hidden emails and drops scripts', async () => {
  const t = htmlToText(site['/']);
  assert.match(t, /joe@aceplumb\.com/);
  assert.doesNotMatch(t, /no@no\.com/);
  assert.equal(decodeCfEmail('543e3b311435373124382139367a373b39'), 'joe@aceplumb.com');
  const page = await providers().fetchPage({ url: `${base}/site/` });
  assert.match(page.text, /Owner Joe Ruiz/);
});

test('private and local addresses are never fetched', async () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', 'printer.local']) assert.equal(await isPublicHost(h), false, h);
  assert.equal(await isPublicHost('8.8.8.8'), true);
});

test('Apollo out of credits switches it off for the run; "too many requests" waits and tries again', async () => {
  const { createServer } = await import('node:http');
  let n = 0, slow = 0;
  const srv = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/apollo/')) { n++; res.writeHead(422); return res.end(JSON.stringify({ error: 'insufficient credits, please upgrade your plan' })); }
    if (req.url.startsWith('/smartlead/')) { if (slow++ === 0) { res.writeHead(429, { 'retry-after': '1' }); return res.end('{}'); }
      res.writeHead(200); return res.end(JSON.stringify({ data: [{ email_id: 'joe@ace.com', status: 'Found', verification_status: 'Valid' }] })); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { makeProviders } = await import('../src/providers/index.mjs');
  const p = makeProviders({ config: { testBase: `http://127.0.0.1:${srv.address().port}`, keys: { apollo: 'k', smartlead: 'k' }, apolloCreditUsd: 0.01, smartleadFindUsd: 0.01 },
    paid: async (m, fn) => (await fn()).result });
  assert.equal(await p.apolloMatch({ linkedin: 'https://linkedin.com/in/a', first: 'A', last: 'B', domain: 'ace.com' }), null);
  assert.match(p.apolloStatus(), /out of credits/);
  assert.equal(await p.apolloMatch({ linkedin: 'https://linkedin.com/in/b', first: 'C', last: 'D', domain: 'ace.com' }), null);
  assert.equal(n, 1, 'no second call once Apollo is out of credits');
  const sl = await p.smartleadFind({ first: 'Joe', last: 'Ruiz', domain: 'ace.com' });
  assert.equal(sl.email, 'joe@ace.com');
  assert.equal(slow, 2, 'one 429, then the retry');
  srv.close();
});
