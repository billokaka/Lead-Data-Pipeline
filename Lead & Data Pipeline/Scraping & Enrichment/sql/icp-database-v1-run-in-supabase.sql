-- icp-database-v1-run-in-supabase.sql: paste this whole file into the Supabase SQL Editor and click Run.
-- For a NEW project: icp-schema-v1.sql + icp-suppression-v1.sql (one transaction), then icp-v1.2-imports.sql
-- (its own transaction). v1.2, 2026-10-26. Re-running is safe. The live project built on 2026-10-26 gets the v1.1 and v1.2 files instead.
-- The last query prints the read-back: expect 51 states, 7 on hold, 14 industries, 4 business types, 5 and 8 statuses, 2 import tables, 0 tables without RLS.

begin;

-- icp-schema-v1.sql: the Wraith Brokerage ICP database, part 1 of 2 (companies and people)
-- v1, 2026-10-26. Plan: C:\Users\Ibraheem\.claude\plans\so-we-gonna-do-elegant-frost.md;
-- record: work-records/2026-10-26-icp-database.md; guide for a non-technical user:
-- workflows/blueprints/icp-database-guide.md. Part 2 (step 0's suppression rules, re-pointed here):
-- workflows/blueprints/icp-suppression-v1.sql, run after this file.
--
-- The shape is a star: five lookup tables hold every allowed value once (industries, business
-- types, US states, company statuses, person statuses); companies point to them; people point to
-- their company and never copy its name or website. Two views put the names back together.
--
-- Rules kept from the method (playbooks/data-management-enrichment.md sections 3 and 4; lessons 2.5, 2.6):
--   one firm one row, deduped on the normalised website domain (platform hosts such as facebook.com
--   never count as a website), else on name + city + state; one person one row, deduped on the email,
--   the normalised LinkedIn URL, or company plus name when there is no email; do_not_contact can only
--   be cleared by unsuppress() (part 2) and a do_not_contact row cannot be deleted; status codes are
--   fixed because the logic reads them.
-- Security: RLS on every table with no policies for anon or authenticated, and their grants revoked
--   (also for objects created later): only the dashboard (postgres) and the n8n service key reach the
--   data. Views are security_invoker. get_advisors will list rls_enabled_no_policy (INFO) for each
--   table: that is intended.
-- No begin/commit here: apply_migration runs the file as one transaction; for a dry run, wrap it in
-- begin ... rollback. Postgres 15+ (Supabase runs 17).

-- =============================================================================================
-- 0. helpers: one way to normalise a domain, an email, a LinkedIn URL
-- =============================================================================================
create or replace function norm_domain(t text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select nullif(regexp_replace(lower(trim(coalesce(t,''))),
         '^(https?://)?(www\.)?([^/:?#]+).*$', '\3'), '')
$$;
comment on function norm_domain(text) is 'Turns any website or URL into its bare domain: https://www.Acme.com/about -> acme.com.';

-- a company's own domain: null when the "website" is a shared platform or a free email host, because
-- those never identify one firm
create or replace function company_domain(t text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when d is null or d = any (array[
      'facebook.com','m.facebook.com','fb.com','instagram.com','linkedin.com','x.com','twitter.com',
      'youtube.com','tiktok.com','linktr.ee','yelp.com','google.com','sites.google.com','maps.google.com',
      'goo.gl','business.site','bbb.org','angi.com','homeadvisor.com','thumbtack.com','nextdoor.com',
      'gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','comcast.net'])
    then null else d end
  from (select norm_domain(t) as d) x
$$;
comment on function company_domain(text) is 'The company''s own domain from its website, or empty when the website is a shared platform (Facebook, Yelp, Linktree...) or a free email host.';

create or replace function norm_email(t text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select nullif(lower(trim(coalesce(t,''))), '')
$$;
comment on function norm_email(text) is 'Trims and lowercases an email; blank becomes empty (null).';

create or replace function norm_linkedin(t text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select nullif(regexp_replace(regexp_replace(regexp_replace(lower(trim(coalesce(t,''))),
           '^(https?://)?([a-z]{2,3}\.)?', ''), '[?#].*$', ''), '/+$', ''), '')
$$;
comment on function norm_linkedin(text) is 'LinkedIn URL without scheme, www, query or trailing slash, so one profile has one form.';

-- =============================================================================================
-- 1. lookup tables (the dimensions). Each key is a short readable word, so a cell that points to it
--    reads as a word in the Table Editor.
-- =============================================================================================
create table if not exists industries (
  industry_code text primary key check (industry_code ~ '^[a-z][a-z0-9_]*$'),
  name          text not null unique,
  description   text,
  is_active     boolean not null default true,
  sort_order    int not null default 100
);
comment on table industries is 'The list of industries a company can be in. Add a row here to add a new industry; every company picks one.';
comment on column industries.industry_code is 'Short code, lowercase with underscores (e.g. hvac). This is what a company row stores.';
comment on column industries.name is 'The name people read (e.g. HVAC).';
comment on column industries.is_active is 'True for industries being worked now; false for reserves.';
comment on column industries.sort_order is 'Order in lists; lower first.';

insert into industries (industry_code, name, description, is_active, sort_order) values
  ('property_management','Property management','Residential and commercial property managers',true,10),
  ('hvac','HVAC','Heating, ventilation and air conditioning contractors',true,20),
  ('landscaping','Landscaping','Landscaping and grounds maintenance',true,30),
  ('software','Software','Vertical and B2B software companies',true,40),
  ('janitorial','Janitorial','Commercial cleaning and janitorial services',true,50),
  ('security','Security','Alarm, fire and security systems',true,60),
  ('insurance_agency','Insurance agency','Independent insurance agencies',true,70),
  ('waste_hauling','Waste and recycling hauling','Waste collection and recycling haulers',true,80),
  ('plumbing','Plumbing','Plumbing contractors',true,90),
  ('roofing','Roofing','Roofing contractors (reserve)',false,110),
  ('auto_repair','Auto repair and collision','Auto repair and collision shops (reserve)',false,120),
  ('electrical','Electrical','Electrical contractors (reserve)',false,130),
  ('cpa_firm','CPA firm','Accounting and CPA firms (reserve)',false,140),
  ('other','Other','Anything not listed yet; say what in the company notes',true,999)
on conflict (industry_code) do nothing;

create table if not exists business_types (
  business_type_code text primary key check (business_type_code ~ '^[a-z][a-z0-9_]*$'),
  name               text not null unique,
  description        text,
  sort_order         int not null default 100
);
comment on table business_types is 'Who the company sells to: other businesses (B2B), consumers (B2C) or both. Every company picks one; use unknown until it is checked.';
comment on column business_types.business_type_code is 'Short code (e.g. b2b). This is what a company row stores.';

-- v1.1, 2026-10-26: business type means who the company sells to (operator: "Business type means
-- here that B2B or B2C"); the ownership list it replaced is gone (icp-v1.1-business-type-b2b-b2c.sql)
insert into business_types (business_type_code, name, description, sort_order) values
  ('b2b','B2B','Sells to other businesses',10),
  ('b2c','B2C','Sells to consumers',20),
  ('both','B2B and B2C','Sells to both businesses and consumers',30),
  ('unknown','Unknown','Not checked yet',99)
on conflict (business_type_code) do nothing;

create table if not exists us_states (
  state_code  char(2) primary key check (state_code ~ '^[A-Z]{2}$'),
  name        text not null unique,
  region      text not null check (region in ('New England','Mid-Atlantic','South','Midwest','West')),
  is_on_hold  boolean not null default false,
  hold_reason text,
  constraint us_states_hold_has_reason check (not is_on_hold or hold_reason is not null)
);
comment on table us_states is 'The 50 US states and DC, with their region and whether outreach there is on hold. Hold states are never emailed (DECISIONS.md).';
comment on column us_states.state_code is 'Two-letter code (e.g. MA). This is what a company row stores.';
comment on column us_states.region is 'New England, Mid-Atlantic, South, Midwest or West.';
comment on column us_states.is_on_hold is 'True means nobody in this state is emailed until the hold is lifted.';
comment on column us_states.hold_reason is 'Why the state is on hold; required when on hold.';

insert into us_states (state_code, name, region) values
  ('CT','Connecticut','New England'),('ME','Maine','New England'),('MA','Massachusetts','New England'),
  ('NH','New Hampshire','New England'),('RI','Rhode Island','New England'),('VT','Vermont','New England'),
  ('NJ','New Jersey','Mid-Atlantic'),('NY','New York','Mid-Atlantic'),('PA','Pennsylvania','Mid-Atlantic'),
  ('IL','Illinois','Midwest'),('IN','Indiana','Midwest'),('MI','Michigan','Midwest'),('OH','Ohio','Midwest'),
  ('WI','Wisconsin','Midwest'),('IA','Iowa','Midwest'),('KS','Kansas','Midwest'),('MN','Minnesota','Midwest'),
  ('MO','Missouri','Midwest'),('NE','Nebraska','Midwest'),('ND','North Dakota','Midwest'),('SD','South Dakota','Midwest'),
  ('DE','Delaware','South'),('FL','Florida','South'),('GA','Georgia','South'),('MD','Maryland','South'),
  ('NC','North Carolina','South'),('SC','South Carolina','South'),('VA','Virginia','South'),
  ('DC','District of Columbia','South'),('WV','West Virginia','South'),('AL','Alabama','South'),
  ('KY','Kentucky','South'),('MS','Mississippi','South'),('TN','Tennessee','South'),('AR','Arkansas','South'),
  ('LA','Louisiana','South'),('OK','Oklahoma','South'),('TX','Texas','South'),
  ('AZ','Arizona','West'),('CO','Colorado','West'),('ID','Idaho','West'),('MT','Montana','West'),
  ('NV','Nevada','West'),('NM','New Mexico','West'),('UT','Utah','West'),('WY','Wyoming','West'),
  ('AK','Alaska','West'),('CA','California','West'),('HI','Hawaii','West'),('OR','Oregon','West'),
  ('WA','Washington','West')
on conflict (state_code) do nothing;

update us_states set is_on_hold = true, hold_reason = r.reason
from (values
  ('CA','Affiliate or licence rule (DECISIONS.md hold states, 2026-10-22)'),
  ('FL','Affiliate or licence rule (DECISIONS.md hold states, 2026-10-22)'),
  ('CO','Affiliate or licence rule (DECISIONS.md hold states, 2026-10-22)'),
  ('AZ','Affiliate or licence rule (DECISIONS.md hold states, 2026-10-22)'),
  ('RI','Real estate licence rule (new-england-check-2026-10-22)'),
  ('MI','Until confirmed (DECISIONS.md hold states, 2026-10-22)'),
  ('MN','Until confirmed (DECISIONS.md hold states, 2026-10-22)')) r(code, reason)
where us_states.state_code = r.code and not us_states.is_on_hold;

create table if not exists company_statuses (
  status_code text primary key check (status_code ~ '^[a-z][a-z0-9_]*$'),
  name        text not null unique,
  description text,
  sort_order  int not null default 100
);
comment on table company_statuses is 'Where a company stands. Every company has one. The codes are fixed (the rules read them); names and descriptions can be edited.';

insert into company_statuses (status_code, name, description, sort_order) values
  ('new','New','Added, not researched yet',10),
  ('researched','Researched','Website and owner checked',20),
  ('qualified','Qualified','Fits the target; its verified people can be emailed',30),
  ('disqualified','Disqualified','Does not fit (say why in notes)',40),
  ('do_not_contact','Do not contact','Never contact. Only cleared by unsuppress() with a name and a reason',50)
on conflict (status_code) do nothing;

create table if not exists person_statuses (
  status_code text primary key check (status_code ~ '^[a-z][a-z0-9_]*$'),
  name        text not null unique,
  description text,
  sort_order  int not null default 100
);
comment on table person_statuses is 'Where a person stands. Every person has one. The codes are fixed (the rules read them); names and descriptions can be edited.';

insert into person_statuses (status_code, name, description, sort_order) values
  ('new','New','Added, email not verified yet',10),
  ('verified','Verified','Owner confirmed from two sources and email verified twice; ready to email',20),
  ('contacted','Contacted','In a sequence now',30),
  ('replied','Replied','Replied; a person handles the thread',40),
  ('meeting_booked','Meeting booked','A meeting with Ryan is booked',50),
  ('not_interested','Not interested','Said no',60),
  ('bounced','Bounced','The email bounced',70),
  ('do_not_contact','Do not contact','Never contact. Only cleared by unsuppress() with a name and a reason',80)
on conflict (status_code) do nothing;

-- the status codes are read by the rules: they cannot be renamed or deleted
create or replace function lock_status_codes() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' or new.status_code <> old.status_code then
    raise exception 'Status codes are fixed because the rules read them. Edit the name or description instead.';
  end if;
  return new;
end $$;
drop trigger if exists company_statuses_lock on company_statuses;
create trigger company_statuses_lock before update or delete on company_statuses for each row execute function lock_status_codes();
drop trigger if exists person_statuses_lock on person_statuses;
create trigger person_statuses_lock before update or delete on person_statuses for each row execute function lock_status_codes();

-- =============================================================================================
-- 2. companies: one row per firm
-- =============================================================================================
create table if not exists companies (
  company_id         bigint generated always as identity primary key,
  company_name       text not null check (length(trim(company_name)) > 0),
  website            text,
  website_domain     text generated always as (company_domain(website)) stored,
  city               text,
  state_code         char(2) references us_states (state_code) on update cascade,
  industry_code      text references industries (industry_code) on update cascade,
  business_type_code text not null default 'unknown' references business_types (business_type_code) on update cascade,
  status_code        text not null default 'new' references company_statuses (status_code),
  suppression_cause  text,
  linkedin_url       text check (linkedin_url is null or linkedin_url ~* '^https?://([a-z]+\.)?linkedin\.com/'),
  source             text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists companies_website_domain_uq on companies (website_domain) where website_domain is not null;
create unique index if not exists companies_name_place_uq on companies (lower(company_name), lower(coalesce(city, '')), coalesce(state_code, ''))
  where website_domain is null;
create index if not exists companies_state_code_ix on companies (state_code);
create index if not exists companies_industry_code_ix on companies (industry_code);
create index if not exists companies_business_type_code_ix on companies (business_type_code);
create index if not exists companies_status_code_ix on companies (status_code);

comment on table companies is 'One row per company (firm). The same website cannot be entered twice; without a website, the same name in the same city and state cannot.';
comment on column companies.company_id is 'Automatic number; do not type it.';
comment on column companies.company_name is 'The company''s name. Required.';
comment on column companies.website is 'The company''s own website, any form (https://www.acme.com or acme.com). A Facebook, Yelp or Linktree page is not a website: put it in notes.';
comment on column companies.website_domain is 'Filled automatically from the website. Two companies cannot share it: this is the duplicate check. Empty when the website is a shared platform.';
comment on column companies.city is 'City of the head office.';
comment on column companies.state_code is 'State of the head office; pick from the list (us_states).';
comment on column companies.industry_code is 'Industry; pick from the list (industries).';
comment on column companies.business_type_code is 'B2B, B2C or both; pick from the list (business_types). Starts as unknown.';
comment on column companies.status_code is 'Where it stands; pick from the list (company_statuses). Starts as new.';
comment on column companies.suppression_cause is 'Why the company is do_not_contact, filled by the suppression check or by a person.';
comment on column companies.linkedin_url is 'The company''s LinkedIn page, if known.';
comment on column companies.source is 'Where this company came from (e.g. google_maps, lemlist, manual).';
comment on column companies.notes is 'Anything worth knowing, in plain words.';

-- =============================================================================================
-- 3. people: one row per person, always tied to a company
-- =============================================================================================
create table if not exists people (
  person_id         bigint generated always as identity primary key,
  company_id        bigint not null references companies (company_id) on delete restrict,
  first_name        text not null check (length(trim(first_name)) > 0),
  last_name         text,
  designation       text,
  email             text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  email_source      text,
  email_checked_at  date,
  phone_number      text,
  linkedin_url      text check (linkedin_url is null or linkedin_url ~* '^https?://([a-z]+\.)?linkedin\.com/'),
  status_code       text not null default 'new' references person_statuses (status_code),
  suppression_cause text,
  source            text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists people_email_uq on people (email) where email is not null;
create unique index if not exists people_linkedin_url_uq on people (norm_linkedin(linkedin_url)) where linkedin_url is not null;
create unique index if not exists people_company_name_uq on people (company_id, lower(first_name), lower(coalesce(last_name, ''))) where email is null;
create index if not exists people_company_id_ix on people (company_id);
create index if not exists people_status_code_ix on people (status_code);

comment on table people is 'One row per person, always linked to a company. The company name and website are not typed here: see people_directory.';
comment on column people.person_id is 'Automatic number; do not type it.';
comment on column people.company_id is 'The company this person works at; pick it from the list. Add the company first.';
comment on column people.first_name is 'First name. Required.';
comment on column people.last_name is 'Last name.';
comment on column people.designation is 'Job title (e.g. Owner, President, CEO).';
comment on column people.email is 'Work email, from a provider''s records, never guessed. Saved in lowercase. The same email cannot be entered twice.';
comment on column people.email_source is 'Which provider and record the email came from (e.g. treg:12345).';
comment on column people.email_checked_at is 'Date the email last passed verification. Must be within 30 days for the person to be emailed.';
comment on column people.phone_number is 'Phone number, any format.';
comment on column people.linkedin_url is 'The person''s LinkedIn profile URL. The same profile cannot be entered twice.';
comment on column people.status_code is 'Where this person stands; pick from the list (person_statuses). Starts as new.';
comment on column people.suppression_cause is 'Why the person is do_not_contact, filled by the suppression check or by a person.';
comment on column people.source is 'Where this person came from (e.g. treg, lemlist, manual).';
comment on column people.notes is 'Anything worth knowing, in plain words.';

-- =============================================================================================
-- 4. triggers: tidy on every save; do_not_contact can be neither cleared nor deleted by hand
-- =============================================================================================
create or replace function tidy_company() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.company_name := trim(new.company_name);
  new.website      := nullif(trim(new.website), '');
  new.city         := nullif(trim(new.city), '');
  new.linkedin_url := nullif(trim(new.linkedin_url), '');
  new.updated_at   := now();
  return new;
end $$;
drop trigger if exists companies_tidy on companies;
create trigger companies_tidy before insert or update on companies for each row execute function tidy_company();

create or replace function tidy_person() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.first_name   := trim(new.first_name);
  new.last_name    := nullif(trim(new.last_name), '');
  new.designation  := nullif(trim(new.designation), '');
  new.email        := norm_email(new.email);
  new.phone_number := nullif(trim(new.phone_number), '');
  new.linkedin_url := nullif(trim(new.linkedin_url), '');
  new.updated_at   := now();
  return new;
end $$;
drop trigger if exists people_tidy on people;
create trigger people_tidy before insert or update on people for each row execute function tidy_person();

create or replace function guard_do_not_contact() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.status_code = 'do_not_contact' then
      raise exception 'This row is do_not_contact (%). It is kept so it is never added again; it cannot be deleted.',
        coalesce(old.suppression_cause, 'no cause recorded');
    end if;
    return old;
  end if;
  if old.status_code = 'do_not_contact' and new.status_code <> 'do_not_contact'
     and coalesce(current_setting('app.unsuppress', true), '') <> 'person' then
    raise exception 'This row is do_not_contact (%). Only unsuppress(table, id, who, why) can clear it.',
      coalesce(old.suppression_cause, 'no cause recorded');
  end if;
  return new;
end $$;
drop trigger if exists companies_guard_do_not_contact on companies;
create trigger companies_guard_do_not_contact before update or delete on companies for each row execute function guard_do_not_contact();
drop trigger if exists people_guard_do_not_contact on people;
create trigger people_guard_do_not_contact before update or delete on people for each row execute function guard_do_not_contact();

-- =============================================================================================
-- 5. readable views: the names put back together. Read these; edit the tables.
--    Dropped first so a re-run can rebuild them even after a later file widened them
--    (outreach_ready_people is built on people_directory; part 2 recreates it).
-- =============================================================================================
drop view if exists outreach_ready_people;
drop view if exists people_directory;
drop view if exists company_directory;
create view company_directory with (security_invoker = true) as
  select c.company_id,
         c.company_name,
         c.website,
         c.website_domain,
         c.city,
         c.state_code,
         s.name        as state,
         s.region,
         s.is_on_hold  as state_on_hold,
         i.name        as industry,
         b.name        as business_type,
         cs.name       as status,
         c.suppression_cause,
         c.linkedin_url,
         (select count(*) from people p where p.company_id = c.company_id) as people_count,
         c.source,
         c.notes,
         c.created_at,
         c.updated_at
  from companies c
  left join us_states s    on s.state_code = c.state_code
  left join industries i   on i.industry_code = c.industry_code
  join business_types b    on b.business_type_code = c.business_type_code
  join company_statuses cs on cs.status_code = c.status_code;
comment on view company_directory is 'Read-only list of companies with every name spelled out. Edit in the companies table.';

create view people_directory with (security_invoker = true) as
  select p.person_id,
         p.first_name,
         p.last_name,
         p.designation,
         p.email,
         p.email_source,
         p.email_checked_at,
         p.phone_number,
         p.linkedin_url,
         ps.name        as status,
         c.company_id,
         c.company_name as company,
         c.website,
         c.city,
         c.state_code,
         s.region,
         s.is_on_hold   as state_on_hold,
         i.name         as industry,
         b.name         as business_type,
         cs.name        as company_status,
         p.suppression_cause,
         p.source,
         p.notes,
         p.created_at,
         p.updated_at
  from people p
  join companies c         on c.company_id = p.company_id
  join person_statuses ps  on ps.status_code = p.status_code
  join company_statuses cs on cs.status_code = c.status_code
  join business_types b    on b.business_type_code = c.business_type_code
  left join us_states s    on s.state_code = c.state_code
  left join industries i   on i.industry_code = c.industry_code;
comment on view people_directory is 'Read-only list of people with their company name, website, state, industry and business type. Filter it by any column. Edit in the people table.';

-- =============================================================================================
-- 6. security: RLS on, no policies, no API grants; the same for anything created later
-- =============================================================================================
alter table industries       enable row level security;
alter table business_types   enable row level security;
alter table us_states        enable row level security;
alter table company_statuses enable row level security;
alter table person_statuses  enable row level security;
alter table companies        enable row level security;
alter table people           enable row level security;

revoke all on industries, business_types, us_states, company_statuses, person_statuses, companies, people,
              company_directory, people_directory
  from anon, authenticated;

revoke execute on function norm_domain(text), company_domain(text), norm_email(text), norm_linkedin(text),
  lock_status_codes(), tidy_company(), tidy_person(), guard_do_not_contact()
  from public, anon, authenticated;

alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

-- Read-back after running (lesson 2.1: a write not read back does not count):
--   select count(*), count(*) filter (where is_on_hold) from us_states;                     -- 51, 7
--   select count(*) from industries;                                                       -- 14
--   select count(*) from business_types;                                                   -- 4
--   select (select count(*) from company_statuses), (select count(*) from person_statuses); -- 5, 8

-- icp-suppression-v1.sql: the Wraith Brokerage ICP database, part 2 of 2 (step 0's rules)
-- v1, 2026-10-26. Run after icp-schema-v1.sql. Carried over from
-- step0-schema.OUTDATED-2026-10-26.sql: the suppression table and its rebuild, protected names, the
-- HubSpot and Smartlead pulls, the planted-row gate, the kill switch, costs, and the old Smartlead
-- contacts (workflows/design/2026-10-25-legacy-contacts.md), re-pointed at companies and people.
--
-- What changed from step 0, said plainly:
--   - "suppressed" is now the status do_not_contact, with the reason in suppression_cause.
--   - Hold states are no longer written onto rows: a hold is temporary, and do_not_contact is
--     permanent. They are read live from us_states.is_on_hold by outreach_ready_people. **Every
--     flow that sends reads outreach_ready_people only**, never people or people_directory.
--   - The silence minimum is never written onto rows either, for the same reason; it is checked live.
--   - companies.old_send_date and old_send_checked are gone; the silence check reads the suppression
--     table directly.
--   - unsuppress() returns a row to 'new' (step 0 had needs_human, which has no status here). It refuses
--     while a HubSpot or Smartlead row still matches: fix it at the source and rebuild first.
--   - A person or company set to do_not_contact by hand writes a 'manual' suppression row, which the
--     rebuild keeps, so a hand-set "never contact" is never lost.
--   - Replied and meeting_booked people keep their status when the suppression check runs (they are
--     already blocked, and a person handles them).
--   - protected_names.label accepts client, mandate, partner, in_talks, operator (CLAUDE.md section 7).
--   - Not carried: the per-person enrichment fields (seat, owner_sources, verifier_results, the
--     context packet and touches). They come back with the enrichment and writing flows.
-- No begin/commit here: apply_migration runs the file as one transaction.

-- =============================================================================================
-- 1. reference and pull tables
-- =============================================================================================
create table if not exists freemail_domains (domain text primary key);
comment on table freemail_domains is 'Free email providers (gmail.com and so on). They never identify a company, so they are never matched as a company domain. Do not edit by hand.';
insert into freemail_domains values ('gmail.com'),('yahoo.com'),('hotmail.com'),('outlook.com'),
  ('aol.com'),('icloud.com'),('me.com'),('live.com'),('msn.com'),('comcast.net'),('verizon.net'),
  ('att.net'),('sbcglobal.net'),('protonmail.com'),('proton.me'),('ymail.com'),('mail.com')
on conflict do nothing;
create or replace function is_freemail(d text) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from freemail_domains f where f.domain = d)
$$;
-- a person's email domain, when it can identify a firm
create or replace function person_firm_domain(email text) returns text
language sql stable set search_path = public, pg_temp as $$
  select case when is_freemail(d) then null else d end
  from (select norm_domain(split_part(norm_email(email), '@', 2)) as d) x
$$;

create table if not exists protected_names (
  domain     text primary key,
  label      text not null check (label in ('client','mandate','partner','in_talks','operator')),
  source_ref text not null,
  added_at   date not null default current_date
);
comment on table protected_names is 'Companies that are never prospects: clients, live mandates, partners, companies in talks, anyone the operator names (00-intake/proof-and-boundaries.md section 6). Their domains are always suppressed.';

create table if not exists smartlead_leads (
  campaign_id         bigint not null,
  campaign_name       text,
  campaign_status     text,
  campaign_created_at timestamptz,
  lead_id             bigint not null,
  email               text not null,
  email_norm          text generated always as (norm_email(email)) stored,
  email_domain        text generated always as (norm_domain(split_part(norm_email(email), '@', 2))) stored,
  website             text,
  website_domain      text generated always as (norm_domain(website)) stored,
  company_name        text,
  first_name          text,
  last_name           text,
  title               text,
  location            text,
  linkedin_url        text,
  company_url         text,
  custom_fields       text,
  lead_status         text,
  lead_category       text,
  lead_category_id    int,
  added_at            timestamptz,
  is_unsubscribed     boolean,
  replied             boolean not null default false,
  bounced             boolean not null default false,
  unsubscribed        boolean not null default false,
  last_sent_time      timestamptz,
  last_send_after     date,
  pulled_at           timestamptz not null default now(),
  primary key (campaign_id, lead_id)
);
create index if not exists smartlead_leads_email_norm_ix on smartlead_leads (email_norm);
comment on table smartlead_leads is 'The old Smartlead campaigns, one row per lead per campaign, loaded from blueprints/smartlead-last-send-pull.ps1. Do not edit by hand.';

create or replace function sl_firm_domain(website_domain text, email_domain text) returns text
language sql stable set search_path = public, pg_temp as $$
  select coalesce(website_domain, case when is_freemail(email_domain) then null else email_domain end)
$$;
create or replace function sl_last_send(last_sent_time timestamptz, last_send_after date) returns date
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(last_sent_time::date, (last_send_after + interval '1 month')::date)
$$;

create table if not exists hubspot_contacts (
  hs_object_id bigint primary key,
  object_type  text not null,
  email        text,
  domain       text,
  pipeline     text,
  deal_stage   text,
  email_optout boolean,
  lead_status  text,
  pulled_at    timestamptz not null default now()
);
comment on table hubspot_contacts is 'Every company domain and contact email on a HubSpot deal, plus opt-outs and lead statuses (blueprints/hubspot-suppression-pull.md). Do not edit by hand.';

create table if not exists lead_categories (
  id   int primary key,
  name text not null
);
comment on table lead_categories is 'Smartlead''s lead category names by id, from the pull''s categories.csv. Do not edit by hand.';

create table if not exists reply_sort (
  campaign_id    bigint not null,
  lead_id        bigint not null,
  category       text not null,
  invited_date   date,
  reason         text,
  prompt_version text not null,
  sorted_at      timestamptz not null default now(),
  checked_by     text,
  primary key (campaign_id, lead_id)
);
comment on table reply_sort is 'The reply sort''s category for each old Smartlead reply; the Smartlead tag is left untouched.';

-- =============================================================================================
-- 2. suppression: the one table every load and every push is checked against (email or domain only)
-- =============================================================================================
create table if not exists suppression (
  id          bigint generated always as identity primary key,
  match_type  text not null check (match_type in ('email','domain')),
  value       text not null,
  cause       text not null check (cause in (
                'pipeline_deal','opt_out','bounced','replied','protected_name',
                'not_interested','do_not_contact','silence_minimum','planted')),
  source      text not null,
  source_ref  text,
  last_send   date,
  planted     boolean not null default false,
  loaded_at   timestamptz not null default now(),
  unique (match_type, value, cause)
);
create index if not exists suppression_value_ix on suppression (match_type, value);
comment on table suppression is 'Every email and domain that must not be emailed, with the cause. Rebuilt by rebuild_suppression(); planted rows (tests) and manual rows (set by a person) are kept. Do not edit by hand.';

-- the old contacts, one disposition per person (design 2026-10-25 section 1). Six months is D6-3; it
-- matches rebuild_suppression's default and changes with it, in the same edit.
create or replace view smartlead_person_disposition with (security_invoker = true) as
with per_row as (
  select l.email_norm, l.email_domain,
         sl_firm_domain(l.website_domain, l.email_domain) as firm_domain,
         l.campaign_name, l.first_name, l.last_name, l.title, l.company_name, l.location,
         coalesce(nullif(l.lead_category, ''), c.name, r.category) as category,
         r.invited_date,
         l.replied, l.bounced,
         (l.unsubscribed or coalesce(l.is_unsubscribed, false) or l.lead_status = 'BLOCKED') as opted_out,
         sl_last_send(l.last_sent_time, l.last_send_after) as last_send
  from smartlead_leads l
  left join lead_categories c on c.id = l.lead_category_id
  left join reply_sort r on r.campaign_id = l.campaign_id and r.lead_id = l.lead_id
),
per_person as (
  select email_norm,
         min(email_domain) as email_domain,
         min(firm_domain)  as firm_domain,
         max(first_name) as first_name, max(last_name) as last_name, max(title) as title,
         max(company_name) as company_name, max(location) as location,
         count(*) as campaigns,
         string_agg(distinct campaign_name, '; ') as campaign_names,
         bool_or(opted_out) as opted_out,
         bool_or(lower(category) like '%do not contact%') as do_not_contact,
         bool_or(lower(category) like '%not interested%' or lower(category) like '%not qualified%') as not_interested,
         bool_or(bounced) as bounced,
         bool_or(lower(category) in ('interested','meeting request','information request',
                                     'handed over to biz dev','handed over to bd',
                                     'interested (no show)','no show (interested)',
                                     'on going conversation','ongoing conversation','business buyer')) as positive,
         bool_or(lower(category) like '%nurture%') as nurture,
         max(invited_date) as invited_date,
         bool_or(replied and category is null) as replied_unsorted,
         max(last_send) as last_send
  from per_row
  group by email_norm
)
select p.*,
       case
         when opted_out                              then 'opt_out'
         when do_not_contact                         then 'do_not_contact'
         when not_interested                         then 'not_interested'
         when bounced                                then 'bounced'
         when positive                               then 'positive'
         when nurture and invited_date is not null   then 'invited_later'
         when nurture                                then 'not_interested'   -- nurture without an invitation is a no
         when replied_unsorted                       then 'replied_unsorted'
         when last_send is null                      then 'waiting'          -- unknown is treated as recent
         when last_send > current_date - interval '6 months' then 'waiting'  -- D6-3
         else 'eligible'
       end as disposition,
       case when last_send is not null then (last_send + interval '6 months')::date end as eligible_from
from per_person p;

create or replace view smartlead_disposition_counts with (security_invoker = true) as
  select disposition, count(*) as people, count(distinct firm_domain) as firms
  from smartlead_person_disposition group by disposition order by disposition;

-- the rebuild. Refuses to run from an empty pull table: an empty table is a failed sync, not a clean slate.
create or replace function rebuild_suppression(silence_months int default 6)
returns table (cause text, rows_loaded bigint)
language plpgsql set search_path = public, pg_temp as $$
begin
  if (select count(*) from hubspot_contacts) = 0 then raise exception 'hubspot_contacts is empty: pull HubSpot before rebuilding suppression'; end if;
  if (select count(*) from smartlead_leads) = 0 then raise exception 'smartlead_leads is empty: run smartlead-last-send-pull.ps1 and load it first'; end if;
  if (select count(*) from protected_names) = 0 then raise exception 'protected_names is empty: load proof-and-boundaries section 6 first'; end if;

  delete from suppression s where s.planted = false and s.source <> 'manual';

  -- HubSpot: a deal anywhere at the firm suppresses the whole domain
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'domain', norm_domain(h.domain), 'pipeline_deal', 'hubspot', h.hs_object_id::text
    from hubspot_contacts h where h.pipeline is not null and norm_domain(h.domain) is not null and not is_freemail(norm_domain(h.domain))
  on conflict do nothing;
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'email', norm_email(h.email), 'pipeline_deal', 'hubspot', h.hs_object_id::text
    from hubspot_contacts h where h.pipeline is not null and norm_email(h.email) is not null
  on conflict do nothing;
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'email', norm_email(h.email), 'opt_out', 'hubspot', h.hs_object_id::text
    from hubspot_contacts h where h.email_optout and norm_email(h.email) is not null
  on conflict do nothing;
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'email', norm_email(h.email),
           case when lower(h.lead_status) like '%do not contact%' then 'do_not_contact' else 'not_interested' end,
           'hubspot', h.hs_object_id::text
    from hubspot_contacts h
    where norm_email(h.email) is not null
      and (lower(h.lead_status) like '%do not contact%' or lower(h.lead_status) like '%not interested%' or lower(h.lead_status) = 'disqualified')
  on conflict do nothing;

  -- Smartlead: unsubscribes and the block list, bounces, categories, replies (firm-level), the silence minimum
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'email', l.email_norm, 'opt_out', 'smartlead', l.campaign_id::text
    from smartlead_leads l where l.unsubscribed or coalesce(l.is_unsubscribed,false) or l.lead_status = 'BLOCKED'
  on conflict do nothing;
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'email', l.email_norm, 'bounced', 'smartlead', l.campaign_id::text
    from smartlead_leads l where l.bounced
  on conflict do nothing;
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'email', l.email_norm,
           case when lower(l.lead_category) like '%do not contact%' then 'do_not_contact' else 'not_interested' end,
           'smartlead', l.campaign_id::text
    from smartlead_leads l
    where lower(l.lead_category) like '%do not contact%' or lower(l.lead_category) like '%not interested%'
  on conflict do nothing;
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'domain', sl_firm_domain(l.website_domain, l.email_domain), 'replied', 'smartlead', l.campaign_id::text
    from smartlead_leads l where l.replied and sl_firm_domain(l.website_domain, l.email_domain) is not null
  on conflict do nothing;
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'email', l.email_norm, 'replied', 'smartlead', l.campaign_id::text
    from smartlead_leads l where l.replied
  on conflict do nothing;
  insert into suppression (match_type, value, cause, source, source_ref, last_send)
    select 'email', l.email_norm, 'silence_minimum', 'smartlead', l.campaign_id::text, sl_last_send(l.last_sent_time, l.last_send_after)
    from smartlead_leads l
    where sl_last_send(l.last_sent_time, l.last_send_after) > (current_date - make_interval(months => silence_months))
  on conflict do nothing;
  insert into suppression (match_type, value, cause, source, source_ref, last_send)
    select distinct on (sl_firm_domain(l.website_domain, l.email_domain))
           'domain', sl_firm_domain(l.website_domain, l.email_domain), 'silence_minimum', 'smartlead', l.campaign_id::text,
           sl_last_send(l.last_sent_time, l.last_send_after)
    from smartlead_leads l
    where sl_firm_domain(l.website_domain, l.email_domain) is not null
      and sl_last_send(l.last_sent_time, l.last_send_after) > (current_date - make_interval(months => silence_months))
    order by sl_firm_domain(l.website_domain, l.email_domain), sl_last_send(l.last_sent_time, l.last_send_after) desc
  on conflict do nothing;

  -- the derived dispositions: the reply sort's plain noes and "nurture later" without an invitation
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'email', d.email_norm, d.disposition, 'smartlead_person_disposition', left(d.campaign_names, 200)
    from smartlead_person_disposition d
    where d.disposition in ('not_interested','do_not_contact') and d.email_norm is not null
  on conflict do nothing;
  insert into suppression (match_type, value, cause, source, source_ref)
    select distinct 'domain', d.firm_domain, d.disposition, 'smartlead_person_disposition', left(d.campaign_names, 200)
    from smartlead_person_disposition d
    where d.disposition in ('not_interested','do_not_contact') and d.firm_domain is not null and not is_freemail(d.firm_domain)
  on conflict do nothing;

  -- protected names
  insert into suppression (match_type, value, cause, source, source_ref)
    select 'domain', pn.domain, 'protected_name', 'protected_names', pn.source_ref from protected_names pn
  on conflict do nothing;

  return query select s.cause, count(*) from suppression s group by s.cause order by s.cause;
end $$;
comment on function rebuild_suppression(int) is 'Refills the suppression table from the HubSpot and Smartlead pulls and the protected names; keeps planted and manual rows. Refuses to run if any source is empty.';

-- every path that feeds suppression must have produced at least one non-planted row
create or replace view suppression_sync_check with (security_invoker = true) as
  select p.path, coalesce(c.n, 0) as rows_present, coalesce(c.n, 0) > 0 as ok from (values
      ('hubspot pipeline_deal'), ('smartlead silence_minimum'), ('smartlead replied'), ('protected_names protected_name')) p(path)
  left join (
    select source || ' ' || cause as path, count(*) as n from suppression where not planted group by 1) c using (path);

-- =============================================================================================
-- 3. marking rows: the system check, and a hand-set do_not_contact that is never lost
-- =============================================================================================
-- a person or company set to do_not_contact by hand writes a manual suppression row.
-- People: BEFORE, so the cause can be filled in. Companies: AFTER, because website_domain is a
-- generated column and is computed only after BEFORE triggers run.
create or replace function record_manual_do_not_contact() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status_code = 'do_not_contact'
     and (tg_op = 'INSERT' or old.status_code <> 'do_not_contact')
     and coalesce(current_setting('app.suppress', true), '') <> 'system' then
    -- norm_email here: this trigger fires before people_tidy (triggers run in name order)
    if norm_email(new.email) is not null then
      insert into suppression (match_type, value, cause, source, source_ref)
        values ('email', norm_email(new.email), 'do_not_contact', 'manual', 'people:' || coalesce(new.person_id::text, 'new'))
        on conflict do nothing;
    end if;
    if new.suppression_cause is null then new.suppression_cause := 'set by hand'; end if;
  end if;
  return new;
end $$;
create or replace function record_manual_do_not_contact_company() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status_code = 'do_not_contact'
     and (tg_op = 'INSERT' or old.status_code <> 'do_not_contact')
     and coalesce(current_setting('app.suppress', true), '') <> 'system'
     and new.website_domain is not null then
    insert into suppression (match_type, value, cause, source, source_ref)
      values ('domain', new.website_domain, 'do_not_contact', 'manual', 'companies:' || new.company_id)
      on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists people_record_manual_dnc on people;
create trigger people_record_manual_dnc before insert or update of status_code on people
  for each row execute function record_manual_do_not_contact();
drop trigger if exists companies_record_manual_dnc on companies;
create trigger companies_record_manual_dnc after insert or update of status_code on companies
  for each row execute function record_manual_do_not_contact_company();

-- the system check: permanent causes set do_not_contact with the cause; silence never changes a
-- status; replied and meeting_booked people keep theirs
create or replace function apply_suppression()
returns table (cause text, companies_marked bigint, people_marked bigint)
language plpgsql set search_path = public, pg_temp as $$
begin
  perform set_config('app.suppress', 'system', true);
  update companies c set status_code = 'do_not_contact', suppression_cause = s.cause
    from suppression s
    where s.match_type = 'domain' and s.value = c.website_domain
      and s.cause <> 'silence_minimum' and c.status_code <> 'do_not_contact';
  update people p set status_code = 'do_not_contact', suppression_cause = s.cause
    from suppression s
    where s.cause <> 'silence_minimum'
      and ((s.match_type = 'email' and s.value = p.email)
        or (s.match_type = 'domain' and s.value = person_firm_domain(p.email)))
      and p.status_code not in ('do_not_contact','replied','meeting_booked');
  update people p set status_code = 'do_not_contact', suppression_cause = 'company: ' || coalesce(c.suppression_cause, 'do_not_contact')
    from companies c
    where c.company_id = p.company_id and c.status_code = 'do_not_contact'
      and p.status_code not in ('do_not_contact','replied','meeting_booked');
  perform set_config('app.suppress', '', true);
  return query
    select x.cause, count(distinct x.cid), count(distinct x.pid) from (
      select c.suppression_cause as cause, c.company_id as cid, null::bigint as pid from companies c where c.status_code = 'do_not_contact'
      union all
      select p.suppression_cause, null, p.person_id from people p where p.status_code = 'do_not_contact') x
    group by x.cause order by x.cause;
end $$;
comment on function apply_suppression() is 'Marks every company and person matching a permanent suppression row as do_not_contact, with the cause. Run after rebuild_suppression() and after every load.';

-- the only way out of do_not_contact. Refuses while a source system still says no.
create or replace function unsuppress(tbl text, row_id bigint, who text, why text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare v_email text; v_domain text; v_company bigint; blocking text;
begin
  if coalesce(trim(who),'') = '' or coalesce(trim(why),'') = '' then
    raise exception 'unsuppress needs a person''s name and a reason';
  end if;

  if tbl = 'companies' then
    select website_domain into v_domain from companies where company_id = row_id;
    if not found then raise exception 'no companies row with id %', row_id; end if;
    select string_agg(distinct s.cause || ' (' || s.source || ')', ', ') into blocking
      from suppression s where s.source <> 'manual' and s.match_type = 'domain' and s.value = v_domain;
  elsif tbl = 'people' then
    select p.email, p.company_id into v_email, v_company from people p where p.person_id = row_id;
    if not found then raise exception 'no people row with id %', row_id; end if;
    if exists (select 1 from companies c where c.company_id = v_company and c.status_code = 'do_not_contact') then
      raise exception 'The person''s company is do_not_contact: unsuppress the company first';
    end if;
    select string_agg(distinct s.cause || ' (' || s.source || ')', ', ') into blocking
      from suppression s where s.source <> 'manual'
       and ((s.match_type = 'email' and s.value = v_email)
         or (s.match_type = 'domain' and s.value = person_firm_domain(v_email)));
  else
    raise exception 'tbl must be companies or people';
  end if;

  if blocking is not null then
    raise exception 'Still suppressed by: %. Fix it at the source (HubSpot, Smartlead, protected_names), run rebuild_suppression(), then try again.', blocking;
  end if;

  perform set_config('app.unsuppress', 'person', true);
  if tbl = 'companies' then
    delete from suppression where source = 'manual' and match_type = 'domain' and value = v_domain;
    update companies set status_code = 'new', suppression_cause = null,
           notes = concat_ws(E'\n', notes, format('%s: unsuppressed by %s: %s', current_date, who, why))
     where company_id = row_id;
    update people set status_code = 'new', suppression_cause = null,
           notes = concat_ws(E'\n', notes, format('%s: company unsuppressed by %s: %s', current_date, who, why))
     where company_id = row_id and status_code = 'do_not_contact' and suppression_cause like 'company:%';
  else
    delete from suppression where source = 'manual' and match_type = 'email' and value = v_email;
    update people set status_code = 'new', suppression_cause = null,
           notes = concat_ws(E'\n', notes, format('%s: unsuppressed by %s: %s', current_date, who, why))
     where person_id = row_id;
  end if;
  perform set_config('app.unsuppress', '', true);
end $$;
comment on function unsuppress(text, bigint, text, text) is 'The only way to clear do_not_contact. Needs a person''s name and a reason (written into notes); refuses while HubSpot, Smartlead or a protected name still matches.';

-- =============================================================================================
-- 4. the gates and the views every flow reads
-- =============================================================================================
create or replace view planted_rows_caught with (security_invoker = true) as
  select s.value, s.match_type, s.cause,
         exists (select 1 from companies c where c.website_domain = s.value and c.status_code = 'do_not_contact')
      or exists (select 1 from people p where (p.email = s.value or person_firm_domain(p.email) = s.value)
                                         and p.status_code = 'do_not_contact')
         as caught
  from suppression s where s.planted;

create or replace view load_gate with (security_invoker = true) as
  select (select count(*) = 3 from planted_rows_caught where caught) as planted_caught,
         (select bool_and(ok) from suppression_sync_check) as syncs_present,
         (select count(*) = 3 from planted_rows_caught where caught) and (select bool_and(ok) from suppression_sync_check) as pass;
comment on view load_gate is 'pass is true only when all 3 planted test rows are caught and every suppression source has rows. No push while it is false.';

-- who can be emailed now: checked live, every cause including silence and hold states
create or replace view outreach_ready_people with (security_invoker = true) as
  select pd.*
  from people_directory pd
  join people p      on p.person_id = pd.person_id
  join companies c   on c.company_id = p.company_id
  join us_states s   on s.state_code = c.state_code
  where c.status_code = 'qualified'
    and p.status_code = 'verified'
    and p.email is not null
    and p.email_checked_at >= current_date - 30
    and not s.is_on_hold
    and not exists (
      select 1 from suppression x
      where (x.match_type = 'email'  and x.value = p.email)
         or (x.match_type = 'domain' and x.value = c.website_domain)
         or (x.match_type = 'domain' and x.value = person_firm_domain(p.email)));
comment on view outreach_ready_people is 'The only list any sending flow reads: qualified company, verified person, email checked in the last 30 days, a clear state, and no suppression match of any cause. Read-only.';

create or replace view never_again_list with (security_invoker = true) as
  select s.value as email,
         split_part(s.value, '@', 2) as email_domain,
         s.cause, s.source, s.source_ref,
         s.loaded_at::date as set_on
  from suppression s
  where s.match_type = 'email'
    and s.cause in ('opt_out','do_not_contact','not_interested','bounced')
    and not s.planted
  order by s.cause, s.value;
comment on view never_again_list is 'Every email that must never be emailed again, with its cause. Export it to Smartlead''s block list and HubSpot by hand until the push adapter exists.';

-- =============================================================================================
-- 5. the kill switch and costs
-- =============================================================================================
create table if not exists flags (
  name    text primary key,
  value   boolean not null default false,
  set_by  text,
  reason  text,
  set_at  timestamptz
);
comment on table flags is 'Switches every workflow reads first. sending_paused = true stops all sending. Every change needs set_by and reason.';
insert into flags (name, value) values ('sending_paused', false) on conflict do nothing;
create or replace function guard_flags() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if coalesce(new.set_by,'') = '' or coalesce(new.reason,'') = '' then
    raise exception 'flags.% needs set_by and reason on every change', new.name;
  end if;
  new.set_at := now();
  return new;
end $$;
drop trigger if exists flags_guard on flags;
create trigger flags_guard before update on flags for each row execute function guard_flags();

create table if not exists costs (
  id       bigint generated always as identity primary key,
  run_id   text not null,
  step     text not null,
  provider text,
  calls    int not null default 1,
  usd      numeric(10,5) not null default 0,
  minutes  numeric(8,2) not null default 0,
  note     text,
  at       timestamptz not null default now()
);
comment on table costs is 'One row per provider call batch: what it cost in dollars and minutes.';

-- =============================================================================================
-- 6. security: RLS on, no policies, no API grants
-- =============================================================================================
alter table freemail_domains enable row level security;
alter table protected_names  enable row level security;
alter table smartlead_leads  enable row level security;
alter table hubspot_contacts enable row level security;
alter table lead_categories  enable row level security;
alter table reply_sort       enable row level security;
alter table suppression      enable row level security;
alter table flags            enable row level security;
alter table costs            enable row level security;

revoke all on freemail_domains, protected_names, smartlead_leads, hubspot_contacts, lead_categories, reply_sort,
              suppression, flags, costs,
              smartlead_person_disposition, smartlead_disposition_counts, suppression_sync_check,
              planted_rows_caught, load_gate, outreach_ready_people, never_again_list
  from anon, authenticated;

revoke execute on function is_freemail(text), person_firm_domain(text), sl_firm_domain(text, text),
  sl_last_send(timestamptz, date), rebuild_suppression(int), record_manual_do_not_contact(),
  record_manual_do_not_contact_company(), apply_suppression(), unsuppress(text, bigint, text, text), guard_flags()
  from public, anon, authenticated;

-- Read-back after running:
--   select * from flags;       -- sending_paused false
--   select * from load_gate;   -- pass = true only after the pulls, the protected names and the planted rows are loaded

commit;

-- icp-v1.2-imports.sql: importing scraped data from any tool (Apollo, lemlist, Google Maps, Sales
-- Navigator, anything). Run ONCE in the Supabase SQL Editor on the live database (it already has v1.1).
-- 2026-10-26. All or nothing. Operator: "make variables and it'll accept any text", "we might use
-- multiple scraping tools like apollo, lemlist, google maps, Sales Navigator".
--
-- How it works:
--   1. Upload a CSV, exactly as the tool gives it (headers renamed to match), into import_companies
--      or import_people. Every column is plain text: nothing is rejected at upload.
--   2. Run:  select * from load_imports('apollo');   (the tool name labels rows that have none)
--      Each row becomes a company (and a person), or is merged into the one already there, or stays
--      in the import table as needs_review with the reason in plain words. Nothing is guessed or lost.
--   3. Industry wording: every new wording is saved in industry_aliases. Map it once (pick the main
--      industry from the dropdown) and every company with that wording, now and later, gets it.
--      Unmapped companies show as "Unsorted". A wording that equals an industry's name maps itself.
--   4. State is read from any location text ("Boston, MA 02110", "Massachusetts", "Greater New York
--      City Area"); city is taken from the text before the state. The original text is kept.
-- The suppression check (apply_suppression) runs at the end of every load_imports().

begin;

-- =============================================================================================
-- 1. new columns on companies: the tool's own words, kept; the company phone
-- =============================================================================================
alter table companies add column if not exists company_phone        text;
alter table companies add column if not exists source_industry_text text;
alter table companies add column if not exists source_location_text text;
comment on column companies.company_phone is 'The company''s main phone number, any format.';
comment on column companies.source_industry_text is 'The industry exactly as the scraping tool wrote it. Kept so it can be searched and mapped (industry_aliases).';
comment on column companies.source_location_text is 'The location or address exactly as the scraping tool wrote it.';
create index if not exists companies_name_lower_ix on companies (lower(company_name));

-- =============================================================================================
-- 2. helpers
-- =============================================================================================
create or replace function norm_text(t text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select nullif(lower(regexp_replace(trim(coalesce(t, '')), '\s+', ' ', 'g')), '')
$$;
comment on function norm_text(text) is 'Lowercase, trimmed, single spaces: "  HVAC  Contractor " -> "hvac contractor".';

create or replace function add_source(existing text, tool text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when nullif(trim(tool), '') is null then existing
              when existing is null then trim(tool)
              when position(lower(trim(tool)) in lower(existing)) > 0 then existing
              else existing || ', ' || trim(tool) end
$$;

-- the state in any location text, or null. A two-letter code as its own comma part (with or without
-- a ZIP) wins; else the full state name that ends last in the text (longest on a tie, so
-- "West Virginia" beats "Virginia" and "Kansas City, Missouri" gives MO).
create or replace function parse_state(t text) returns char(2)
language plpgsql stable set search_path = public, pg_temp as $$
declare
  u text;
  m text[];
  code char(2);
begin
  if norm_text(t) is null then return null; end if;
  u := upper(trim(t));
  u := regexp_replace(u, '[,\s]*(UNITED STATES( OF AMERICA)?|U\.S\.A\.?|USA|U\.S\.?|US)\s*$', '');
  for m in select regexp_matches(u, '(?:^|,)\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?=,|$)', 'g') loop
    if exists (select 1 from us_states s where s.state_code = m[1]) then code := m[1]; end if;
  end loop;
  if code is not null then return code; end if;
  select s.state_code into code
    from us_states s
   where u ~ ('\m' || upper(s.name) || '\M')
   order by length(u) - strpos(reverse(u), reverse(upper(s.name))) desc, length(s.name) desc
   limit 1;
  return code;
end $$;
comment on function parse_state(text) is 'Finds the US state in any location text: "Boston, MA 02110" -> MA, "Austin, Texas, United States" -> TX, "Greater Boston Area" -> empty.';

-- the city: the comma part just before the state, unless it looks like a street
create or replace function parse_city(t text) returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare
  parts text[];
  n int;
begin
  if norm_text(t) is null then return null; end if;
  parts := regexp_split_to_array(trim(t), '\s*,\s*');
  n := array_length(parts, 1);
  if n >= 1 and upper(parts[n]) ~ '^(UNITED STATES( OF AMERICA)?|U\.S\.A\.?|USA|U\.S\.?|US)$' then n := n - 1; end if;
  if n < 2 or parse_state(parts[n]) is null then return null; end if;
  if parts[n - 1] ~ '^\d' then return null; end if;
  return nullif(trim(parts[n - 1]), '');
end $$;
comment on function parse_city(text) is 'Finds the city in a location text: "12 Main St, Boston, MA 02110" -> Boston, "Austin, Texas, United States" -> Austin.';

-- =============================================================================================
-- 3. industry_aliases: every wording any tool used, mapped once to a main industry
-- =============================================================================================
create table if not exists industry_aliases (
  alias_text        text primary key,
  example_text      text not null,
  industry_code     text references industries (industry_code) on update cascade,
  first_source_tool text,
  times_seen        int not null default 1,
  first_seen_at     timestamptz not null default now(),
  mapped_at         timestamptz
);
create index if not exists industry_aliases_industry_code_ix on industry_aliases (industry_code);
comment on table industry_aliases is 'Every industry wording the scraping tools used. To map one, pick its main industry in industry_code; every company with that wording gets it. Empty = not mapped yet (the company shows as Unsorted).';
comment on column industry_aliases.alias_text is 'The wording, lowercased. Filled automatically.';
comment on column industry_aliases.example_text is 'The wording as a tool first wrote it.';
comment on column industry_aliases.industry_code is 'The main industry this wording means. Pick it from the list. For a new industry, add it to industries first.';
comment on column industry_aliases.first_source_tool is 'The tool that first used this wording.';
comment on column industry_aliases.times_seen is 'How many imported rows used this wording.';

-- saving a wording; it maps itself when it equals an industry's name or code
create or replace function register_industry_alias(raw text, tool text) returns text
language plpgsql set search_path = public, pg_temp as $$
declare
  v text := norm_text(raw);
  code text;
begin
  if v is null then return null; end if;
  insert into industry_aliases as a (alias_text, example_text, first_source_tool, industry_code, mapped_at)
  select v, trim(raw), tool, i.industry_code, case when i.industry_code is not null then now() end
    from (select (select x.industry_code from industries x
                   where lower(x.name) = v or x.industry_code = v or replace(x.industry_code, '_', ' ') = v
                   limit 1) as industry_code) i
  on conflict (alias_text) do update set times_seen = a.times_seen + 1
  returning a.industry_code into code;
  return code;
end $$;

-- mapping a wording updates every company that has it and no industry yet (or the old mapping)
create or replace function apply_industry_alias() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.industry_code is distinct from old.industry_code then
    new.mapped_at := case when new.industry_code is null then null else now() end;
    update companies c set industry_code = new.industry_code
     where norm_text(c.source_industry_text) = new.alias_text
       and (c.industry_code is null or c.industry_code is not distinct from old.industry_code);
  end if;
  return new;
end $$;
drop trigger if exists industry_aliases_apply on industry_aliases;
create trigger industry_aliases_apply before update on industry_aliases for each row execute function apply_industry_alias();

create or replace view industry_aliases_to_map with (security_invoker = true) as
  select a.alias_text, a.example_text, a.first_source_tool, a.times_seen,
         (select count(*) from companies c where norm_text(c.source_industry_text) = a.alias_text and c.industry_code is null) as unsorted_companies
  from industry_aliases a
  where a.industry_code is null
  order by unsorted_companies desc, a.times_seen desc;
comment on view industry_aliases_to_map is 'The industry wordings still to map, most companies first. Map them in the industry_aliases table.';

-- =============================================================================================
-- 4. the import tables: plain text, anything accepted
-- =============================================================================================
create table if not exists import_companies (
  import_id     bigint generated always as identity primary key,
  source_tool   text not null default 'other',
  company_name  text,
  website       text,
  industry      text,
  location      text,
  city          text,
  state         text,
  phone         text,
  linkedin_url  text,
  notes         text,
  import_status text not null default 'pending' check (import_status in ('pending','added','merged','needs_review')),
  reason        text,
  company_id    bigint references companies (company_id) on delete set null,
  uploaded_at   timestamptz not null default now(),
  processed_at  timestamptz
);
create index if not exists import_companies_status_ix on import_companies (import_status);
create index if not exists import_companies_company_id_ix on import_companies (company_id);
comment on table import_companies is 'Upload a company list here from any tool. Then run: select * from load_imports(''tool name''). added = new company, merged = matched one already there, needs_review = see reason; fix the row, set import_status back to pending, run again.';
comment on column import_companies.source_tool is 'apollo, lemlist, google_maps, sales_navigator or any name. Left as other, load_imports(''tool'') fills it.';
comment on column import_companies.location is 'Any location or full address text; the state and city are read from it.';
comment on column import_companies.industry is 'The industry or category exactly as the tool wrote it.';

create table if not exists import_people (
  import_id            bigint generated always as identity primary key,
  source_tool          text not null default 'other',
  first_name           text,
  last_name            text,
  full_name            text,
  designation          text,
  email                text,
  phone_number         text,
  linkedin_url         text,
  company_name         text,
  company_website      text,
  company_industry     text,
  company_location     text,
  company_city         text,
  company_state        text,
  company_phone        text,
  company_linkedin_url text,
  notes                text,
  import_status        text not null default 'pending' check (import_status in ('pending','added','merged','needs_review')),
  reason               text,
  company_id           bigint references companies (company_id) on delete set null,
  person_id            bigint references people (person_id) on delete set null,
  uploaded_at          timestamptz not null default now(),
  processed_at         timestamptz
);
create index if not exists import_people_status_ix on import_people (import_status);
create index if not exists import_people_company_id_ix on import_people (company_id);
create index if not exists import_people_person_id_ix on import_people (person_id);
comment on table import_people is 'Upload a people list here from any tool; the company columns create or match the company too. Then run: select * from load_imports(''tool name'').';
comment on column import_people.full_name is 'Use when the tool gives one name column; it is split into first and last.';

-- =============================================================================================
-- 5. the loaders
-- =============================================================================================
-- one company from raw text: matched on the website domain, else on name + city + state; else added.
-- A match fills only empty fields; it never changes a status.
create or replace function import_company(
  p_tool text, p_name text, p_website text, p_industry text, p_location text,
  p_city text, p_state text, p_phone text, p_linkedin text, p_notes text,
  out company_id bigint, out action text)
language plpgsql set search_path = public, pg_temp as $$
declare
  v_name   text := nullif(trim(p_name), '');
  v_domain text := company_domain(p_website);
  v_state  char(2) := coalesce(parse_state(p_state), parse_state(p_location), parse_state(p_city));
  v_city   text := coalesce(nullif(trim(p_city), ''), parse_city(p_location));
  v_ind    text := register_industry_alias(p_industry, p_tool);
  v_li     text := nullif(trim(p_linkedin), '');
  v_found  bigint[];
begin
  if v_name is null then raise exception 'no company name'; end if;
  if v_li is not null and v_li !~* '^https?://' and v_li ~* '^(www\.)?([a-z]+\.)?linkedin\.com/' then v_li := 'https://' || v_li; end if;
  if v_li is not null and v_li !~* '^https?://([a-z]+\.)?linkedin\.com/' then v_li := null; end if;

  if v_domain is not null then
    select array_agg(c.company_id) into v_found from companies c where c.website_domain = v_domain;
    -- not found by website: the same name and place entered earlier without a website is the same firm
    if v_found is null then
      select array_agg(c.company_id) into v_found from companies c
       where c.website_domain is null and lower(c.company_name) = lower(v_name)
         and lower(coalesce(c.city, '')) = lower(coalesce(v_city, ''))
         and coalesce(c.state_code, '') = coalesce(v_state, '');
      if array_length(v_found, 1) > 1 then v_found := null; end if;
    end if;
  else
    select array_agg(c.company_id) into v_found from companies c
     where lower(c.company_name) = lower(v_name)
       and lower(coalesce(c.city, '')) = lower(coalesce(v_city, ''))
       and coalesce(c.state_code, '') = coalesce(v_state, '');
    if array_length(v_found, 1) > 1 then
      raise exception 'more than one company called "%" in this place: add a website to tell them apart', v_name;
    end if;
  end if;

  if v_found is not null then
    company_id := v_found[1];
    update companies c set
      website              = coalesce(c.website, nullif(trim(p_website), '')),
      city                 = coalesce(c.city, v_city),
      state_code           = coalesce(c.state_code, v_state),
      industry_code        = coalesce(c.industry_code, v_ind),
      source_industry_text = coalesce(c.source_industry_text, nullif(trim(p_industry), '')),
      source_location_text = coalesce(c.source_location_text, nullif(trim(p_location), '')),
      company_phone        = coalesce(c.company_phone, nullif(trim(p_phone), '')),
      linkedin_url         = coalesce(c.linkedin_url, v_li),
      notes                = coalesce(c.notes, nullif(trim(p_notes), '')),
      source               = add_source(c.source, p_tool)
     where c.company_id = import_company.company_id;
    action := 'merged';
  else
    insert into companies (company_name, website, city, state_code, industry_code, source_industry_text,
                           source_location_text, company_phone, linkedin_url, notes, source)
    values (v_name, nullif(trim(p_website), ''), v_city, v_state, v_ind, nullif(trim(p_industry), ''),
            nullif(trim(p_location), ''), nullif(trim(p_phone), ''), v_li, nullif(trim(p_notes), ''), p_tool)
    returning companies.company_id into company_id;
    action := 'added';
  end if;
end $$;

-- one person from raw text, with their company found or created
create or replace function import_person(r import_people, out person_id bigint, out company_id bigint, out action text)
language plpgsql set search_path = public, pg_temp as $$
declare
  v_first  text := nullif(trim(r.first_name), '');
  v_last   text := nullif(trim(r.last_name), '');
  v_email  text := norm_email(r.email);
  v_li     text := nullif(trim(r.linkedin_url), '');
  v_domain text := company_domain(r.company_website);
  v_edom   text;
  v_found  bigint[];
  v_co     record;
begin
  if v_first is null and nullif(trim(r.full_name), '') is not null then
    v_first := split_part(regexp_replace(trim(r.full_name), '\s+', ' ', 'g'), ' ', 1);
    v_last  := coalesce(v_last, nullif(trim(substr(regexp_replace(trim(r.full_name), '\s+', ' ', 'g'), length(v_first) + 2)), ''));
  end if;
  if v_first is null then raise exception 'no first name (or full name)'; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'email not valid: %', r.email; end if;
  if v_li is not null and v_li !~* '^https?://' and v_li ~* '^(www\.)?([a-z]+\.)?linkedin\.com/' then v_li := 'https://' || v_li; end if;
  if v_li is not null and v_li !~* '^https?://([a-z]+\.)?linkedin\.com/' then raise exception 'LinkedIn URL not valid: %', r.linkedin_url; end if;

  -- the company. With a company name: through import_company (matched on the website, else the work
  -- email's domain, else name + place; its empty fields filled from this row; created if new).
  -- Without one: found by the website or the work email's domain only.
  v_edom := company_domain(person_firm_domain(v_email));
  if nullif(trim(r.company_name), '') is not null then
    select * into v_co from import_company(r.source_tool, r.company_name,
             coalesce(nullif(trim(r.company_website), ''), v_edom), r.company_industry, r.company_location,
             r.company_city, r.company_state, r.company_phone, r.company_linkedin_url, null);
    company_id := v_co.company_id;
  else
    if v_domain is not null then
      select c.company_id into company_id from companies c where c.website_domain = v_domain;
    end if;
    if company_id is null and v_edom is not null then
      select c.company_id into company_id from companies c where c.website_domain = v_edom;
    end if;
    if company_id is null then
      raise exception 'no company found: give company_name, company_website or a work email';
    end if;
  end if;

  -- the person: by email, else by LinkedIn, else by name at the same company
  if v_email is not null then
    select p.person_id into person_id from people p where p.email = v_email;
  end if;
  if person_id is null and v_li is not null then
    select p.person_id into person_id from people p where norm_linkedin(p.linkedin_url) = norm_linkedin(v_li);
  end if;
  if person_id is null then
    select array_agg(p.person_id) into v_found from people p
     where p.company_id = import_person.company_id and lower(p.first_name) = lower(v_first)
       and lower(coalesce(p.last_name, '')) = lower(coalesce(v_last, ''));
    if array_length(v_found, 1) = 1 then person_id := v_found[1]; end if;
  end if;

  if person_id is not null then
    update people p set
      last_name    = coalesce(p.last_name, v_last),
      designation  = coalesce(p.designation, nullif(trim(r.designation), '')),
      email        = coalesce(p.email, v_email),
      email_source = case when p.email is null and v_email is not null then coalesce(p.email_source, r.source_tool || ' import') else p.email_source end,
      phone_number = coalesce(p.phone_number, nullif(trim(r.phone_number), '')),
      linkedin_url = coalesce(p.linkedin_url, v_li),
      notes        = coalesce(p.notes, nullif(trim(r.notes), '')),
      source       = add_source(p.source, r.source_tool)
     where p.person_id = import_person.person_id;
    action := 'merged';
  else
    insert into people (company_id, first_name, last_name, designation, email, email_source, phone_number,
                        linkedin_url, notes, source)
    values (company_id, v_first, v_last, nullif(trim(r.designation), ''), v_email,
            case when v_email is not null then r.source_tool || ' import' end,
            nullif(trim(r.phone_number), ''), v_li, nullif(trim(r.notes), ''), r.source_tool)
    returning people.person_id into person_id;
    action := 'added';
  end if;
end $$;

-- the one button: every pending row in both import tables, then the suppression check
create or replace function load_imports(tool_for_unlabelled text default 'other')
returns table (import_table text, result text, rows_count bigint)
language plpgsql set search_path = public, pg_temp as $$
declare
  started timestamptz := clock_timestamp();
  r  record;
  rp import_people;
  res record;
  tool text := coalesce(nullif(lower(trim(tool_for_unlabelled)), ''), 'other');
begin
  update import_companies set source_tool = tool where import_status = 'pending' and source_tool = 'other';
  update import_people    set source_tool = tool where import_status = 'pending' and source_tool = 'other';

  for r in select * from import_companies where import_status = 'pending' order by import_id loop
    begin
      select * into res from import_company(r.source_tool, r.company_name, r.website, r.industry, r.location,
                                            r.city, r.state, r.phone, r.linkedin_url, r.notes);
      update import_companies set import_status = res.action, company_id = res.company_id, reason = null,
             processed_at = clock_timestamp() where import_id = r.import_id;
    exception when others then
      update import_companies set import_status = 'needs_review', reason = sqlerrm, processed_at = clock_timestamp()
       where import_id = r.import_id;
    end;
  end loop;

  for rp in select * from import_people where import_status = 'pending' order by import_id loop
    begin
      select * into res from import_person(rp);
      update import_people set import_status = res.action, company_id = res.company_id, person_id = res.person_id,
             reason = null, processed_at = clock_timestamp() where import_id = rp.import_id;
    exception when others then
      update import_people set import_status = 'needs_review', reason = sqlerrm, processed_at = clock_timestamp()
       where import_id = rp.import_id;
    end;
  end loop;

  perform apply_suppression();

  return query
    select 'import_companies'::text, i.import_status, count(*) from import_companies i where i.processed_at >= started group by i.import_status
    union all
    select 'import_people'::text, i.import_status, count(*) from import_people i where i.processed_at >= started group by i.import_status
    order by 1, 2;
end $$;
comment on function load_imports(text) is 'Loads every pending row of import_companies and import_people into companies and people, then runs the suppression check. Example: select * from load_imports(''apollo'');';

-- =============================================================================================
-- 6. the directories show Unsorted, the phone and the tool's own words
-- =============================================================================================
drop view if exists company_directory;
create view company_directory with (security_invoker = true) as
  select c.company_id,
         c.company_name,
         c.website,
         c.website_domain,
         c.company_phone,
         c.city,
         c.state_code,
         s.name        as state,
         s.region,
         s.is_on_hold  as state_on_hold,
         coalesce(i.name, 'Unsorted') as industry,
         b.name        as business_type,
         cs.name       as status,
         c.suppression_cause,
         c.linkedin_url,
         (select count(*) from people p where p.company_id = c.company_id) as people_count,
         c.source,
         c.source_industry_text,
         c.source_location_text,
         c.notes,
         c.created_at,
         c.updated_at
  from companies c
  left join us_states s    on s.state_code = c.state_code
  left join industries i   on i.industry_code = c.industry_code
  join business_types b    on b.business_type_code = c.business_type_code
  join company_statuses cs on cs.status_code = c.status_code;
comment on view company_directory is 'Read-only list of companies with every name spelled out; filter it by any column. Industry shows Unsorted until its wording is mapped. Edit in the companies table.';

create or replace view people_directory with (security_invoker = true) as
  select p.person_id,
         p.first_name,
         p.last_name,
         p.designation,
         p.email,
         p.email_source,
         p.email_checked_at,
         p.phone_number,
         p.linkedin_url,
         ps.name        as status,
         c.company_id,
         c.company_name as company,
         c.website,
         c.city,
         c.state_code,
         s.region,
         s.is_on_hold   as state_on_hold,
         coalesce(i.name, 'Unsorted') as industry,
         b.name         as business_type,
         cs.name        as company_status,
         p.suppression_cause,
         p.source,
         p.notes,
         p.created_at,
         p.updated_at
  from people p
  join companies c         on c.company_id = p.company_id
  join person_statuses ps  on ps.status_code = p.status_code
  join company_statuses cs on cs.status_code = c.status_code
  join business_types b    on b.business_type_code = c.business_type_code
  left join us_states s    on s.state_code = c.state_code
  left join industries i   on i.industry_code = c.industry_code;

-- =============================================================================================
-- 7. security: same as everything else
-- =============================================================================================
alter table industry_aliases enable row level security;
alter table import_companies enable row level security;
alter table import_people    enable row level security;
revoke all on industry_aliases, import_companies, import_people, industry_aliases_to_map, company_directory, people_directory
  from anon, authenticated;
revoke execute on function norm_text(text), add_source(text, text), parse_state(text), parse_city(text),
  register_industry_alias(text, text), apply_industry_alias(),
  import_company(text, text, text, text, text, text, text, text, text, text),
  import_person(import_people), load_imports(text)
  from public, anon, authenticated;

commit;

-- read-back
select (select count(*) from us_states) as states,
       (select count(*) from us_states where is_on_hold) as states_on_hold,
       (select count(*) from industries) as industries,
       (select count(*) from business_types) as business_types,
       (select count(*) from company_statuses) as company_statuses,
       (select count(*) from person_statuses) as person_statuses,
       (select count(*) from information_schema.tables where table_schema = 'public' and table_name in ('import_companies','import_people')) as import_tables,
       (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity) as tables_without_rls;
