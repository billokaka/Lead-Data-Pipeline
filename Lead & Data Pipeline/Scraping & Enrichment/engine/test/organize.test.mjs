// The organized results file: industry by industry, verified first, duplicates moved to their own file, every column kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv } from '../src/csv.mjs';
import { organize } from '../src/organize.mjs';

test('sorted by industry, verified first, duplicates removed into their own file, nothing lost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'org-'));
  const f = join(dir, 'x-enriched.csv');
  writeFileSync(f, ['firstName,email,email_status,companyName,companyIndustry,notes',
    'A,a@z.com,not_found,Zed Co,Utilities,"multi\nline"', 'B,b@b.com,verified,Bee Co,Construction,', 'C,,catch_all,Ace Co,Construction,',
    'D,d@d.com,verified,Ace Co,Construction,', 'E,,duplicate,Dup Co,Construction,', 'F,f@f.com,verified,Nil Co,,'].join('\r\n'));
  const r = organize(f);
  assert.equal(r.rows, 6); assert.equal(r.kept, 5); assert.equal(r.removed, 1);
  const [h, ...rows] = parseCsv(readFileSync(r.organized, 'utf8'));
  assert.deepEqual(h, ['firstName', 'email', 'email_status', 'companyName', 'companyIndustry', 'notes'], 'every column kept, in order');
  assert.deepEqual(rows.map((x) => x[0]), ['D', 'B', 'C', 'A', 'F'], 'Construction (verified by company, then catch-all), Utilities, then no industry');
  assert.equal(rows[3][5], 'multi\nline');
  assert.deepEqual(parseCsv(readFileSync(r.duplicates, 'utf8')).slice(1).map((x) => x[0]), ['E']);
  assert.deepEqual(parseCsv(readFileSync(r.verifiedOnly, 'utf8')).slice(1).map((x) => x[0]), ['D', 'B', 'F'], 'verified rows only, same order');
  assert.ok(readFileSync(r.organized, 'utf8').startsWith('﻿'), 'Excel reads accented names');
});
