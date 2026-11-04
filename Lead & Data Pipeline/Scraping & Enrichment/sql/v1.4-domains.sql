-- v1.4-domains.sql: the domain pre-filter (stages 1, 2, 5-lite, 8 and 9 of "Building the Verifier"). Run ONCE in the
-- Supabase SQL Editor, after v1.3. 2026-11-03. All or nothing. It can be run again safely.
--
-- What it adds:
--   1. email_domains: one row per company domain, the free DNS facts (is it alive, who runs its mail, SPF, DMARC,
--      age) and the catch-all answer, each with the time it was checked and when it expires. Company facts only:
--      no person's data.
--   2. email_checks: one row per checked address, the result of verify-list, so an address is never paid for twice
--      while its result is fresh.
--   3. the website check (free) and the Google index check (paid, about $0.001 a domain, cached 30 days).
--   4. two company stages: to_check_domain (new companies wait for the domain check before the website read) and
--      dead_domain (the domain cannot take mail: nothing more is spent on it).

begin;

create table if not exists email_domains (
  domain               text primary key check (domain = lower(domain) and domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  verdict              text not null check (verdict in ('alive', 'weak', 'dead', 'unknown')),
  reason               text,
  dns_status           text,            -- ok, nxdomain, refused, servfail, timeout, no_mx, null_mx, parked, mx_unresolved
  mx_hosts             text[],
  mx_primary           text,
  provider             text,            -- google_workspace, microsoft_365, proofpoint, mimecast, barracuda, cisco, zoho, yahoo, fastmail, other, none
  is_gateway           boolean,
  nameservers          text[],
  has_spf              boolean,
  has_dmarc            boolean,
  registered_at        date,
  domain_age_days      int,
  recently_registered  boolean,
  is_catch_all         boolean,
  catch_all_source     text,            -- millionverifier (a paid probe), gateway (no probe: gateways accept everything)
  checked_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  age_checked_at       timestamptz,
  catch_all_checked_at timestamptz,
  catch_all_expires_at timestamptz
);
-- the website and Google index checks (added 2026-11-03): is there a site at all, and does Google know it
alter table email_domains add column if not exists website_status       text;   -- live, blocked, error, down, for_sale
alter table email_domains add column if not exists website_redirects_to text;   -- another firm's domain the site sends visitors to
alter table email_domains add column if not exists website_checked_at   timestamptz;
alter table email_domains add column if not exists website_expires_at   timestamptz;
alter table email_domains add column if not exists google_indexed       boolean;
alter table email_domains add column if not exists google_results       int;
alter table email_domains add column if not exists google_source        text;   -- serper (a paid search), probing, undecided
alter table email_domains add column if not exists google_checked_at    timestamptz;
alter table email_domains add column if not exists google_expires_at    timestamptz;
create index if not exists email_domains_verdict_ix on email_domains (verdict);
create index if not exists email_domains_expires_ix on email_domains (expires_at);
comment on table email_domains is 'The domain pre-filter cache: one row per company domain. alive = takes mail; weak = no MX, only a website address (mail rarely works; kept, flagged); dead = cannot (no DNS, refused, parked, null MX, MX host gone); unknown = DNS failed, try again later.';

create table if not exists email_checks (
  email           text primary key check (email = lower(email)),
  status          text not null check (status in ('valid', 'invalid', 'catch_all', 'unknown', 'dead_domain', 'bad_syntax', 'disposable')),
  quality         text not null check (quality in ('good', 'risky', 'bad')),
  substatus       text,
  checked_by      text,
  checked_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);
create index if not exists email_checks_expires_ix on email_checks (expires_at);
comment on table email_checks is 'The address check cache (verify-list): valid 30 days, invalid 60, catch_all 21, unknown 3.';

-- the two new company stages
alter table companies drop constraint if exists companies_enrichment_stage_check;
alter table companies add constraint companies_enrichment_stage_check check (enrichment_stage in
  ('not_queued','to_check_domain','to_read','to_find_owner','owners_found','no_owner_found','not_fit','dead_domain','needs_review'));
comment on column companies.enrichment_stage is 'Where the engine is: to_check_domain (domain not checked yet), to_read (website not read yet), to_find_owner, owners_found, no_owner_found, not_fit, dead_domain (the domain cannot take mail), needs_review. The team reads status_code.';

-- never reachable from the public API keys
alter table email_domains enable row level security;
alter table email_checks enable row level security;
revoke all on email_domains, email_checks from public, anon, authenticated;

commit;

-- read-back
select (select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('email_domains', 'email_checks')) as new_tables,
       (select pg_get_constraintdef(oid) like '%to_check_domain%dead_domain%' from pg_constraint where conname = 'companies_enrichment_stage_check') as new_stages,
       (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity) as tables_without_rls;
