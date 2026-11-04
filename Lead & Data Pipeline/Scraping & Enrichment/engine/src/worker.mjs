// worker.mjs: takes work from Supabase and runs it. Any number of workers, on any machine, can run at once:
// rows are claimed with a lease (claim_* functions, skip locked); each row's lease is renewed when its work starts,
// and every write is fenced on the lease (stages.mjs), so no two workers act on the same row.
// v1.1, 2026-10-29, after the reviewer's attack.

import { runSource, runDomainCheck, runSiteRead, runOwner, runEmail, runVerify, LostLease } from './stages.mjs';
import { SpendRefused } from './money.mjs';

export const STEPS = [
  { name: 'domain check', table: 'companies', stage: 'to_check_domain', run: runDomainCheck },
  { name: 'site read', table: 'companies', stage: 'to_read', run: runSiteRead },
  { name: 'owner', table: 'companies', stage: 'to_find_owner', run: runOwner },
  { name: 'email', table: 'people', stage: 'to_find_email', run: runEmail },
  { name: 'verify', table: 'people', stage: 'to_verify', run: runVerify },
];
const MAX_ATTEMPTS = 5;

export async function isPaused(db) {
  const f = await db.one(`select value from flags where name = 'enrichment_paused'`);
  return Boolean(f?.value);
}

// one pass: a waiting job, then a small batch of each step. Returns what was done.
export async function runOnce(ctx, { steps = STEPS.map((s) => s.name), batch } = {}) {
  const { db, config, log } = ctx;
  ctx.worker ??= `${config.person}@${process.pid}`;
  const conc = config.concurrency ?? 1;
  // a small batch, so no claimed row waits long enough for its lease to run out
  const size = batch ?? Math.min(config.batch ?? 25, conc * 3);
  const done = { jobs: 0, rows: {}, finished: 0, errors: 0, refused: null };
  if (await isPaused(db)) return { ...done, paused: true };

  const job = await db.one('select * from claim_job($1)', [ctx.worker]);
  if (job) {
    try { const p = await runSource(ctx, job); done.jobs++; log(`job ${job.job_id} done: ${p.rows_found} rows found`); }
    catch (e) {
      done.errors++;
      await db.query(`update enrichment_jobs set status = 'failed', note = $3, finished_at = now(), claimed_by = null, claimed_until = null
        where job_id = $1 and claimed_by = $2`, [job.job_id, ctx.worker, ctx.redact(String(e.message)).slice(0, 500)]);
    }
  }
  for (const step of STEPS.filter((s) => steps.includes(s.name))) {
    if (done.refused || ctx.signal?.aborted) break;
    const rows = await db.query(`select * from claim_${step.table}($1, $2, $3)`, [step.stage, ctx.worker, size]);
    done.rows[step.name] = rows.length;
    const queue = [...rows];
    const id = step.table === 'companies' ? 'company_id' : 'person_id';
    const lane = async () => {
      while (queue.length && !done.refused && !ctx.signal?.aborted) {
        const row = queue.shift();
        try { await step.run(ctx, row); done.finished++; }
        catch (e) {
          if (e instanceof LostLease) continue;                   // another worker has the row now
          if (e instanceof SpendRefused) {                        // a budget or switch: not the row's fault, no attempt counted
            done.refused = e.message;
            await db.query(`update ${step.table} set stage_note = $3, claimed_by = null, claimed_until = null where ${id} = $1 and claimed_by = $2`,
              [row[id], ctx.worker, `waiting: ${e.message}`]);
            continue;
          }
          done.errors++;
          // a real error counts an attempt; the fifth puts the row in front of a person with the reason
          await db.query(`update ${step.table} set attempts = attempts + 1, stage_note = $3,
              enrichment_stage = case when attempts + 1 >= $4 then 'needs_review' else enrichment_stage end, claimed_by = null, claimed_until = null
            where ${id} = $1 and claimed_by = $2`, [row[id], ctx.worker, `error: ${ctx.redact(String(e.message)).slice(0, 300)}`, MAX_ATTEMPTS]);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, rows.length || 1) }, lane));
    // rows not reached give their lease back at once
    if (queue.length) await db.query(`update ${step.table} set claimed_by = null, claimed_until = null where ${id} = any($1) and claimed_by = $2`,
      [queue.map((r) => r[id]), ctx.worker]);
  }
  if (done.finished > 0) await db.query('select * from apply_suppression()');
  return done;
}

// keeps going until nothing moves, the time is up, a budget stops it, or someone pauses or stops it
export async function runUntilIdle(ctx, { minutes = 60, signal } = {}) {
  ctx.signal = signal;
  const until = Date.now() + minutes * 60000;
  const total = { passes: 0, jobs: 0, finished: 0, errors: 0 };
  while (Date.now() < until && !signal?.aborted) {
    const r = await runOnce(ctx);
    total.passes++; total.jobs += r.jobs; total.finished += r.finished; total.errors += r.errors;
    if (r.paused) { total.stopped = 'paused'; break; }
    if (r.refused) { total.stopped = r.refused; break; }
    if (!r.jobs && !r.finished) break;                            // nothing moved: idle, or only errors
  }
  return total;
}

// ---- 4. the person's approval of a batch of owners (playbook §3.1): only approved owners spend email credits ----------
// An owner with one source can be approved only when the person has checked them (their check is the second source,
// recorded as {source: "manual", by}). Only rows the engine found (a role, waiting for approval) can be approved.
export async function decideOwners(db, { personIds, decision, by, checkedOwnerIds = [] }) {
  if (!['approve', 'reject'].includes(decision)) throw new Error('decision must be approve or reject');
  const ids = [...new Set(personIds.map(Number).filter(Number.isInteger))];
  if (!ids.length) return { changed: 0 };
  const checked = [...new Set(checkedOwnerIds.map(Number).filter((x) => ids.includes(x)))];
  if (decision === 'reject') {
    const r = await db.query(`update people set enrichment_stage = 'rejected', approved_by = $2, approved_at = now(), stage_note = 'rejected by ' || $2
      where person_id = any($1) and enrichment_stage = 'awaiting_approval' returning person_id`, [ids, by]);
    return { changed: r.length };
  }
  if (checked.length) {
    await db.query(`update people set owner_sources = owner_sources || jsonb_build_array(jsonb_build_object('source','manual','by',$2::text,'at',now()::text)),
        owner_confirmed = true
      where person_id = any($1) and enrichment_stage = 'awaiting_approval' and role is not null and not owner_confirmed`, [checked, by]);
  }
  const r = await db.query(`update people set enrichment_stage = 'to_find_email', approved_by = $2, approved_at = now()
    where person_id = any($1) and enrichment_stage = 'awaiting_approval' and owner_confirmed and role is not null returning person_id, company_id`, [ids, by]);
  const companies = [...new Set(r.map((x) => x.company_id))];
  if (companies.length) await db.query(`update companies set status_code = 'qualified' where company_id = any($1) and status_code in ('new','researched')`, [companies]);
  const skipped = await db.query(`select person_id from people where person_id = any($1) and enrichment_stage = 'awaiting_approval'`, [ids]);
  return { changed: r.length, not_approved_one_source: skipped.map((x) => x.person_id) };
}
