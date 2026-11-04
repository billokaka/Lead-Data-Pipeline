// domaincheck.mjs: the domain pre-filter and address verifier (operator, 2026-11-03; "Building the Verifier", stages
// 1, 2, 5-lite, 8 and 9). It finds, for free and before any money is spent, the companies whose domain cannot take
// mail: no DNS, DNS that refuses, a null MX, no MX, a parked domain, an MX host that is gone.
//   addressFlags(email)     stage 1: syntax, role, free, disposable, gibberish, alias, did_you_mean. No network.
//   makeDomainChecker(...)  stage 2: one domain's DNS facts and its verdict, through two public resolvers, cached.
//   catch-all               stage 5-lite: one paid treg MillionVerifier probe per live, non-gateway domain, cached;
//                           a gateway (Proofpoint, Mimecast...) accepts everything, so it is marked with no probe.
//   verifyAddress(...)      stages 8 and 9: flags, domain, catch-all, then one MillionVerifier check, cached.
// No SMTP is spoken from this machine: that needs the probe server (stages 3 to 7), which plugs in later.

import { readFileSync } from 'node:fs';
import { promises as dnsp } from 'node:dns';
import { domainToASCII } from 'node:url';
import { normEmail, looksLikeEmail, isRoleAddress, FREEMAIL, verdict as verifierVerdict } from './rules.mjs';
import { SpendRefused } from './money.mjs';
import { probeSite } from './providers/http.mjs';

const DATA = new URL('../data/', import.meta.url);
const PROVIDERS = JSON.parse(readFileSync(new URL('mx-providers.json', DATA), 'utf8')).providers;
const PARKING = JSON.parse(readFileSync(new URL('parking.json', DATA), 'utf8')).patterns;
const TYPOS = JSON.parse(readFileSync(new URL('typo-domains.json', DATA), 'utf8')).typos;
const DISPOSABLE = new Set(readFileSync(new URL('disposable-domains.txt', DATA), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')));

const DAY = 86400000;
// how long a domain answer stays fresh (doc stage 2 and ch. 2): a lapsed domain that comes back is noticed
// a dead answer is confirmed by both resolvers before it is given, and still kept only a week (a lapsed domain can come back)
export const TTL = { alive: 14 * DAY, weak: 7 * DAY, dead: 7 * DAY, unknown: DAY / 24, catch_all: 21 * DAY, age: 90 * DAY };

// ---- stage 1: the address alone ---------------------------------------------------------------------------------
export function addressFlags(raw) {
  const email = normEmail(String(raw ?? '').replace(/^mailto:/i, '').replace(/^<|>$/g, ''));
  const [local = '', domain = ''] = email.split('@');
  const syntax_ok = looksLikeEmail(email) && !email.includes('..') && local.length <= 64 && email.length <= 254;
  const digits = (local.match(/\d/g) ?? []).length;
  return {
    email, local, domain, syntax_ok,
    is_role: isRoleAddress(email),
    is_free: FREEMAIL.has(domain),
    // the exact domain only: a list entry never condemns another domain's subdomains
    is_disposable: DISPOSABLE.has(domain),
    is_gibberish: Boolean(local) && (!/[aeiouy]/i.test(local.replace(/[^a-z]/gi, '')) || digits / local.length > 0.4 || (local.length > 24 && !/[._-]/.test(local))),
    is_alias: local.includes('+'),
    did_you_mean: TYPOS[domain] ? `${local}@${TYPOS[domain]}` : null,
  };
}

export function providerOf(mxHosts) {
  for (const host of mxHosts ?? []) {
    const h = String(host).toLowerCase().replace(/\.$/, '');
    const p = PROVIDERS.find((x) => h === x.suffix || h.endsWith(`.${x.suffix}`));
    if (p) return { provider: p.provider, is_gateway: p.gateway };
  }
  return { provider: mxHosts?.length ? 'other' : 'none', is_gateway: false };
}
// a host on a parking service's domain: the host itself or one under it, never a fragment of a word
export const isParked = (names) => (names ?? []).some((n) => {
  const h = String(n).toLowerCase().replace(/\.$/, '');
  return PARKING.some((p) => h === p || h.endsWith(`.${p}`));
});

// ---- stage 2: one domain's DNS ------------------------------------------------------------------------------------
// the resolver answers one query; errors come back as codes, never thrown: ok, nodata, nxdomain, refused, servfail, timeout
export function nodeResolver({ servers = ['1.1.1.1', '8.8.8.8'], timeoutMs = 2000 } = {}) {
  const make = (s) => { const r = new dnsp.Resolver({ timeout: timeoutMs, tries: 1 }); r.setServers([s]); return r; };
  const rs = servers.map(make);
  const CODE = { ENOTFOUND: 'nxdomain', ENODATA: 'nodata', EREFUSED: 'refused', ESERVFAIL: 'servfail', ETIMEOUT: 'timeout', ECONNREFUSED: 'timeout', ECANCELLED: 'timeout' };
  const call = { MX: 'resolveMx', A: 'resolve4', AAAA: 'resolve6', NS: 'resolveNs', TXT: 'resolveTxt' };
  const ask = async (r, type, name) => { try { return { code: 'ok', answers: await r[call[type]](name) }; } catch (e) { return { code: CODE[e.code] ?? 'servfail', answers: [] }; } };
  return (type, name) => twoResolvers(() => ask(rs[0], type, name), rs[1] ? () => ask(rs[1], type, name) : null);
}
// a "does not exist" or "refused" is what marks a firm dead, so it is never taken from one resolver alone: the
// second must say the same (a rate limit or a stale answer on one resolver must not kill a live firm)
export async function twoResolvers(askFirst, askSecond) {
  const first = await askFirst();
  if (first.code === 'ok' || first.code === 'nodata' || !askSecond) return first;
  const second = await askSecond();
  if (second.code === 'ok' || second.code === 'nodata') return second;
  if (['nxdomain', 'refused'].includes(first.code)) return second.code === first.code ? first : { code: 'servfail', answers: [] };
  return second;
}

// the registrable domain under a website host: shop.acme.com -> acme.com, acme.co.uk stays (a short list of
// two-part endings; enough for US lists)
const TWO_PART = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'com.mx', 'co.in', 'co.jp', 'com.cn', 'com.sg']);
export function registrable(host) {
  const parts = String(host).split('.');
  const n = TWO_PART.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
}
// shared platforms: the "website" is a page on someone else's domain, which says nothing about the firm's mail
export const PLATFORMS = new Set(['facebook.com', 'fb.com', 'instagram.com', 'linkedin.com', 'yelp.com', 'google.com', 'business.site', 'sites.google.com',
  'wixsite.com', 'wix.com', 'squarespace.com', 'godaddysites.com', 'weebly.com', 'wordpress.com', 'blogspot.com', 'myshopify.com', 'square.site',
  'webflow.io', 'carrd.co', 'yolasite.com', 'jimdosite.com', 'mystrikingly.com', 'homestead.com', 'angi.com', 'houzz.com', 'nextdoor.com', 'bbb.org',
  'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'linktr.ee', 'thumbtack.com', 'porch.com', 'homeadvisor.com']);
export const onPlatform = (d) => PLATFORMS.has(d) || PLATFORMS.has(registrable(d));
export function normDomain(raw) {
  let d = String(raw ?? '').toLowerCase().trim().replace(/\.+$/, '');
  try { const a = domainToASCII(d); if (a) d = a; } catch { /* left as is */ }      // internationalised names -> punycode
  return d;
}

// domain age from RDAP (free; rdap.org sends the question to the right registry). Never blocks: null on any failure
export async function rdapRegistered(domain, { timeoutMs = 8000 } = {}) {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    const ev = (body?.events ?? []).find((e) => /^registration$/i.test(e.eventAction ?? ''));
    return ev?.eventDate ? ev.eventDate.slice(0, 10) : null;
  } catch { return null; }
}

// every fact the DNS gives about one domain, and the verdict (How Email Actually Works, ch. 2 and 9)
export async function lookupDomain(domain, { query, rdap = null, today = new Date(), hostMemo = new Map() } = {}) {
  const d = normDomain(domain);
  const facts = { domain: d, verdict: 'unknown', reason: null, dns_status: null, mx_hosts: [], mx_primary: null, provider: null, is_gateway: false,
    nameservers: [], has_spf: null, has_dmarc: null, registered_at: null, domain_age_days: null, recently_registered: null };
  const out = (verdict, dns_status, reason) => Object.assign(facts, { verdict, dns_status, reason });
  // not a domain name (a typo in the list, a URL fragment): unknown, never "dead", and never saved
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(d) || d.length > 253) return out('unknown', 'bad_domain', 'not a domain name');
  if (onPlatform(d)) return out('unknown', 'platform', 'the website is a page on a shared platform, not the firm\'s own domain');

  const mx = await query('MX', d);
  if (mx.code === 'nxdomain') return out('dead', 'nxdomain', 'the domain does not exist');
  if (mx.code === 'refused') return out('dead', 'refused', 'the domain\'s nameservers refuse to answer (DNS hosting lapsed)');
  if (mx.code === 'servfail' || mx.code === 'timeout') return out('unknown', mx.code, 'DNS did not answer; try again later');
  const hosts = mx.answers.slice().sort((a, b) => a.priority - b.priority).map((x) => String(x.exchange ?? '').toLowerCase().replace(/\.$/, ''));
  facts.mx_hosts = hosts.filter(Boolean);
  facts.mx_primary = facts.mx_hosts[0] ?? null;

  const [ns, txt, dmarc] = await Promise.all([query('NS', d), query('TXT', d), query('TXT', `_dmarc.${d}`)]);
  facts.nameservers = ns.answers.map((n) => String(n).toLowerCase().replace(/\.$/, ''));
  const flat = (r) => r.answers.map((a) => (Array.isArray(a) ? a.join('') : String(a)));
  facts.has_spf = txt.code === 'ok' ? flat(txt).some((t) => /^v=spf1/i.test(t.trim())) : txt.code === 'nodata' ? false : null;
  facts.has_dmarc = dmarc.code === 'ok' ? flat(dmarc).some((t) => /^v=dmarc1/i.test(t.trim())) : ['nodata', 'nxdomain'].includes(dmarc.code) ? false : null;
  Object.assign(facts, providerOf(facts.mx_hosts));

  if (rdap) {
    const reg = await rdap(d);
    if (reg) {
      facts.registered_at = reg;
      facts.domain_age_days = Math.max(0, Math.floor((today - new Date(reg)) / DAY));
      facts.recently_registered = facts.domain_age_days < 90;
    }
  }

  // null MX ("MX 0 ."): the domain says it takes no mail
  if (mx.code === 'ok' && hosts.length && hosts.every((h) => h === '' || h === '.')) return out('dead', 'null_mx', 'the domain says it takes no mail (null MX)');
  // parked: the MX is on a parking service, or the nameservers are and no known mail provider receives its mail
  // (a parking NS with a working Google or Microsoft MX still takes mail)
  const parkedNs = isParked(facts.nameservers);
  if (isParked(facts.mx_hosts) || (parkedNs && (facts.provider === 'other' || !facts.mx_hosts.length))) {
    return out('dead', 'parked', 'a parked or for-sale domain');
  }
  // an address is "there" when A or AAAA answers; it is "gone" only on a definite no for both
  const addressOf = async (h) => {
    if (hostMemo.has(h)) return hostMemo.get(h);
    const p = (async () => {
      const a = await query('A', h);
      if (a.code === 'ok' && a.answers.length) return 'there';
      const aaaa = await query('AAAA', h);
      if (aaaa.code === 'ok' && aaaa.answers.length) return 'there';
      return [a.code, aaaa.code].every((c) => c === 'nodata' || c === 'nxdomain') ? 'gone' : 'unsure';
    })();
    hostMemo.set(h, p);
    return p;
  };
  if (!facts.mx_hosts.length) {
    const at = await addressOf(d);
    if (at === 'there') return out('weak', 'no_mx', 'no MX record, only a website address: mail there rarely works');
    if (at === 'unsure') return out('unknown', 'no_mx_unsure', 'no MX, and the address lookup did not answer; try again later');
    return out('dead', 'no_mx', 'no MX and no address: nothing can receive mail');
  }
  // the MX hosts must themselves exist: every one is asked (the first that answers is enough), memoised across
  // domains so a shared host such as aspmx.l.google.com is looked up once a run
  let unsure = false;
  for (const h of facts.mx_hosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return out('alive', 'ok', null);
    const at = await addressOf(h);
    if (at === 'there') return out('alive', 'ok', null);
    if (at === 'unsure') unsure = true;
  }
  return unsure ? out('unknown', 'mx_unsure', 'the mail host did not answer DNS; try again later') : out('dead', 'mx_unresolved', 'the mail host named in the MX record does not exist');
}

// ---- the website and Google index checks (operator, 2026-11-03) ---------------------------------------------------
// Is there a site at all (free), and does the web know it: Common Crawl first (free, public), and a Google site:
// search through Serper (paid, about $0.001) only for a domain Common Crawl has never seen. Both are flags first:
// whether they remove anyone is decided on the 300-domain test.
const FOR_SALE = /(this|the) domain (name )?(is|may be) for sale|buy this domain|domain is parked|parked (free|domain)|this web ?page is parked|domain for sale|hugedomains|afternic|sedo\.com|dan\.com\/buy|godaddy\.com\/domainsearch|make an offer on this domain/i;
const BOT_WALL = new Set([401, 403, 406, 409, 429, 503]);
export function websiteVerdict(probe, domain) {
  const final = (() => { try { return new URL(probe.finalUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } })();
  const redirectsTo = final && registrable(final) !== registrable(domain) ? registrable(final) : null;
  if (!probe.status) return { website_status: 'down', website_redirects_to: redirectsTo };
  if (BOT_WALL.has(probe.status) || /cloudflare|captcha|attention required|just a moment/i.test(probe.html ?? '') && probe.status !== 200) return { website_status: 'blocked', website_redirects_to: redirectsTo };
  if (probe.status >= 400) return { website_status: 'error', website_redirects_to: redirectsTo };
  const text = String(probe.html ?? '').replace(/<[^>]+>/g, ' ').slice(0, 20000);
  if (FOR_SALE.test(text)) return { website_status: 'for_sale', website_redirects_to: redirectsTo };
  return { website_status: 'live', website_redirects_to: redirectsTo };
}

// Common Crawl's public index: was the domain crawled in one of the last few crawls? true, false, or null (no answer)
let crawlList = null;
export async function commonCrawlSeen(domain, { crawls = 3, timeoutMs = 20000 } = {}) {
  try {
    crawlList ??= (async () => (await (await fetch('https://index.commoncrawl.org/collinfo.json', { signal: AbortSignal.timeout(timeoutMs) })).json()).slice(0, crawls).map((c) => c['cdx-api']))();
    const apis = await crawlList;
    let answered = false;
    for (const api of apis) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`${api}?url=${encodeURIComponent(domain)}&matchType=domain&output=json&limit=1`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
        if (res?.status === 200) return true;
        if (res?.status === 404) { answered = true; break; }
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));      // 502, 503, a timeout: wait and ask again
      }
    }
    return answered ? false : null;
  } catch { crawlList = null; return null; }
}

// ---- the cache and the run ----------------------------------------------------------------------------------------
// db: the Supabase wrapper (query, one), or null to cache in memory only
// probe and crawlSeen are injected in tests; by default the real website probe and Common Crawl
export function makeDomainChecker({ db = null, query = nodeResolver(), rdap = rdapRegistered, withAge = true, now = () => new Date(), probe = probeSite, crawlSeen = commonCrawlSeen } = {}) {
  const memo = new Map();
  const inflight = new Map();                 // a domain being checked or probed right now: the second ask waits for it
  const hostMemo = new Map();
  let dnsLookups = 0;
  const counted = async (t, n) => { dnsLookups++; return query(t, n); };
  const ttlFor = (f) => TTL[f.verdict] ?? TTL.unknown;
  // never saved: an answer that says nothing about the firm (not a domain name, a shared platform page)
  const unsaved = (f) => ['bad_domain', 'platform'].includes(f.dns_status);

  async function cached(d) {
    if (memo.has(d)) return memo.get(d);
    if (!db) return null;
    const r = await db.one('select * from email_domains where domain = $1 and expires_at > now()', [d]);
    if (r) memo.set(d, r);
    return r;
  }
  async function save(f) {
    const t = now();
    // the age is "checked" only when RDAP answered; a failed or rate-limited RDAP is tried again next time
    const row = { ...f, checked_at: t.toISOString(), expires_at: new Date(t.getTime() + ttlFor(f)).toISOString(), age_checked_at: f.registered_at ? t.toISOString() : null };
    memo.set(f.domain, row);
    if (!db || unsaved(f)) return row;
    // a catch-all answer belongs to the domain as it was: a change of verdict, provider or gateway clears it
    const saved = await db.one(`insert into email_domains (domain, verdict, reason, dns_status, mx_hosts, mx_primary, provider, is_gateway, nameservers, has_spf, has_dmarc,
        registered_at, domain_age_days, recently_registered, checked_at, expires_at, age_checked_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      on conflict (domain) do update set verdict = excluded.verdict, reason = excluded.reason, dns_status = excluded.dns_status, mx_hosts = excluded.mx_hosts,
        mx_primary = excluded.mx_primary, provider = excluded.provider, is_gateway = excluded.is_gateway, nameservers = excluded.nameservers,
        has_spf = excluded.has_spf, has_dmarc = excluded.has_dmarc, registered_at = coalesce(excluded.registered_at, email_domains.registered_at),
        domain_age_days = coalesce(excluded.domain_age_days, email_domains.domain_age_days), recently_registered = coalesce(excluded.recently_registered, email_domains.recently_registered),
        checked_at = excluded.checked_at, expires_at = excluded.expires_at, age_checked_at = coalesce(excluded.age_checked_at, email_domains.age_checked_at),
        is_catch_all = case when (email_domains.verdict, email_domains.provider, email_domains.is_gateway) is distinct from (excluded.verdict, excluded.provider, excluded.is_gateway) then null else email_domains.is_catch_all end,
        catch_all_source = case when (email_domains.verdict, email_domains.provider, email_domains.is_gateway) is distinct from (excluded.verdict, excluded.provider, excluded.is_gateway) then null else email_domains.catch_all_source end,
        catch_all_checked_at = case when (email_domains.verdict, email_domains.provider, email_domains.is_gateway) is distinct from (excluded.verdict, excluded.provider, excluded.is_gateway) then null else email_domains.catch_all_checked_at end,
        catch_all_expires_at = case when (email_domains.verdict, email_domains.provider, email_domains.is_gateway) is distinct from (excluded.verdict, excluded.provider, excluded.is_gateway) then null else email_domains.catch_all_expires_at end,
        website_expires_at = case when email_domains.verdict is distinct from excluded.verdict then null else email_domains.website_expires_at end,
        google_expires_at = case when email_domains.verdict is distinct from excluded.verdict then null else email_domains.google_expires_at end
      returning *`,
      [f.domain, f.verdict, f.reason, f.dns_status, f.mx_hosts, f.mx_primary, f.provider, f.is_gateway, f.nameservers, f.has_spf, f.has_dmarc,
        f.registered_at, f.domain_age_days, f.recently_registered, row.checked_at, row.expires_at, row.age_checked_at]);
    memo.set(f.domain, saved);
    return saved;
  }
  const once = (key, fn) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  async function fresh(d) {
    const f = await lookupDomain(d, { query: counted, rdap: withAge ? rdap : null, today: now(), hostMemo });
    // a dead website host under a live firm's domain (shop.acme.com, www2.acme.com): the firm's own domain decides
    const root = registrable(f.domain);
    if (f.verdict === 'dead' && root !== f.domain) {
      const r = await lookupDomain(root, { query: counted, rdap: null, today: now(), hostMemo });
      if (r.verdict !== 'dead') return { ...r, domain: f.domain, reason: `${r.reason ?? 'the firm\'s own domain takes mail'} (checked ${root}: the website host ${f.domain} itself has no DNS)` };
    }
    return f;
  }

  return {
    get dnsLookups() { return dnsLookups; },
    // one domain: from the cache while fresh, else from DNS (and RDAP), saved. Never throws: a failure is "unknown"
    async check(domain) {
      const d = normDomain(domain);
      const hit = await cached(d);
      if (hit) return { ...hit, source: 'cached' };
      return once(`dns:${d}`, async () => {
        try { return { ...(await save(await fresh(d))), source: 'live' }; }
        catch (e) { return { domain: d, verdict: 'unknown', dns_status: 'error', reason: `the check failed: ${String(e.message).slice(0, 120)}`, source: 'live' }; }
      });
    },
    // is there a website at all (free, one request, cached 14 days)
    async website(domain) {
      const f = await this.check(domain);
      if (f.website_expires_at && new Date(f.website_expires_at) > now()) return { website_status: f.website_status, website_redirects_to: f.website_redirects_to, source: 'cached' };
      if (['bad_domain', 'platform'].includes(f.dns_status) || f.dns_status === 'nxdomain' || f.dns_status === 'refused') return { website_status: 'down', website_redirects_to: null, source: 'no DNS' };
      return once(`web:${f.domain}`, async () => {
        const w = websiteVerdict(await probe(f.domain), f.domain);
        const t = now(), row = { ...f, ...w, website_checked_at: t.toISOString(), website_expires_at: new Date(t.getTime() + TTL.alive).toISOString() };
        memo.set(f.domain, row);
        if (db && !unsaved(f)) await db.query(`update email_domains set website_status = $2, website_redirects_to = $3, website_checked_at = $4, website_expires_at = $5 where domain = $1`,
          [f.domain, w.website_status, w.website_redirects_to, row.website_checked_at, row.website_expires_at]);
        return { ...w, source: 'live' };
      });
    },
    // does the web know the site: Common Crawl (free) first; a Google site: search (paid) only when Common Crawl has
    // never seen it, and only with providers given. Cached 30 days ("undecided" 3 days); one paid search per domain
    async indexed(domain, { providers = null, jobId = null } = {}) {
      const f = await this.check(domain);
      if (f.google_expires_at && new Date(f.google_expires_at) > now() && f.google_source !== 'probing') return { google_indexed: f.google_indexed ?? null, google_source: `cached (${f.google_source})` };
      if (['bad_domain', 'platform'].includes(f.dns_status) || f.verdict === 'dead') return { google_indexed: null, google_source: 'not checked: no live domain' };
      return once(`idx:${f.domain}`, async () => {
        let value = null, results = null, source, ttl = 30 * DAY;
        const seen = await crawlSeen(f.domain);
        if (seen === true) { value = true; source = 'commoncrawl'; }
        else if (providers?.googleIndexed) {
          if (db) {
            const claim = await db.one(`update email_domains set google_source = 'probing', google_expires_at = now() + interval '10 minutes'
              where domain = $1 and (google_expires_at is null or google_expires_at < now()) returning domain`, [f.domain]);
            if (!claim) return { google_indexed: null, google_source: 'being checked by another run' };
          }
          let g;
          try { g = await providers.googleIndexed({ domain: f.domain, jobId }); }
          catch (e) { if (db) await db.query(`update email_domains set google_source = null, google_expires_at = null where domain = $1 and google_source = 'probing'`, [f.domain]); throw e; }
          if (g && typeof g.indexed === 'boolean') { value = g.indexed; results = g.results; source = 'serper'; }
          else { source = 'undecided'; ttl = 3 * DAY; }
        } else { source = seen === false ? 'commoncrawl: not seen (no paid search)' : 'undecided'; ttl = seen === false ? 30 * DAY : 3 * DAY; }
        const t = now(), row = { ...f, google_indexed: value, google_results: results, google_source: source, google_checked_at: t.toISOString(), google_expires_at: new Date(t.getTime() + ttl).toISOString() };
        memo.set(f.domain, row);
        if (db && !unsaved(f)) await db.query(`update email_domains set google_indexed = $2, google_results = $3, google_source = $4, google_checked_at = $5, google_expires_at = $6 where domain = $1`,
          [f.domain, value, results, source, row.google_checked_at, row.google_expires_at]);
        return { google_indexed: value, google_source: source };
      });
    },
    // stage 5-lite: is the domain catch-all? Only for a live domain; a gateway is marked with no probe. The answer is
    // cached 21 days, "undecided" 3 days, so a flaky domain is not paid for again and again. One probe at a time per
    // domain in this run (inflight), and across runs and machines a short claim in the table decides who pays
    async catchAll(domain, { providers, jobId = null } = {}) {
      const f = await this.check(domain);
      if (f.verdict !== 'alive') return { is_catch_all: null, source: 'not probed: the domain is not alive' };
      const fresh = (r) => r?.catch_all_expires_at && new Date(r.catch_all_expires_at) > now() && r.catch_all_source !== 'probing';
      if (fresh(f)) return { is_catch_all: f.is_catch_all ?? null, source: `cached (${f.catch_all_source})` };
      return once(`ca:${f.domain}`, async () => {
        const t = now();
        let value, source, ttl = TTL.catch_all;
        if (f.is_gateway) { value = true; source = 'gateway'; }
        else {
          if (db) {
            const claim = await db.one(`update email_domains set catch_all_source = 'probing', catch_all_expires_at = now() + interval '10 minutes'
              where domain = $1 and (catch_all_expires_at is null or catch_all_expires_at < now()) returning domain`, [f.domain]);
            if (!claim) {
              const r = await db.one('select * from email_domains where domain = $1', [f.domain]);
              memo.set(f.domain, r);
              return fresh(r) ? { is_catch_all: r.is_catch_all ?? null, source: `cached (${r.catch_all_source})` } : { is_catch_all: null, source: 'being probed by another run' };
            }
          }
          try { value = await providers.isCatchAll({ domain: f.domain, jobId }); }
          catch (e) {
            if (db) await db.query(`update email_domains set catch_all_source = null, catch_all_expires_at = null where domain = $1 and catch_all_source = 'probing'`, [f.domain]);
            throw e;
          }
          if (value === true || value === false) source = 'millionverifier';
          else { value = null; source = 'undecided'; ttl = 3 * DAY; }
        }
        const row = { ...f, is_catch_all: value, catch_all_source: source, catch_all_checked_at: t.toISOString(), catch_all_expires_at: new Date(t.getTime() + ttl).toISOString() };
        memo.set(f.domain, row);
        if (db) await db.query(`update email_domains set is_catch_all = $2, catch_all_source = $3, catch_all_checked_at = $4, catch_all_expires_at = $5 where domain = $1`,
          [f.domain, value, source, row.catch_all_checked_at, row.catch_all_expires_at]);
        return { is_catch_all: value, source };
      });
    },
  };
}

// many domains at once, `concurrency` in flight; returns domain -> facts. One domain's failure never stops the run
export async function checkDomains(domains, checker, { concurrency = 50, log = () => {} } = {}) {
  const list = [...new Set(domains.filter(Boolean).map((d) => normDomain(d)))];
  const out = new Map(), queue = [...list];
  let n = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, async () => {
    while (queue.length) {
      const d = queue.shift();
      out.set(d, await checker.check(d));
      if (++n % 250 === 0) log(`${n} of ${list.length} domains checked`);
    }
  }));
  return out;
}

// ---- stages 8 and 9: one existing address ------------------------------------------------------------------------
const CHECK_TTL = { valid: 30 * DAY, invalid: 14 * DAY, catch_all: 21 * DAY, unknown: 3 * DAY, dead_domain: 7 * DAY, bad_syntax: 365 * DAY, disposable: 365 * DAY };
const QUALITY = { valid: 'good', catch_all: 'risky', unknown: 'risky', invalid: 'bad', dead_domain: 'bad', bad_syntax: 'bad', disposable: 'bad' };

export async function verifyAddress(raw, { checker, providers, db = null, jobId = null, now = () => new Date() }) {
  const flags = addressFlags(raw);
  const done = (status, substatus, checked_by = null) => ({ ...flags, status, quality: QUALITY[status], substatus, checked_by });
  const save = async (r) => {
    if (db && r.email) {
      const t = now();
      await db.query(`insert into email_checks (email, status, quality, substatus, checked_by, checked_at, expires_at) values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (email) do update set status = excluded.status, quality = excluded.quality, substatus = excluded.substatus, checked_by = excluded.checked_by,
          checked_at = excluded.checked_at, expires_at = excluded.expires_at`,
        [r.email, r.status, r.quality, r.substatus, r.checked_by, t.toISOString(), new Date(t.getTime() + CHECK_TTL[r.status]).toISOString()]);
    }
    return r;
  };
  if (!flags.syntax_ok) return save(done('bad_syntax', 'bad_syntax'));
  if (flags.is_disposable) return save(done('disposable', 'disposable'));
  // the domain first (free, cached): a cached address answer stands only while its domain still agrees with it
  const dom = await checker.check(flags.domain);
  if (db) {
    const hit = await db.one('select * from email_checks where email = $1 and expires_at > now()', [flags.email]);
    const agrees = hit && (hit.status === 'dead_domain') === (dom.verdict === 'dead');
    if (agrees) return { ...flags, status: hit.status, quality: hit.quality, substatus: hit.substatus, checked_by: hit.checked_by, source: 'cached' };
  }
  if (dom.verdict === 'dead') return save(done('dead_domain', dom.dns_status));
  if (dom.verdict === 'unknown') return done('unknown', 'dns_unknown');      // not cached: try again soon
  // no MX, only a website address: mail there rarely works, and a paid check would be money for nothing
  if (dom.verdict === 'weak') return save(done('unknown', 'no_mx'));
  if (!flags.is_free) {
    const ca = await checker.catchAll(flags.domain, { providers, jobId });
    if (ca.is_catch_all === true) return save(done('catch_all', ca.source === 'gateway' ? 'gateway' : 'catch_all_unresolved', ca.source));
  }
  const a = await providers.verify({ which: 'a', email: flags.email, jobId });
  const v = verifierVerdict(a?.result);
  const status = v === 'valid' ? 'valid' : v === 'invalid' ? 'invalid' : v === 'catch_all' ? 'catch_all' : 'unknown';
  return save(done(status, v === 'invalid' ? 'mailbox_not_found' : v === 'unknown' ? 'verifier_unknown' : null, `${a?.tool ?? 'millionverifier'}:${a?.result ?? '?'}`));
}

export { SpendRefused };
