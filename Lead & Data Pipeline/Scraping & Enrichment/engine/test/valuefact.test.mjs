// The value-fact line (2026-11-01): the prompt's testable rules, REVIEW instead of a bad line, the file layout, and a
// stopped run carrying on without paying twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv } from '../src/csv.mjs';
import { checkLine, rowInput, runValueFacts, writeValueFacts, systemPrompt, PROMPT_FILE } from '../src/valuefact.mjs';

test('the prompt file travels with the engine and is sent as written', () => {
  assert.ok(existsSync(PROMPT_FILE));
  const s = systemPrompt();
  assert.match(s, /You write one line for a cold email/);
  assert.match(s, /FALLBACK LIBRARY/);
});

test('the checks: a good line passes; dashes, compliments, buyers in A, the company name and unfilled slots go to REVIEW', () => {
  const ctx = { companyName: 'Great Lakes Mechanical Service LLC', sequence: 'A' };
  assert.equal(checkLine({ result: 'LINE', line: 'Industrial HVAC under one roof, built as a family business.' }, ctx), null);
  assert.equal(checkLine({ result: 'SUPPRESS', line: '' }, ctx), null);
  assert.match(checkLine({ result: 'LINE', line: 'Industrial HVAC — a real business.' }, ctx), /dash/);
  assert.match(checkLine({ result: 'LINE', line: 'An impressive book of commercial accounts.' }, ctx), /banned/);
  assert.match(checkLine({ result: 'LINE', line: 'That is the kind of business buyers go after.' }, ctx), /buyers/);
  assert.equal(checkLine({ result: 'LINE', line: 'That is the kind of business buyers go after.' }, { ...ctx, sequence: 'C' }), null);
  assert.match(checkLine({ result: 'LINE', line: 'Lakes Mechanical Service runs forty trucks.' }, ctx), /company name/);
  assert.match(checkLine({ result: 'FALLBACK', line: 'A {trade} business in Toledo has value.' }, ctx), /unfilled/);
  assert.match(checkLine({ result: 'MAYBE', line: 'x' }, ctx), /not LINE/);
  assert.match(checkLine(null, ctx), /not LINE/);
});

test('the row sent is the company only: no owner bio, the city without the country', () => {
  const row = { companyName: 'Ace Plumbing', companyIndustry: 'Construction', companyLocation: 'Cleveland, Cuyahoga County, Ohio, United States',
    companyDescription: 'Commercial plumbing, family owned.', companyFoundedOn: '1967', companySize: '11-50', summary: 'Owner bio here' };
  const u = rowInput((c) => row[c] ?? '', 'A');
  const j = JSON.parse(u.slice(0, u.indexOf('\n\n')));
  assert.equal(j.city, 'Cleveland, Ohio'); assert.equal(j.sequence, 'A'); assert.equal(j.trade, 'Construction');
  assert.ok(!u.includes('Owner bio'));
});

test('a run: value_fact right after email, the checks at the end, REVIEW never in value_fact, carry on without paying twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vf-'));
  const input = join(dir, 'x-verified-only.csv');
  writeFileSync(input, ['firstName,email,email_status,companyName,companyIndustry,companyDescription',
    'A,a@a.com,verified,Ace Co,Construction,"Commercial HVAC, family owned since 1967"',
    'B,b@b.com,verified,Bee Co,Construction,thin',
    'C,c@c.com,verified,Cee Co,Construction,a franchise of PMI',
    'D,d@d.com,verified,Dee Co,Construction,bad output'].join('\r\n'));
  const calls = [];
  const providers = { valueFact: async ({ user }) => { calls.push(user); const d = JSON.parse(user.slice(0, user.indexOf('\n\n'))).description;
    return d.startsWith('Commercial') ? { result: 'LINE', line: 'Commercial HVAC as a family business, that has built up real value.', signal: 'family' }
      : d === 'thin' ? { result: 'FALLBACK', line: 'You have built a construction business, and it has a number on it.', signal: 'fallback: thin row' }
      : d.includes('franchise') ? { result: 'SUPPRESS', line: '', signal: 'franchise' } : { result: 'LINE', line: 'Buyers love this — great work.', signal: 'x' }; } };
  const r = await runValueFacts({ input, limit: 10, providers, jobId: 1, concurrency: 1, system: 'test' });
  assert.equal(r.processed, 4);
  const out = writeValueFacts({ header: r.header, rows: r.rows, done: r.done, out: join(dir, 'out.csv') });
  const [h, ...rows] = parseCsv(readFileSync(out, 'utf8'));
  assert.deepEqual(h, ['firstName', 'email', 'value_fact', 'email_status', 'companyName', 'companyIndustry', 'companyDescription', 'value_fact_result', 'value_fact_signal']);
  const f = (i, c) => rows[i][h.indexOf(c)];
  assert.equal(f(0, 'value_fact_result'), 'LINE'); assert.match(f(0, 'value_fact'), /family business/);
  assert.equal(f(1, 'value_fact_result'), 'FALLBACK');
  assert.equal(f(2, 'value_fact_result'), 'SUPPRESS'); assert.equal(f(2, 'value_fact'), '');
  assert.equal(f(3, 'value_fact_result'), 'REVIEW'); assert.equal(f(3, 'value_fact'), '', 'a line that fails a check never reaches value_fact');
  const again = await runValueFacts({ input, limit: 10, providers, jobId: 2, concurrency: 1, system: 'test' });
  assert.equal(again.processed, 0); assert.equal(calls.length, 4, 'nothing paid twice');
});

test('the fixes after the first test: a trade word alone is not the name, articles, half the rows end bare', async () => {
  const { checkLine, fixArticle, bareFact } = await import('../src/valuefact.mjs');
  const ctx = { companyName: 'Commercial Landscape Services of Berkshire', sequence: 'A', city: 'Pittsfield, United States' };
  assert.equal(checkLine({ result: 'LINE', line: 'Landscape work for commercial properties across the county.' }, ctx), null, 'a plain trade word is the fact');
  assert.match(checkLine({ result: 'LINE', line: 'Landscape Services of Berkshire runs forty crews.' }, ctx), /company name/);
  assert.match(checkLine({ result: 'LINE', line: 'Ghafari Associates does design work.' }, { companyName: 'Ghafari Associates', sequence: 'A' }), /company name/);
  assert.equal(fixArticle("You've built a HVAC business in Toledo."), "You've built an HVAC business in Toledo.");
  assert.equal(fixArticle('A accounting practice built in Spokane.'), 'An accounting practice built in Spokane.');
  assert.equal(fixArticle('A unique book of accounts.'), 'A unique book of accounts.');
  const emails = Array.from({ length: 1000 }, (_, i) => `owner${i}@firm${i}.com`);
  const bare = emails.filter(bareFact).length;
  assert.ok(bare > 400 && bare < 600, `about half end bare: ${bare}`);
});

test('the checks after the full run: lowercase work words are not the name, a city is not a compliment, no library line is said plainly', async () => {
  const { checkLine } = await import('../src/valuefact.mjs');
  const ctx = { companyName: 'Blue Gander Window Cleaning', sequence: 'A', city: 'Great Barrington, United States' };
  assert.equal(checkLine({ result: 'LINE', line: 'The only drone window cleaning outfit in the region.' }, ctx), null);
  assert.match(checkLine({ result: 'LINE', line: 'Running Blue Gander for ten years.' }, ctx), /company name/);
  assert.equal(checkLine({ result: 'FALLBACK', line: 'A tax practice built in Great Barrington has a value on it.' }, ctx), null);
  assert.match(checkLine({ result: 'LINE', line: 'A great book of accounts.' }, ctx), /banned/);
  assert.match(checkLine({ result: 'FALLBACK', line: '' }, ctx), /no fallback line in the library/);
});
