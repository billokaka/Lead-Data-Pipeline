// csv.mjs: reads a list exported from any tool (Apollo, lemlist, Sales Navigator, a Maps scraper) into plain rows.
// Columns are matched by their usual names; people's phone numbers are never read (they are never collected).

// RFC 4180: quoted fields, "" inside quotes, commas and line breaks inside quotes, a UTF-8 BOM
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const key = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// the usual names each tool gives a column; the first match wins
const COLUMNS = {
  company_name: ['company', 'company name', 'company name for emails', 'organization', 'organization name', 'account name', 'business name', 'business'],
  website: ['website', 'company website', 'website url', 'company url', 'domain', 'company domain', 'organization website', 'url', 'site'],
  industry: ['industry', 'company industry', 'category', 'categories', 'main category', 'type'],
  location: ['location', 'address', 'full address', 'company address', 'company location', 'street address'],
  city: ['city', 'company city'],
  state: ['state', 'company state', 'state code', 'region', 'province'],
  company_phone: ['company phone', 'phone', 'business phone', 'main phone'],
  company_linkedin: ['company linkedin url', 'company linkedin', 'linkedin company url', 'company linkedin page'],
  first_name: ['first name', 'firstname', 'first'],
  last_name: ['last name', 'lastname', 'surname', 'last'],
  full_name: ['full name', 'contact name', 'person name', 'contact', 'owner name'],
  designation: ['title', 'job title', 'designation', 'position', 'role', 'seniority title'],
  email: ['email', 'email address', 'work email', 'business email', 'person email', 'contact email'],
  person_linkedin: ['linkedin', 'linkedin url', 'person linkedin url', 'linkedin profile', 'profile url', 'contact linkedin url'],
};

// header -> field map; a list with person columns makes "phone" a person's phone, so it is dropped
export function mapHeaders(headers) {
  const keys = headers.map(key);
  const at = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    for (const n of names) { const i = keys.indexOf(n); if (i >= 0 && !Object.values(at).includes(i)) { at[field] = i; break; } }
  }
  // a Maps-style list with only "name" is a company name
  if (at.company_name === undefined && at.full_name === undefined && at.first_name === undefined && keys.includes('name')) at.company_name = keys.indexOf('name');
  else if (at.full_name === undefined && at.first_name === undefined && keys.includes('name')) at.full_name = keys.indexOf('name');
  const hasPeople = at.first_name !== undefined || at.full_name !== undefined || at.email !== undefined;
  if (hasPeople && at.company_phone !== undefined && keys[at.company_phone] === 'phone') delete at.company_phone;
  const unused = headers.filter((_, i) => !Object.values(at).includes(i));
  return { at, hasPeople, unused };
}

export function readList(text, { maxRows = 20000 } = {}) {
  const all = parseCsv(text);
  if (all.length < 2) throw new Error('the file has no rows under its header');
  const [headers, ...body] = all;
  if (body.length > maxRows) throw new Error(`the file has ${body.length} rows; the most one upload takes is ${maxRows}`);
  const { at, hasPeople, unused } = mapHeaders(headers);
  if (at.company_name === undefined && at.website === undefined) throw new Error('no company or website column found');
  const cell = (r, f) => { const v = at[f] === undefined ? '' : String(r[at[f]] ?? '').trim(); return v || null; };
  const rows = body.map((r) => Object.fromEntries(Object.keys(COLUMNS).map((f) => [f, cell(r, f)])));
  return { rows, hasPeople, columns: Object.fromEntries(Object.entries(at).map(([f, i]) => [f, headers[i]])), unused };
}

// "https://www.AcePlumb.com/contact" -> "aceplumb.com"
export function domainOf(website) {
  const w = String(website ?? '').trim().toLowerCase();
  if (!w || w.includes('@') || /\s/.test(w)) return null;
  const host = w.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}
