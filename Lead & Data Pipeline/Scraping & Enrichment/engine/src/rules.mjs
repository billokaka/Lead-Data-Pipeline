// rules.mjs: the decisions the engine makes about people and emails, in one place, with no network.
// Each rule here is a workspace rule (DECISIONS.md D6-1, D9-1, D9-2; playbooks/data-management-enrichment.md §3).

// ---- names ------------------------------------------------------------------------------------------
const STRIP = /\b(mr|mrs|ms|dr|jr|sr|ii|iii|iv|phd|md|esq|cpa|pe)\.?\b/gi;

export function normName(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // José -> Jose
    .replace(STRIP, ' ').replace(/[^a-zA-Z\s'-]/g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

// "Mike O'Brien Jr." -> { first: 'mike', last: 'obrien' } for emails; null when there is no usable first name
export function splitName(full) {
  const parts = normName(full).split(' ').filter(Boolean);
  if (!parts.length) return null;
  const clean = (p) => p.replace(/['-]/g, '');
  return { first: clean(parts[0]), last: parts.length > 1 ? clean(parts[parts.length - 1]) : '' };
}

export function sameName(a, b) {
  const x = splitName(a), y = splitName(b);
  if (!x || !y || !x.last || !y.last) return false;
  if (x.last !== y.last) return false;
  // Bob and Robert are not matched; a first initial matches its full name (J. Smith = John Smith)
  return x.first === y.first || (x.first.length === 1 && y.first.startsWith(x.first)) || (y.first.length === 1 && x.first.startsWith(y.first));
}

// ---- roles: the owner is the only reader (D6-1) ------------------------------------------------------
const ROLE_RULES = [
  [/\bco[-\s]?founder\b/i, 'co_founder'],
  [/\bfounder\b/i, 'founder'],
  [/\bmanaging partner\b/i, 'managing_partner'],
  [/\b(owner|proprietor|principal owner)\b/i, 'owner'],
  [/\b(ceo|chief executive)\b/i, 'ceo'],
  [/\bpresident\b/i, 'president'],
  [/\bpartner\b/i, 'partner'],
];
// titles that look senior but are not the person who decides the sale
const NOT_OWNER = /\b(vice|vp|assistant|associate|office manager|general manager|operations manager|sales|marketing|hr|human resources|account|regional|branch|director of|head of|coordinator|intern|technician|estimator|dispatcher|franchise development|former|past|retired|emeritus|product owner|partner manager|channel partner|partner success|partnerships?)\b|\bex[- ]/i;

export function ownerRole(title) {
  const t = String(title ?? '');
  if (!t.trim() || NOT_OWNER.test(t)) return null;
  for (const [re, role] of ROLE_RULES) if (re.test(t)) return role;
  return null;
}

// ---- the owner, from two independent sources (playbook §3.1) ---------------------------------------
// Source kinds that count once each. Two results from the same kind are one source.
export const SOURCE_KINDS = ['website', 'google_listing', 'registry', 'bbb', 'apollo', 'leadocean', 'blitzapi', 'lemlist', 'sales_navigator', 'csv', 'web_search', 'manual'];
// the people databases all draw on LinkedIn: together they are one source, not several. An uploaded list (csv) is
// counted as one of them, whatever tool made it
const FAMILY = { apollo: 'people_db', leadocean: 'people_db', blitzapi: 'people_db', lemlist: 'people_db', sales_navigator: 'people_db', csv: 'people_db' };
const family = (k) => FAMILY[k] ?? k;
// a CEO or president holds equity only sometimes (D6-1): the firm's own site, a registry or a person must back them
const EQUITY_SOURCES = new Set(['website', 'registry', 'bbb', 'manual']);

// candidates: [{ name, title, source, url, quote }]; returns the best owner and whether it is confirmed
export function decideOwner(candidates) {
  const usable = candidates.filter((c) => splitName(c.name)?.last && ownerRole(c.title ?? 'owner') && SOURCE_KINDS.includes(c.source));
  const groups = [];
  for (const c of usable) {
    const g = groups.find((x) => sameName(x.name, c.name));
    if (g) g.items.push(c); else groups.push({ name: c.name, items: [c] });
  }
  for (const g of groups) {
    g.kinds = [...new Set(g.items.map((i) => family(i.source)))];
    // prefer the fullest spelling of the name, and the most senior title
    g.name = g.items.map((i) => i.name).sort((a, b) => b.length - a.length)[0];
    g.role = g.items.map((i) => ownerRole(i.title ?? 'owner')).find(Boolean);
  }
  groups.sort((a, b) => b.kinds.length - a.kinds.length || (a.kinds.includes('website') ? -1 : 1));
  const best = groups[0];
  if (!best) return { owner: null, confirmed: false, disagreement: false, groups: [] };
  // two independent kinds agree -> confirmed; any other name put forward as owner -> a disagreement a person reads
  return {
    owner: { name: best.name, role: best.role ?? 'owner', sources: best.items },
    confirmed: best.kinds.length >= 2 && (!['ceo', 'president'].includes(best.role) || best.items.some((i) => EQUITY_SOURCES.has(i.source))),
    disagreement: groups.length > 1,
    groups,
  };
}

// ---- emails -----------------------------------------------------------------------------------------
export const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'charter.net',
  'cox.net', 'earthlink.net', 'optonline.net', 'frontier.com', 'frontiernet.net', 'windstream.net', 'centurylink.net', 'q.com', 'juno.com',
  'netzero.net', 'protonmail.com', 'proton.me', 'mail.com', 'gmx.com', 'zoho.com', 'aim.com', 'roadrunner.com', 'rr.com', 'twc.com',
  'embarqmail.com', 'suddenlink.net', 'mediacombb.net', 'ptd.net']);   // the same list is loaded into freemail_domains by sql/v1.3

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
// role addresses never stand for the owner
const ROLE_LOCAL = /^(info|contact|office|admin|sales|service|support|hello|help|billing|accounts?|jobs|careers|hr|team|mail|enquiries|inquiries|marketing|noreply|no-reply|dispatch|estimates?|schedul(e|ing)|bookings?|reception|webmaster)$/;

export const normEmail = (e) => String(e ?? '').trim().toLowerCase();
export const domainOf = (e) => normEmail(e).split('@')[1] ?? '';
export const isFreemail = (e) => FREEMAIL.has(domainOf(e));
export const isRoleAddress = (e) => ROLE_LOCAL.test(normEmail(e).split('@')[0] ?? '');
export const looksLikeEmail = (e) => EMAIL_RE.test(normEmail(e));

// the 8 patterns of the method the operator chose (D9-1), in that order
export function patterns(fullName, domain) {
  const n = splitName(fullName);
  const d = String(domain ?? '').toLowerCase().replace(/^www\./, '');
  if (!n || !n.first || !n.last || !d || FREEMAIL.has(d)) return [];
  const { first: f, last: l } = n;
  const list = [`${f}@${d}`, `${f}.${l}@${d}`, `${f}${l}@${d}`, `${f[0]}${l}@${d}`, `${l}@${d}`, `${f[0]}.${l}@${d}`, `${f}_${l}@${d}`, `${f}.${l[0]}@${d}`];
  return [...new Set(list)].filter(looksLikeEmail);
}

// an email printed on the firm's own site: which one stands for this owner (D9-2)?
//   1. an address on the firm's own domain that matches the owner's name (a pattern of it)
//   2. a freemail address whose local part carries the owner's first or last name
//   3. a freemail address that is the only one on the site (the shop's one inbox, typically the owner's)
// role addresses (info@, office@) never stand for the owner
export function ownSiteEmailFor(ownerName, companyDomain, siteEmails, { ownerNamedOnSite = false } = {}) {
  const emails = [...new Set((siteEmails ?? []).map((x) => normEmail(x.email ?? x)).filter(looksLikeEmail))];
  const pats = new Set(patterns(ownerName, companyDomain));
  const own = emails.find((e) => pats.has(e));
  if (own) return { email: own, freemail: false, why: 'the owner\'s own address on the company domain, printed on the site' };
  const n = splitName(ownerName);
  const free = emails.filter((e) => isFreemail(e) && !isRoleAddress(e));
  // the address must carry the surname as its own piece (bob.lee@, boblee1998@, blee@), never inside another name (ashleelee@)
  const named = n && n.last.length >= 2 && free.find((e) => {
    const local = e.split('@')[0].toLowerCase();
    if (local.split(/[^a-z]+/).includes(n.last)) return true;
    const letters = local.replace(/[^a-z]/g, '');
    return letters === n.last || letters.startsWith(n.first + n.last) || letters.startsWith(n.first[0] + n.last);
  });
  if (named) return { email: named, freemail: true, why: 'a personal address with the owner\'s name, printed on the firm\'s own site' };
  const nonRole = emails.filter((e) => !isRoleAddress(e));
  // the shop's one inbox stands for the owner only when the same site names that owner
  if (ownerNamedOnSite && free.length === 1 && nonRole.length === 1) return { email: free[0], freemail: true, why: 'the only address on the firm\'s own site, which names the owner' };
  return null;
}

// verifier answers, normalised to valid | invalid | catch_all | unknown
export function verdict(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (/catch|accept_all|accept-all|acceptall/.test(s)) return 'catch_all';
  if (/^(valid|ok|deliverable|good)$/.test(s)) return 'valid';
  if (/invalid|undeliverable|bad|disposable|bounce|reject|not_exist|does_not_exist|syntax/.test(s)) return 'invalid';
  return 'unknown';
}
