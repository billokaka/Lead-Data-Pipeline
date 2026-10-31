// money.mjs: the only way a provider call that costs money is made.
//   1. paid calls are off unless ENRICH_ALLOW_SPEND is true
//   2. the tool's daily budget and the total budget (budgets table, budget_allows) must allow the estimate
//   3. the job's own ceiling (enrichment_jobs.max_cost_usd) must allow it
//   4. the real cost (from the provider, else the estimate) is written to costs with the job, the person and the row,
//      and added to the job, whether the call found something or not

export class SpendRefused extends Error {}

export function makeSpender({ db, config, redact = (s) => s }) {
  return async function paid({ provider, step, estUsd, jobId = null, companyId = null, personId = null }, fn) {
    if (!config.allowSpend) throw new SpendRefused('paid calls are switched off (ENRICH_ALLOW_SPEND is not true)');
    // the pause switch is read before every paid call, not only between batches
    const paused = await db.one(`select value from flags where name = 'enrichment_paused'`);
    if (paused?.value) throw new SpendRefused('every engine is paused (enrichment_paused)');
    const est = Math.max(0, Number(estUsd) || 0);
    const ok = await db.one('select budget_allows($1, $2) as ok', [provider, est]);
    if (!ok?.ok) throw new SpendRefused(`today's budget for ${provider} (or the total) would be passed`);
    if (jobId) {
      const j = await db.one('select cost_usd, max_cost_usd, status from enrichment_jobs where job_id = $1', [jobId]);
      if (j && ['paused', 'cancelled'].includes(j.status)) throw new SpendRefused(`job ${jobId} is ${j.status}`);
      if (j && Number(j.cost_usd) + est > Number(j.max_cost_usd)) throw new SpendRefused(`job ${jobId} would pass its ceiling of $${j.max_cost_usd}`);
    }
    let result, usd = est, calls = 1, failed = null;
    try {
      const r = await fn();
      // { result: null } is a miss and stays null; never the wrapper object itself
      result = r && typeof r === 'object' && 'result' in r ? r.result : r;
      if (Number.isFinite(r?.usd)) usd = r.usd;
      if (Number.isFinite(r?.calls)) calls = r.calls;
    } catch (e) { failed = e; }
    await db.query(
      `insert into costs (run_id, step, provider, calls, usd, note, job_id, requested_by, company_id, person_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [`${config.person}:${jobId ?? 'adhoc'}`, step, provider, calls, usd, failed ? redact(String(failed.message)).slice(0, 200) : null,
        jobId, config.person, companyId, personId]);
    if (jobId) await db.query('update enrichment_jobs set cost_usd = cost_usd + $2 where job_id = $1', [jobId, usd]);
    if (failed) throw failed;
    return result;
  };
}
