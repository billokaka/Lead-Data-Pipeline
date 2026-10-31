-- v1.3-enrichment.sql: the scraping and enrichment layer. Run ONCE in the Supabase SQL Editor, on the
-- database that already has v1.1 and v1.2 (workflows/blueprints/). 2026-10-29. All or nothing.
-- Decisions D9-1 to D9-4 (DECISIONS.md); plan in work-records/2026-10-29-scraping-enrichment.md.
--
-- What it adds:
--   1. enrichment_jobs: the shared work queue. Either person asks Claude for a job; any engine claims it.
--   2. a pipeline stage on every company and person, separate from the status the team reads, with a lease
--      (claimed_by, claimed_until) so two machines never work the same rows (for update skip locked).
--   3. Google Maps fields on companies; the evidence on people: who said this is the owner, how the
--      email was found, which lane it is in, what the two verifiers said.
--   4. budgets per tool per day, read before every paid call; costs gain the job, the person and the row.
--   5. two outreach lists: outreach_ready_people (provider emails) and outreach_ready_verified_lane
--      (own-site and pattern emails, sent separately with a stricter bounce stop, D9-1, D9-2).
-- Status codes are unchanged. The stage says where the engine is; the status says where the team is.

begin;

-- =============================================================================================
-- 1. the work queue
-- =============================================================================================
create table if not exists enrichment_jobs (
  job_id        bigint generated always as identity primary key,
  kind          text not null check (kind in ('source', 'enrich')),
  industry_code text references industries (industry_code) on update cascade,
  params        jsonb not null default '{}'::jsonb,
  status        text not null default 'queued' check (status in ('queued','running','paused','done','failed','cancelled')),
  requested_by  text not null check (length(trim(requested_by)) > 0),
  max_cost_usd  numeric(10,2) not null check (max_cost_usd >= 0),
  cost_usd      numeric(12,5) not null default 0,
  progress      jsonb not null default '{}'::jsonb,
  note          text,
  claimed_by    text,
  claimed_until timestamptz,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
create index if not exists enrichment_jobs_status_ix on enrichment_jobs (status, created_at);
create index if not exists enrichment_jobs_industry_ix on enrichment_jobs (industry_code);
comment on table enrichment_jobs is 'The shared work queue. A job is asked for in Claude (who, which industry, where, which sources, the most it may spend) and run by whichever engine claims it.';
comment on column enrichment_jobs.params is 'What the job does, e.g. {"sources":["google_maps","apollo"],"places":["Boston, MA"],"queries":["HVAC contractor"],"max_companies":500}.';
comment on column enrichment_jobs.max_cost_usd is 'The job stops when its spend reaches this.';

-- =============================================================================================
-- 2. companies: Maps fields and the pipeline stage
-- =============================================================================================
alter table companies add column if not exists google_place_id   text;
alter table companies add column if not exists google_category   text;
alter table companies add column if not exists rating            numeric(2,1);
alter table companies add column if not exists review_count      int;
alter table companies add column if not exists enrichment_stage  text not null default 'to_read';
alter table companies add column if not exists stage_note        text;
alter table companies add column if not exists site_read         jsonb;
alter table companies add column if not exists last_job_id       bigint references enrichment_jobs (job_id) on delete set null;
alter table companies add column if not exists claimed_by        text;
alter table companies add column if not exists claimed_until     timestamptz;
alter table companies add column if not exists attempts          int not null default 0;
do $$ begin
  alter table companies add constraint companies_enrichment_stage_check check (enrichment_stage in
    ('not_queued','to_read','to_find_owner','owners_found','no_owner_found','not_fit','needs_review'));
exception when duplicate_object then null; end $$;
create unique index if not exists companies_google_place_id_uq on companies (google_place_id) where google_place_id is not null;
create index if not exists companies_enrichment_stage_ix on companies (enrichment_stage, claimed_until);
create index if not exists companies_last_job_id_ix on companies (last_job_id);
comment on column companies.enrichment_stage is 'Where the engine is: to_read (website not read yet), to_find_owner, owners_found, no_owner_found, not_fit, needs_review. The team reads status_code.';
comment on column companies.site_read is 'What the website read found: the fit answers, each with a quote from the page; owner names; every email printed on the site with the page it was on.';
comment on column companies.google_place_id is 'Google''s id for the listing; the same listing is never added twice.';

-- =============================================================================================
-- 3. people: the evidence and the lanes
-- =============================================================================================
alter table people add column if not exists role              text;
alter table people add column if not exists owner_sources     jsonb not null default '[]'::jsonb;
alter table people add column if not exists owner_confirmed   boolean not null default false;
alter table people add column if not exists enrichment_stage  text not null default 'awaiting_approval';
alter table people add column if not exists stage_note        text;
alter table people add column if not exists approved_by       text;
alter table people add column if not exists approved_at       timestamptz;
alter table people add column if not exists email_method      text;
alter table people add column if not exists email_lane        text;
alter table people add column if not exists email_provider    text;
alter table people add column if not exists email_is_freemail boolean;
alter table people add column if not exists email_catch_all   boolean;
alter table people add column if not exists verifier_a        jsonb;
alter table people add column if not exists verifier_b        jsonb;
alter table people add column if not exists last_job_id       bigint references enrichment_jobs (job_id) on delete set null;
alter table people add column if not exists claimed_by        text;
alter table people add column if not exists claimed_until     timestamptz;
alter table people add column if not exists attempts          int not null default 0;
do $$ begin
  alter table people add constraint people_role_check check (role is null or role in ('owner','ceo','founder','co_founder','president','managing_partner','partner'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table people add constraint people_enrichment_stage_check check (enrichment_stage in
    ('not_queued','awaiting_approval','rejected','to_find_email','to_verify','verified','no_email','needs_review'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table people add constraint people_email_method_check check (email_method is null or email_method in ('provider','own_site','pattern','manual'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table people add constraint people_email_lane_check check (email_lane is null or email_lane in ('main','verified'));
exception when duplicate_object then null; end $$;
-- the lane follows from the method: provider emails are the main lane; own-site and pattern emails the verified lane
do $$ begin
  alter table people add constraint people_lane_matches_method check (
    email_method is null or email_lane is null
    or (email_method in ('provider','manual') and email_lane = 'main')
    or (email_method in ('own_site','pattern') and email_lane = 'verified'));
exception when duplicate_object then null; end $$;
-- a personal address is allowed only from the firm's own site or listing (D9-2)
do $$ begin
  alter table people add constraint people_freemail_only_own_site check (not coalesce(email_is_freemail, false) or email_method = 'own_site');
exception when duplicate_object then null; end $$;
-- a catch-all domain never gives a pattern email (on a catch-all every guess "verifies")
do $$ begin
  alter table people add constraint people_no_pattern_on_catch_all check (not (email_method = 'pattern' and coalesce(email_catch_all, false)));
exception when duplicate_object then null; end $$;
-- rows already in the database were added by hand. The first time this file runs (and only then) they are taken out of
-- the engine's way: companies and people to not_queued, a verified person to verified. Otherwise the first run would
-- enrich, re-approve and re-email the whole table (reviewer, 2026-10-29). A company is queued later by setting its stage
-- to to_read.
do $$ begin
  if not exists (select 1 from flags where name = 'v13_migrated') then
    update companies set enrichment_stage = 'not_queued' where last_job_id is null;
    update people set enrichment_stage = case when status_code = 'verified' then 'verified' else 'not_queued' end where last_job_id is null;
    insert into flags (name, value, set_by, reason, set_at) values ('v13_migrated', true, 'v1.3', 'hand-entered rows taken out of the engine queue', now());
  end if;
end $$;
create index if not exists people_enrichment_stage_ix on people (enrichment_stage, claimed_until);
create index if not exists people_last_job_id_ix on people (last_job_id);
comment on column people.owner_sources is 'Every source that names this person as the owner: [{"source":"website","url":"...","quote":"..."}, ...].';
comment on column people.owner_confirmed is 'True when two independent sources agree. One source is a candidate only.';
comment on column people.enrichment_stage is 'awaiting_approval (a person checks the batch), rejected, to_find_email, to_verify, verified, no_email, needs_review.';
comment on column people.email_method is 'How the email was found: provider (a data provider''s record), own_site (printed on the firm''s site or listing), pattern (a name pattern confirmed by two verifiers), manual.';
comment on column people.email_lane is 'main = provider emails; verified = own-site and pattern emails, sent separately with a stricter bounce stop.';
comment on column people.verifier_a is 'What the first verifier said: {"tool":..., "result":..., "at":...}.';

-- =============================================================================================
-- 4. budgets and costs
-- =============================================================================================
create table if not exists budgets (
  provider   text primary key,
  daily_usd  numeric(10,2) not null check (daily_usd >= 0),
  updated_by text not null,
  updated_at timestamptz not null default now()
);
comment on table budgets is 'The most each tool may spend a day (provider = total for all together). The engine checks this before every paid call; 0 stops a tool.';
insert into budgets (provider, daily_usd, updated_by) values ('total', 25, 'v1.3 default') on conflict do nothing;
-- the stop switch for every engine; changing it needs a name and a reason (the flags guard)
insert into flags (name, value) values ('enrichment_paused', false) on conflict do nothing;
-- one list of free email providers for the database and the engine (engine/src/rules.mjs FREEMAIL is the same list)
insert into freemail_domains (domain) values ('googlemail.com'),('rocketmail.com'),('mac.com'),('bellsouth.net'),('charter.net'),('cox.net'),
  ('earthlink.net'),('optonline.net'),('frontier.com'),('frontiernet.net'),('windstream.net'),('centurylink.net'),('q.com'),('juno.com'),
  ('netzero.net'),('gmx.com'),('zoho.com'),('aim.com'),('roadrunner.com'),('rr.com'),('twc.com'),('embarqmail.com'),('suddenlink.net'),
  ('mediacombb.net'),('ptd.net')
on conflict do nothing;

alter table costs add column if not exists job_id       bigint references enrichment_jobs (job_id) on delete set null;
alter table costs add column if not exists requested_by text;
alter table costs add column if not exists company_id   bigint references companies (company_id) on delete set null;
alter table costs add column if not exists person_id    bigint references people (person_id) on delete set null;
create index if not exists costs_at_ix on costs (at);
create index if not exists costs_job_id_ix on costs (job_id);
create index if not exists costs_company_id_ix on costs (company_id);
create index if not exists costs_person_id_ix on costs (person_id);

create or replace view spend_today with (security_invoker = true) as
  with today as (
    select coalesce(provider, 'unknown') as provider, sum(usd) as usd_today, sum(calls) as calls_today
    from costs where at >= date_trunc('day', now()) group by 1)
  select t.provider, t.usd_today, t.calls_today, b.daily_usd as daily_budget
  from today t left join budgets b on b.provider = t.provider
  union all
  select 'total', coalesce((select sum(usd_today) from today), 0), coalesce((select sum(calls_today) from today), 0),
         (select daily_usd from budgets where provider = 'total');
comment on view spend_today is 'What each tool has spent today against its daily budget, plus the total.';

-- may this provider spend this much more today? (the engine asks before every paid call)
-- "today" is the UTC day. A budget of 0 stops that tool even for calls that cost nothing in dollars (Leadocean's
-- records, Apollo's free search), so 0 always means off.
create or replace function budget_allows(p_provider text, p_usd numeric)
returns boolean language sql stable set search_path = public, pg_temp as $$
  with b as (select (select daily_usd from budgets where provider = p_provider) as tool,
                    (select daily_usd from budgets where provider = 'total') as total)
  select coalesce(b.tool, 1e9) > 0 and coalesce(b.total, 0) > 0
     and coalesce(b.tool, 1e9) >= coalesce((select sum(usd) from costs where provider = p_provider and at >= date_trunc('day', now())), 0) + p_usd
     and coalesce(b.total, 0) >= coalesce((select sum(usd) from costs where at >= date_trunc('day', now())), 0) + p_usd
  from b
$$;

-- =============================================================================================
-- 5. claiming work: each engine takes a batch with a lease; two engines never get the same rows
-- =============================================================================================
create or replace function claim_companies(p_stage text, p_worker text, p_limit int, p_lease_seconds int default 900)
returns setof companies language sql set search_path = public, pg_temp as $$
  -- take the batch first (materialized), then update exactly those rows: an IN (subquery with LIMIT) can be
  -- re-run by the planner and claim more than the limit
  with picked as materialized (
    select x.company_id from companies x
    left join us_states s on s.state_code = x.state_code
    where x.enrichment_stage = p_stage
      and x.status_code not in ('do_not_contact', 'disqualified')
      and not coalesce(s.is_on_hold, false)
      and (x.claimed_until is null or x.claimed_until < now())
      and x.attempts < 5
    order by x.company_id
    limit p_limit
    for update of x skip locked)
  update companies c set claimed_by = p_worker, claimed_until = now() + make_interval(secs => p_lease_seconds)
  from picked where c.company_id = picked.company_id
  returning c.*
$$;

create or replace function claim_people(p_stage text, p_worker text, p_limit int, p_lease_seconds int default 900)
returns setof people language sql set search_path = public, pg_temp as $$
  with picked as materialized (
    select x.person_id from people x
    join companies c on c.company_id = x.company_id
    left join us_states s on s.state_code = c.state_code
    where x.enrichment_stage = p_stage
      and x.status_code <> 'do_not_contact'
      and c.status_code not in ('do_not_contact', 'disqualified')
      and not coalesce(s.is_on_hold, false)
      and (x.claimed_until is null or x.claimed_until < now())
      and x.attempts < 5
    order by x.person_id
    limit p_limit
    for update of x skip locked)
  update people p set claimed_by = p_worker, claimed_until = now() + make_interval(secs => p_lease_seconds)
  from picked where p.person_id = picked.person_id
  returning p.*
$$;

-- a sourcing job can take hours: its lease is 6 hours, so a second machine never re-runs (and re-pays) a live job
create or replace function claim_job(p_worker text, p_lease_seconds int default 21600)
returns setof enrichment_jobs language sql set search_path = public, pg_temp as $$
  with picked as materialized (
    select x.job_id from enrichment_jobs x
    where x.status = 'queued' or (x.status = 'running' and x.claimed_until < now())
    order by x.created_at limit 1
    for update skip locked)
  update enrichment_jobs j set status = 'running', claimed_by = p_worker,
         claimed_until = now() + make_interval(secs => p_lease_seconds), started_at = coalesce(j.started_at, now())
  from picked where j.job_id = picked.job_id
  returning j.*
$$;

-- one loader at a time: two engines calling load_imports() together would race on the same pending rows
create or replace function load_imports_locked(tool_for_unlabelled text default 'other')
returns table (import_table text, result text, rows_count bigint)
language plpgsql set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext('wraith.load_imports'));
  return query select * from load_imports(tool_for_unlabelled);
end $$;

-- after a sourcing job's rows are loaded: the Maps fields, the job, and the job's industry where none was mapped
alter table import_companies add column if not exists job_id          bigint references enrichment_jobs (job_id) on delete set null;
alter table import_companies add column if not exists google_place_id text;
alter table import_companies add column if not exists google_category text;
alter table import_companies add column if not exists rating          numeric(2,1);
alter table import_companies add column if not exists review_count    int;
create index if not exists import_companies_job_id_ix on import_companies (job_id);

create or replace function apply_job_imports(p_job_id bigint)
returns int language plpgsql set search_path = public, pg_temp as $$
declare n int;
begin
  update companies c set
    google_place_id = coalesce(c.google_place_id, i.google_place_id),
    google_category = coalesce(c.google_category, i.google_category),
    rating          = coalesce(c.rating, i.rating),
    review_count    = coalesce(c.review_count, i.review_count),
    industry_code   = coalesce(c.industry_code, j.industry_code),
    last_job_id     = p_job_id
  from import_companies i
  join enrichment_jobs j on j.job_id = i.job_id
  where i.job_id = p_job_id and i.company_id = c.company_id and i.import_status in ('added', 'merged')
    and (i.google_place_id is null or not exists (select 1 from companies o where o.google_place_id = i.google_place_id and o.company_id <> c.company_id));
  get diagnostics n = row_count;
  return n;
end $$;

-- =============================================================================================
-- 6. the views: directories with the new fields; the two outreach lanes; progress by industry
-- =============================================================================================
drop view if exists outreach_ready_people;
drop view if exists outreach_ready_verified_lane;
drop view if exists people_directory;

create view people_directory with (security_invoker = true) as
  select p.person_id, p.first_name, p.last_name, p.designation, p.email, p.email_source, p.email_checked_at,
         p.phone_number, p.linkedin_url, ps.name as status,
         c.company_id, c.company_name as company, c.website, c.city, c.state_code, s.region,
         s.is_on_hold as state_on_hold, coalesce(i.name, 'Unsorted') as industry, b.name as business_type,
         cs.name as company_status, p.suppression_cause, p.source, p.notes, p.created_at, p.updated_at,
         p.role, p.owner_confirmed, p.enrichment_stage, p.email_method, p.email_lane, p.email_is_freemail
  from people p
  join companies c         on c.company_id = p.company_id
  join person_statuses ps  on ps.status_code = p.status_code
  join company_statuses cs on cs.status_code = c.status_code
  join business_types b    on b.business_type_code = c.business_type_code
  left join us_states s    on s.state_code = c.state_code
  left join industries i   on i.industry_code = c.industry_code;
comment on view people_directory is 'Read-only list of people with their company, website, state, industry, business type, and how the owner and the email were found. Filter it by any column. Edit in the people table.';

-- the rule both lanes share: qualified company, verified person, fresh check, clear state, nothing suppressed;
-- for engine rows also a confirmed owner (hand-entered rows have no lane and were checked by a person)
create or replace function ready_to_email(p people, c companies)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select c.status_code = 'qualified'
     and p.status_code = 'verified'
     and p.email is not null
     and p.email_checked_at >= current_date - 30
     and (p.email_lane is null or p.owner_confirmed)
     and not coalesce((select s.is_on_hold from us_states s where s.state_code = c.state_code), true)
     and not exists (
       select 1 from suppression x
       where (x.match_type = 'email'  and x.value = p.email)
          or (x.match_type = 'domain' and x.value = c.website_domain)
          or (x.match_type = 'domain' and x.value = person_firm_domain(p.email)))
$$;

create view outreach_ready_people with (security_invoker = true) as
  select pd.* from people_directory pd
  join people p on p.person_id = pd.person_id
  join companies c on c.company_id = p.company_id
  where coalesce(p.email_lane, 'main') = 'main' and ready_to_email(p, c);
comment on view outreach_ready_people is 'The main lane: who may be emailed now with a provider-found email. Qualified company, verified person (owner confirmed by two sources), email checked in the last 30 days, a clear state, no suppression match. Read-only.';

create view outreach_ready_verified_lane with (security_invoker = true) as
  select pd.* from people_directory pd
  join people p on p.person_id = pd.person_id
  join companies c on c.company_id = p.company_id
  where p.email_lane = 'verified' and ready_to_email(p, c);
comment on view outreach_ready_verified_lane is 'The verified lane: own-site and pattern emails (D9-1, D9-2), same rules as the main lane. Sent in their own campaigns with a stricter bounce stop, never mixed with the main lane.';

create or replace view pipeline_by_industry with (security_invoker = true) as
  select coalesce(i.name, 'Unsorted') as industry, 'company' as kind, c.enrichment_stage as stage, count(*) as rows
  from companies c left join industries i on i.industry_code = c.industry_code
  group by 1, 2, 3
  union all
  select coalesce(i.name, 'Unsorted'), 'person', p.enrichment_stage, count(*)
  from people p join companies c on c.company_id = p.company_id left join industries i on i.industry_code = c.industry_code
  group by 1, 2, 3;
comment on view pipeline_by_industry is 'How many companies and people sit at each stage, per industry.';

-- =============================================================================================
-- 7. security: same as everything else
-- =============================================================================================
alter table enrichment_jobs enable row level security;
alter table budgets         enable row level security;
revoke all on enrichment_jobs, budgets, spend_today, people_directory, outreach_ready_people,
              outreach_ready_verified_lane, pipeline_by_industry from anon, authenticated;
revoke execute on function budget_allows(text, numeric), claim_companies(text, text, int, int), claim_people(text, text, int, int),
  claim_job(text, int), load_imports_locked(text), apply_job_imports(bigint), ready_to_email(people, companies)
  from public, anon, authenticated;

commit;

-- read-back
select (select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('enrichment_jobs', 'budgets')) as new_tables,
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'people'
          and column_name in ('owner_sources', 'owner_confirmed', 'email_lane', 'email_method', 'verifier_a', 'verifier_b')) as people_evidence_columns,
       (select daily_usd from budgets where provider = 'total') as total_daily_budget_usd,
       (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity) as tables_without_rls;
