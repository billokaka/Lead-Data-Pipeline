#!/usr/bin/env node
// cli.mjs: the engine from a terminal, for long unattended runs.
//   npm run worker                 runs until there is nothing to do (at most 8 hours)
//   node src/cli.mjs worker 120    runs for at most 120 minutes
//   node src/cli.mjs status        prints the pipeline by industry and today's spend
//   node src/cli.mjs organize <results.csv>
//                                  sorts a results file industry by industry and sets duplicates apart
//   node src/cli.mjs email-list <file.csv> <results folder> <rows> <max $> [redo] [no-hold] [kitt] [all-titles]
//                                  finds and verifies the emails of up to <rows> owners in a list, file to file
// Settings come from the environment or ENRICH_ENV_FILE, as for the connector. Ctrl+C stops after the current row.

import { loadConfig, redact } from './config.mjs';
import { openSupabase } from './db.mjs';
import { makeSpender } from './money.mjs';
import { makeProviders } from './providers/index.mjs';
import { runUntilIdle } from './worker.mjs';
import { runList } from './listemail.mjs';
import { listReport } from './listreport.mjs';
import { organize } from './organize.mjs';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [cmd = 'status', arg, ...rest] = process.argv.slice(2);
const config = loadConfig();
const db = await openSupabase(config);
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${redact(config, s)}`);

try {
  if (cmd === 'worker') {
    const ac = new AbortController();
    process.on('SIGINT', () => { log('stopping after the current row...'); ac.abort(); });
    const ctx = { db, config, providers: makeProviders({ config, paid: makeSpender({ db, config, redact: (t) => redact(config, t) }) }), log, redact: (s) => redact(config, s) };
    log(`engine started as ${config.person}; paid calls ${config.allowSpend ? 'on' : 'off'}`);
    const r = await runUntilIdle(ctx, { minutes: Number(arg) || 480, signal: ac.signal });
    log(`done: ${JSON.stringify(r)}`);
  } else if (cmd === 'email-list') {
    const [outDir, rowsArg, usdArg, ...flags] = rest;
    const limit = Number(rowsArg), maxUsd = Number(usdArg);
    if (!arg || !outDir || !(limit > 0) || !(maxUsd > 0)) throw new Error('use: email-list <file.csv> <results folder> <rows> <max $>');
    if (maxUsd > config.maxJobUsd) throw new Error(`the most one job may spend is $${config.maxJobUsd} (ENRICH_MAX_JOB_USD)`);
    const states = new Map((await db.query('select state_code, name, is_on_hold from us_states')).map((s) => [s.name.toLowerCase(), { code: s.state_code, hold: s.is_on_hold }]));
    const job = await db.one(`insert into enrichment_jobs (kind, params, requested_by, max_cost_usd, status, started_at)
      values ('enrich', $1, $2, $3, 'running', now()) returning job_id`, [{ mode: 'email_list_to_file', file: basename(arg), rows: limit, flags }, config.person, maxUsd]);
    const ac = new AbortController();
    process.on('SIGINT', () => { log('stopping after the current rows...'); ac.abort(); });
    const providers = makeProviders({ config, paid: makeSpender({ db, config, redact: (t) => redact(config, t) }) });
    log(`job ${job.job_id}: up to ${limit} rows of ${basename(arg)}, at most $${maxUsd}; paid calls ${config.allowSpend ? 'on' : 'off'}`);
    const r = await runList({ input: arg, outDir, limit, providers, jobId: job.job_id, states, concurrency: config.concurrency, log, redo: flags.includes('redo'), skipHold: flags.includes('no-hold'), kitt: flags.includes('kitt'), allTitles: flags.includes('all-titles') });
    for (const note of [providers.smartleadStatus?.(), providers.apolloStatus?.()]) if (note) log(`note: ${note}`);
    const cost = await db.query(`select provider, step, count(*)::int calls, round(sum(usd)::numeric, 4) usd from costs where job_id = $1 group by 1, 2 order by 1, 2`, [job.job_id]);
    const total = cost.reduce((a, c) => a + Number(c.usd), 0);
    await db.query(`update enrichment_jobs set status = 'done', finished_at = now(), progress = $2 where job_id = $1 and status = 'running'`,
      [job.job_id, { processed: r.processed, errors: r.errors, stopped: r.stopped }]);
    writeFileSync(r.report.replace(/\.md$/, `-job${job.job_id}.md`), listReport({ r, job: job.job_id, cost, total, input: arg }));
    log(`job ${job.job_id}: ${r.processed} rows done, ${r.errors} errors, $${total.toFixed(4)}${r.stopped ? `; stopped: ${r.stopped}` : ''}`);
    log(`results: ${r.out}`);
  } else if (cmd === 'organize') {
    const r = organize(arg);
    log(`${r.rows} rows: ${r.kept} organized, ${r.removed} duplicates set apart`);
    console.table(r.industries.slice(0, 25));
    log(`organized: ${r.organized}`); log(`verified only: ${r.verifiedOnly}`); log(`duplicates: ${r.duplicates}`);
  } else if (cmd === 'status') {
    console.table(await db.query('select * from pipeline_by_industry order by 1, 2, 3'));
    console.table(await db.query('select * from spend_today order by provider'));
  } else {
    console.log('use: worker [minutes] | status | email-list <file.csv> <results folder> <rows> <max $>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(redact(config, e.message));
  process.exitCode = 1;
} finally {
  await db.close();
}
