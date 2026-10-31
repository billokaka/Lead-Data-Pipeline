// listreport.mjs: the report of an email-list run: what was found, from where, what it cost, and what the rest of
// the list would cost at this run's rate.

import { basename, dirname } from 'node:path';
import { readRows, eligibleTitle, loadProgress, paths } from './listemail.mjs';

const table = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n');

export function listReport({ r, job, cost, total, input }) {
  const { rows, at } = readRows(input);
  const done = loadProgress(paths(input, dirname(r.out)).progress);
  const status = {}, source = {};
  for (const f of done.values()) {
    status[f.enrich_status] = (status[f.enrich_status] ?? 0) + 1;
    if (f.enrich_status === 'verified') { const s = String(f.enrich_source).replace(/ \d+ of \d+$/, ''); source[s] = (source[s] ?? 0) + 1; }
  }
  const eligible = rows.filter((x) => eligibleTitle(x[at.title])).length;
  const left = eligible - done.size;
  const perRow = r.processed ? total / r.processed : 0;
  const verified = status.verified ?? 0;
  return `# Email enrichment: ${basename(input)}, job ${job}

${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Rows run this time: ${r.processed} of ${r.planned} planned; errors ${r.errors}${r.stopped ? `; **stopped: ${r.stopped}**` : ''}.

**Whole list:** ${rows.length} rows; ${eligible} owners, CEOs, founders or co-founders by title; ${done.size} done so far; ${left} left.

## Results so far (every run of this list)

| Status | Rows |
| :-- | --: |
${table(status) || '| (none yet) | 0 |'}

| Verified email from | Rows |
| :-- | --: |
${table(source) || '| (none yet) | 0 |'}

Verified so far: ${verified} of ${done.size} rows done (${done.size ? Math.round((100 * verified) / done.size) : 0}%).

## Cost of this run (job ${job})

| Tool | Step | Calls | $ |
| :-- | :-- | --: | --: |
${cost.map((c) => `| ${c.provider} | ${c.step} | ${c.calls} | ${c.usd} |`).join('\n')}
| **Total** | | | **${total.toFixed(4)}** |

Per row: $${perRow.toFixed(4)}. **At this rate the ${left} rows left would cost about $${(perRow * left).toFixed(2)}** [inferred from ${r.processed} rows: a small sample].
Apollo is costed at ENRICH_APOLLO_CREDIT_USD a credit; the credits really used are on Apollo's own usage page.

The results file: ${basename(r.out)} (every original column, then the enrich_ columns).
`;
}
