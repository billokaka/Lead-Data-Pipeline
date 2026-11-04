// http.mjs: the only network code. Every call has a timeout, refuses redirects to another host, never logs a key,
// and (for a company's own website) refuses private and local addresses, so a provider row pointing at
// http://192.168.1.1 or localhost cannot make the engine read this machine's network.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

const BASES = {
  treg: 'https://treg.to',
  apollo: 'https://api.apollo.io',
  leadocean: 'https://api.leadocean.io',
  lemlist: 'https://api.lemlist.com',
  smartlead: 'https://prospect-api.smartlead.ai',
  serper: 'https://google.serper.dev',
  openrouter: 'https://openrouter.ai',
  anthropic: 'https://api.anthropic.com',
};

// in tests every service is the loopback fake: http://127.0.0.1:<port>/<service>
export const baseUrl = (config, service) => (config.testBase ? `${config.testBase}/${service}` : BASES[service]);

export class HttpError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// JSON over HTTP; returns { status, body, headers }. A 429 or 5xx answer is retried (the provider did not do the work
// and failed calls are free). A network error is retried only for GET: a POST may have reached the provider and been
// charged even though the answer was lost, so it is never sent twice.
export async function call(url, { method = 'GET', headers = {}, body, timeoutMs = 45000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (method === 'GET' && attempt < retries) { await sleep(1500 * (attempt + 1)); continue; }
      throw new HttpError(0, `network: ${e?.cause?.code ?? e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 2000 * (attempt + 1));
      continue;
    }
    const raw = await res.text();
    let parsed; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
    return { status: res.status, body: parsed, headers: res.headers };
  }
}

// ---- reading a company's own website ------------------------------------------------------------------
// private, local and special addresses, in IPv4 and the IPv6 forms that point at them
function isPrivateAddress(address) {
  let a = String(address).toLowerCase();
  const mapped = a.match(/^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) a = mapped[1];
  const hexMapped = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) { const n = (parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16); a = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168)
      || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || /^64:ff9b:/.test(a);
}

export async function isPublicHost(hostname) {
  if (!hostname || /^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(hostname)) return false;
  const h = hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(h) ? [{ address: h }] : await lookup(h, { all: true }).catch(() => []);
  return addrs.length > 0 && addrs.every((x) => !isPrivateAddress(x.address));
}

const MAX_BYTES = 1_500_000;

// the address is checked at the moment of connecting (the lookup the socket uses), so a name that answers with a public
// address to the check and a private one to the connection (DNS rebinding) cannot get through
function guardedLookup(hostname, options, cb) {
  lookup(hostname, { all: true, family: options?.family ?? 0 }).then((addrs) => {
    const bad = addrs.find((x) => isPrivateAddress(x.address));
    if (!addrs.length || bad) return cb(Object.assign(new Error(`blocked address for ${hostname}`), { code: 'EBLOCKED' }));
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  }, (e) => cb(e));
}

function getOnce(u, { timeoutMs, allowLoopback }) {
  return new Promise((resolve) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', timeout: timeoutMs, lookup: allowLoopback ? undefined : guardedLookup,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WraithResearch/1.0)', Accept: 'text/html,application/xhtml+xml' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location }); }
      if (res.statusCode !== 200 || !/text\/html|xhtml/i.test(res.headers['content-type'] ?? 'text/html')) { res.resume(); return resolve(null); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { chunks.push(c.subarray(0, c.length - (size - MAX_BYTES))); res.destroy(); } else chunks.push(c); });
      res.on('close', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve(chunks.length ? { html: Buffer.concat(chunks).toString('utf8') } : null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

// is the firm's website there at all (the domain pre-filter, 2026-11-03)? Unlike fetchSitePage it keeps the answer
// it got: the status, where redirects ended, the start of the page. A refused connection or a timeout is
// { status: 0 }; a bot wall (401, 403, 429, 503) is reported as such, never as "down". Public addresses only.
function statusOnce(u, { timeoutMs }) {
  return new Promise((resolve) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', timeout: timeoutMs, lookup: guardedLookup,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WraithResearch/1.0)', Accept: 'text/html,application/xhtml+xml' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return resolve({ status, redirect: res.headers.location }); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; chunks.push(c); if (size > 65536) res.destroy(); });
      res.on('close', () => resolve({ status, server: String(res.headers.server ?? ''), html: Buffer.concat(chunks).toString('utf8').slice(0, 65536) }));
      res.on('error', () => resolve({ status, html: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: String(e.code ?? e.message) }));
    req.end();
  });
}
export async function probeSite(domain, { timeoutMs = 8000 } = {}) {
  let last = null;
  for (const scheme of ['https', 'http']) {
    let u;
    try { u = new URL(`${scheme}://${domain}/`); } catch { return { status: 0, error: 'bad url' }; }
    for (let hop = 0; hop < 5; hop++) {
      if (!(await isPublicHost(u.hostname))) return { status: 0, error: 'not a public address', finalUrl: u.href };
      const r = await statusOnce(u, { timeoutMs });
      if (r.redirect) { try { u = new URL(r.redirect, u); } catch { break; } continue; }
      last = { ...r, finalUrl: u.href };
      break;
    }
    if (last && last.status) return last;
  }
  return last ?? { status: 0, error: 'no answer' };
}

// fetches one page of a company's site; null when it can't be read. Redirects are followed only to public addresses.
export async function fetchSitePage(url, { timeoutMs = 15000, allowLoopback = false } = {}) {
  let u;
  try { u = new URL(url); } catch { return null; }
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!allowLoopback && !(await isPublicHost(u.hostname))) return null;
    const r = await getOnce(u, { timeoutMs, allowLoopback });
    if (!r) return null;
    if (r.redirect) { try { u = new URL(r.redirect, u); } catch { return null; } continue; }
    return { url: u.href, html: r.html };
  }
  return null;
}

// ---- HTML to readable text, keeping the emails a page hides in links or behind Cloudflare --------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#64': '@', '#46': '.' };

export function decodeCfEmail(hex) {
  if (!/^[0-9a-f]{4,}$/i.test(hex)) return '';
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<a[^>]+href=["']mailto:([^"'?]+)[^>]*>/gi, ' $1 ')
    .replace(/data-cfemail=["']([0-9a-f]+)["']/gi, (_, h) => `> ${decodeCfEmail(h)} <`)
    .replace(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi, (_, h) => ` ${decodeCfEmail(h)} `)
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? (e.startsWith('#') ? String.fromCharCode(Number(e.slice(1))) : ' '))
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
