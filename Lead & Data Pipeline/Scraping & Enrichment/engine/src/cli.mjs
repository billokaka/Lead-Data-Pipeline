#!/usr/bin/env node
// cli.mjs: the engine from a terminal, for long unattended runs.
//   npm run worker                 runs until there is nothing to do (at most 8 hours)
//   node src/cli.mjs worker 120    runs for at most 120 minutes
//   node src/cli.mjs status        prints the pipeline by industry and today's spend
//   node src/cli.mjs domain-check <file.csv> [--site] [--indexed <max $>] [--catch-all <max $>] [--no-age]
//                                  the domain pre-filter: free DNS verdicts, the list split into alive and removed
//   node src/cli.mjs verify-list <file.csv> <max $>
//                                  checks the addresses a list already has: free checks first, one paid check
//   node src/cli.mjs organize <results.csv>
//                                  sorts a results file industry by industry and sets duplicates apart
//   node src/cli.mjs email-list <file.csv> <results folder> <rows> <max $> [redo] [no-hold] [kitt]
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
import { runValueFacts, writeValueFacts } from './valuefact.mjs';
import { makeDomainChecker } from './domaincheck.mjs';
import { runDomainList } from './domainlist.mjs';
import { runVerifyList } from './verifylist.mjs';
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
    // the domain pre-filter: free DNS first, so a dead website domain costs nothing paid (cached in Supabase once v1.4 is run)
    const domainCache = (await db.one(`select to_regclass('public.email_domains') is not null as ok`)).ok;
    const domains = makeDomainChecker({ db: domainCache ? db : null, withAge: false });
    const r = await runList({ input: arg, outDir, limit, providers, jobId: job.job_id, states, concurrency: config.concurrency, log, redo: flags.includes('redo'), skipHold: flags.includes('no-hold'), kitt: flags.includes('kitt'), domains });
    for (const note of [providers.smartleadStatus?.(), providers.apolloStatus?.()]) if (note) log(`note: ${note}`);
    const cost = await db.query(`select provider, step, count(*)::int calls, round(sum(usd)::numeric, 4) usd from costs where job_id = $1 group by 1, 2 order by 1, 2`, [job.job_id]);
    const total = cost.reduce((a, c) => a + Number(c.usd), 0);
    await db.query(`update enrichment_jobs set status = 'done', finished_at = now(), progress = $2 where job_id = $1 and status = 'running'`,
      [job.job_id, { processed: r.processed, errors: r.errors, stopped: r.stopped }]);
    writeFileSync(r.report.replace(/\.md$/, `-job${job.job_id}.md`), listReport({ r, job: job.job_id, cost, total, input: arg }));
    log(`job ${job.job_id}: ${r.processed} rows done, ${r.errors} errors, $${total.toFixed(4)}${r.stopped ? `; stopped: ${r.stopped}` : ''}`);
    log(`results: ${r.out}`);
  } else if (cmd === 'domain-check') {
    // node src/cli.mjs domain-check <file.csv> [--catch-all <max $>] [--no-age]: free DNS, paid catch-all only when asked
    const ci = rest.indexOf('--catch-all'), ii = rest.indexOf('--indexed');
    const maxUsd = (ci >= 0 ? Number(rest[ci + 1]) : 0) + (ii >= 0 ? Number(rest[ii + 1]) : 0);
    if (!arg) throw new Error('use: domain-check <file.csv> [--site] [--indexed <max $>] [--catch-all <max $>] [--no-age]');
    if ((ci >= 0 && !(Number(rest[ci + 1]) > 0)) || (ii >= 0 && !(Number(rest[ii + 1]) > 0))) throw new Error('--catch-all and --indexed need a cap in dollars, e.g. --indexed 15');
    // the cache lives in Supabase once sql/v1.4-domains.sql is run; until then, in memory for this run only
    const hasCache = (await db.one(`select to_regclass('public.email_domains') is not null as ok`)).ok;
    if (!hasCache) log('note: sql/v1.4-domains.sql is not run in Supabase yet, so the domain cache lives in memory for this run only');
    const checker = makeDomainChecker({ db: hasCache ? db : null, withAge: !rest.includes('--no-age') });
    let jobId = null, providers = null;
    if (ci >= 0 || ii >= 0) {
      const job = await db.one(`insert into enrichment_jobs (kind, params, requested_by, max_cost_usd, status, started_at) values ('enrich', $1, $2, $3, 'running', now()) returning job_id`,
        [{ mode: 'domain_check', file: basename(arg) }, config.person, maxUsd]);
      jobId = job.job_id;
      providers = makeProviders({ config, paid: makeSpender({ db, config, redact: (t) => redact(config, t) }) });
    }
    const t0 = Date.now();
    log(`domain check of ${basename(arg)}: DNS free${rest.includes('--site') ? ', website check free' : ''}${ii >= 0 ? ', index: Common Crawl free, Google search for the rest' : ''}${ci >= 0 ? ', catch-all probes' : ''}${jobId ? ` (job ${jobId}, at most $${maxUsd})` : ''}`);
    const r = await runDomainList({ input: arg, checker, providers, catchAll: ci >= 0, site: rest.includes('--site'), indexed: ii >= 0, jobId, log });
    if (jobId) {
      const c = await db.one('select round(coalesce(sum(usd), 0)::numeric, 4) usd from costs where job_id = $1', [jobId]);
      await db.query(`update enrichment_jobs set status = 'done', finished_at = now(), progress = $2 where job_id = $1 and status = 'running'`, [jobId, { probes: r.catch_all_probes, stopped: r.stopped }]);
      r.job_cost_usd = c.usd;                     // catch-all probes and Google searches together
    }
    r.seconds = Math.round((Date.now() - t0) / 1000);
    console.log(JSON.stringify(r, null, 1));
  } else if (cmd === 'verify-list') {
    // node src/cli.mjs verify-list <file.csv> <max $>: the addresses a list already has, free checks first, one paid check
    const maxUsd = Number(rest[0]);
    if (!arg || !(maxUsd > 0)) throw new Error('use: verify-list <file.csv> <max $>');
    const cache = (await db.one(`select to_regclass('public.email_checks') is not null and to_regclass('public.email_domains') is not null as ok`)).ok;
    if (!cache) log('note: sql/v1.4-domains.sql is not run in Supabase yet, so nothing is cached between runs');
    const job = await db.one(`insert into enrichment_jobs (kind, params, requested_by, max_cost_usd, status, started_at) values ('enrich', $1, $2, $3, 'running', now()) returning job_id`,
      [{ mode: 'verify_list', file: basename(arg) }, config.person, maxUsd]);
    const providers = makeProviders({ config, paid: makeSpender({ db, config, redact: (t) => redact(config, t) }) });
    const r = await runVerifyList({ input: arg, checker: makeDomainChecker({ db: cache ? db : null, withAge: false }), providers, db: cache ? db : null, jobId: job.job_id, log });
    const c = await db.one('select round(coalesce(sum(usd), 0)::numeric, 4) usd from costs where job_id = $1', [job.job_id]);
    await db.query(`update enrichment_jobs set status = 'done', finished_at = now(), progress = $2 where job_id = $1 and status = 'running'`, [job.job_id, { checked: r.checked, stopped: r.stopped }]);
    console.log(JSON.stringify({ job: job.job_id, cost_usd: c.usd, ...r }, null, 1));
  } else if (cmd === 'value-fact') {
    // node src/cli.mjs value-fact <verified.csv> <rows> <max $> [sample] [retry-review]
    const [rowsArg, usdArg, ...flags] = rest;
    const limit = Number(rowsArg), maxUsd = Number(usdArg);
    if (!arg || !(limit > 0) || !(maxUsd > 0)) throw new Error('use: value-fact <verified.csv> <rows> <max $> [sample]');
    const job = await db.one(`insert into enrichment_jobs (kind, params, requested_by, max_cost_usd, status, started_at)
      values ('enrich', $1, $2, $3, 'running', now()) returning job_id`, [{ mode: 'value_fact', file: basename(arg), rows: limit, model: config.valueFactModel }, config.person, maxUsd]);
    const providers = makeProviders({ config, paid: makeSpender({ db, config, redact: (t) => redact(config, t) }) });
    log(`job ${job.job_id}: value facts for up to ${limit} rows with ${config.valueFactModel}, sequence A, at most $${maxUsd}`);
    const r = await runValueFacts({ input: arg, limit, providers, jobId: job.job_id, sample: flags.includes('sample'), retryReview: flags.includes('retry-review'), concurrency: config.concurrency, log });
    const cost = await db.one('select round(coalesce(sum(usd), 0)::numeric, 4) usd from costs where job_id = $1', [job.job_id]);
    await db.query(`update enrichment_jobs set status = 'done', finished_at = now(), progress = $2 where job_id = $1 and status = 'running'`, [job.job_id, { processed: r.processed, errors: r.errors, stopped: r.stopped }]);
    // a test writes only the rows that have a value fact so far; a full run writes every row
    const test = flags.includes('sample');
    const em = r.header.indexOf('email');
    const withFact = r.rows.map((x, i) => i).filter((i) => r.done.has(r.rows[i][em]));
    const out = test ? `${r.base}-value-fact-test.csv` : `${r.base}-value-fact.csv`;
    writeValueFacts({ header: r.header, rows: r.rows, done: r.done, out, only: test ? withFact : null });
    const t = {}; for (const i of (test ? withFact : r.picked)) { const f = r.done.get(r.rows[i][em]); if (f) t[f.result] = (t[f.result] ?? 0) + 1; }
    log(`job ${job.job_id}: ${r.processed} rows, ${r.errors} errors, $${cost.usd}${r.stopped ? `; stopped: ${r.stopped}` : ''} | ${JSON.stringify(t)}`);
    log(`file: ${out}`);
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
