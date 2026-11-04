#!/usr/bin/env node
// refresh-disposable.mjs: refreshes data/disposable-domains.txt from the maintained public list
// (github.com/disposable-email-domains/disposable-email-domains). Run it weekly: node scripts/refresh-disposable.mjs
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf';
const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
if (!res.ok) { console.error(`the list answered ${res.status}; the old file is kept`); process.exit(1); }
const domains = [...new Set((await res.text()).split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#') && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(l)))].sort();
if (domains.length < 1000) { console.error(`only ${domains.length} domains came back; the old file is kept`); process.exit(1); }
writeFileSync(new URL('../data/disposable-domains.txt', import.meta.url), `# disposable mail domains, from ${SOURCE}, ${new Date().toISOString().slice(0, 10)}\n${domains.join('\n')}\n`);
console.log(`${domains.length} disposable domains written`);
