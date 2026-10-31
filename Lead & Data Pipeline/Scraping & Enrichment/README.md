# Scraping & Enrichment

*For Abdullah and the second operator. What this is, how to set it up, and the daily routine.
Decisions: D9-1 to D9-4 in `DECISIONS.md`. Tool details: `docs/2026-10-29-tool-apis.md`.*

## What it does

It finds **companies** in one industry, then their **owners**, then each owner's **verified work
email**. Everything goes into our Supabase database, searchable by industry. Phone numbers for
people are never collected.

```
 You, in Claude                         Supabase (shared by both of you)
 "find plumbers in Worcester, MA"  ──►  the job queue ──► companies ──► owners ──► verified emails
 "show me the owners to approve"            ▲
 "how far is HVAC?"                         │ the engine claims work, so two machines never clash
                                     Engine (in Claude, or a terminal for long runs)
```

**You talk to Claude; the engine does the rows.** Claude starts jobs, shows progress and cost,
and walks you through approvals. The engine does the heavy work through treg, Apollo, Leadocean
and a small AI model. Both of you can run it at once: Supabase hands out the work, so nothing is
done twice.

## The pipeline, step by step

| Step | What happens | Where it waits for you |
| :-- | :-- | :-- |
| 1. Find companies | Google Maps by city (through treg), plus Apollo or Leadocean if asked. Duplicates are merged on the website | |
| 2. Read the website | Home, contact and about pages. **Code** collects every email printed on the site and keeps only the useful lines: the top of the home and about pages, and the lines around owner or franchise words. If there are no such lines and the Google category plainly names the trade, **no AI is used**. Otherwise a small AI reads those lines only and answers "is this really a plumber?", "is it independent?" and "who's the owner?", **quoting the page** (a quote not on the page is thrown out) | Unclear sites go to "needs review" |
| 3. Find the owner | From the website, a web search ("owner of X in City"), Leadocean, Apollo, BlitzAPI. **Two different sources must agree on the name.** Staff (office managers, VPs, technicians) are never taken for owners | |
| 4. **You approve the owners** | Claude shows the batch, flags anyone with one source or a second name | **Here.** No email credits are spent before this |
| 5. Find the email | First a data provider (Apollo, Leadocean, Kitt, Tomba); guessed addresses are refused. Then an address the firm's **own website** prints. Then the **8 name patterns**, but never on a "catch-all" domain | |
| 6. Verify twice | MillionVerifier and Tomba must both say valid | Unclear ones go to "needs review" |

**The two outreach lists:**
- **`outreach_ready_people`** (the main lane) holds emails a data provider found.
- **`outreach_ready_verified_lane`** holds emails from the firm's own website (including a Gmail
  or AOL address the site prints, D9-2) and pattern emails (D9-1). They're sent in separate
  campaigns with a stricter bounce stop, and never mixed with the main lane.

## Set up (once per person)

1. **Database:** paste `sql/v1.3-enrichment.sql` into the Supabase SQL Editor and run it. The
   last row should say `new_tables 2 · people_evidence_columns 6 · total_daily_budget_usd 25.00 ·
   tables_without_rls 0`. Only the first person does this.
2. **Keys:** in the workspace `.env` (copy any missing lines from `.env.example`), fill
   `SUPABASE_DB_URL` (Supabase → Project Settings → Database → Connection string, session
   pooler), `TREG_API_KEY`, `APOLLO_API_KEY`, `LEADOCEAN_API_KEY`, `ANTHROPIC_API_KEY` (or
   `OPENROUTER_API_KEY`; a Claude Code or Claude Desktop subscription doesn't give one, and
   without it the engine stops at the website step), and **`ENRICH_PERSON`** with your own name. Keep the shared keys in the
   password manager (D9-4). Never paste a key in chat.
3. **The database certificate:** Supabase → Project Settings → Database → SSL Configuration →
   Download certificate. Save it (for example as `D:/With_Abdullah/supabase-ca.crt`, outside the
   repository) and put that path in `SUPABASE_DB_CA_FILE`. Without it the engine refuses to
   connect, so nobody on the network can pass themselves off as the database.
4. **Install:** in `engine/`, run `npm install`, then `npm test` (49 tests; nothing real is
   touched).
5. **Connect Claude:** the workspace's `.mcp.json` has the `enrichment` server. Restart Claude
   Code and approve it. For Claude Desktop, see `engine/README-claude-desktop.md`.
6. **Spending stays off** until `ENRICH_ALLOW_SPEND=true` in `.env`. Set the daily budgets first
   (below).

**Companies already in the database** (added by hand before v1.3) are left alone, with the
stage `not_queued`. To send one through the engine, set its `enrichment_stage` to `to_read` in
the Table Editor. New sourcing jobs queue their own companies.

## Daily routine

| Say to Claude | What happens |
| :-- | :-- |
| "Enrichment status" | Companies and owners at each stage, per industry; today's spend against the budgets; the lists ready to email |
| "Find plumbers in Worcester, Springfield and Lowell, MA, up to 500 companies, at most $10" | A preview with the cost ceiling. Say yes and the job is queued |
| "Enrich this list: D:/lists/hvac-ma.csv, it's from Apollo, HVAC" | A preview: which columns it read, what each row still needs, what's already done (free), the rows it leaves alone (not owners, hold states, personal emails), the expected cost and a cap. Say yes and the rows go into the pipeline, capped |
| "Run the engine for an hour" | It works through the queue in the background |
| "Cancel job 12" | No more paid calls are charged to that job, on either machine |
| "Show me the owners to approve" | The batch, with each owner's sources |
| "Approve all except 412 and 415" | Those owners move on to the email search |
| "What needs review?" | The rows the engine couldn't decide, with the reason |
| "Show verified HVAC owners in MA" | Searches by industry, state, stage or lane |
| "Set treg's budget to $15 a day" | A preview, then the change |
| "Pause everything" | Every engine, on both machines, stops before its next batch |

For long unattended runs, in `engine/` run `npm run worker`, or `node src/cli.mjs worker 120` to
stop after 120 minutes. Ctrl+C stops it after the current row.

## Money

**Two layers.** Each task has its own cap, from its preview: that's the real control, so the money follows the
day's work. The daily budgets are a safety net, set once (for example $50 total) and rarely touched.

**Never paid twice.** A firm already past the website and owner steps isn't worked again; a person verified in the
last 90 days, or marked do not contact, is left alone. A listed owner is **one** source: the engine still finds a
second before you're asked to approve them.

**Cheapest first.** Owners: Leadocean (inside the deal), a web search, BlitzAPI, then Apollo (a credit). Emails: an
email Apollo already returned (free), Leadocean (free), Kitt (paid only when found), Tomba, then the patterns.
Verifying: MillionVerifier first, and Tomba only when MillionVerifier says valid.

- **Budgets** live in the `budgets` table: one row per tool, plus `total`, which starts at $25 a
  day. The engine checks them before every paid call. Each job also has its own ceiling.
- **Every paid call** is a row in `costs`, with the tool, the job, the person and the dollars.
  `spend_today` shows today.
- Listed prices (treg's catalogue, 2026-10-29): a Maps search $0.00015 for up to 100 places; a
  web search $0.001; Kitt $0.005 per email found (misses free); MillionVerifier $0.0018; Tomba
  $0.0089 each. Apollo uses credits (1 per match). The dollar value per credit is
  `ENRICH_APOLLO_CREDIT_USD`, **[assumed] $0.01 until you set it from your plan**. Leadocean is
  inside the lifetime deal's limits.
- The website read: **[assumed] about $0.002 to $0.004** per site sent to the AI (at most 6,000
  characters of it), and $0 when no AI is needed. The real cost is in `costs`; how each site was read
  (`code_only` or `model`) is in `companies.site_read`. The 40-firm run checks both numbers.

## Before volume: three open points

1. **The 40-firm accuracy run** on the first industry, with "good" written before it
   (playbook §6). Choose the industry and area when the keys are in.
2. **Google Maps data:** the Maps rows come from a crawl of Google. Google's terms bar its own
   customers from storing business names and addresses; whether that reaches us is a legal
   question (docs, finding 2).
3. **treg's terms** list "send spam or bulk unsolicited email". treg doesn't send, but ask them in
   writing (docs, finding 3).

## Enrich a list's emails, file to file (nothing pushed to Supabase)

For a list you just want emails for (a lemlist or Apollo export), without putting the people in the database:

```
node src/cli.mjs email-list "<the list.csv>" "<the Results folder>" <rows> <max $>
```

- **Who:** owners, CEOs, founders, co-founders, and plain "President" (flagged in `enrich_title_check`, because the title
  doesn't prove ownership). Everyone else is in the results, marked `skipped`.
- **Order:** Leadocean (by LinkedIn), then Apollo and Smartlead (split half and half over the rows). An address its own
  provider marks verified is taken as it is (D9-5); when none has one, the first unverified address gets one
  MillionVerifier check. No patterns. A slow or out-of-credits tool is skipped, and the run carries on.
- **Domains:** the firm's own domain goes in the `main` lane. The same firm's other domain (raybrownac.com for
  raybrownairandheat.com) goes in the stricter `verified` lane, flagged. Another business's domain is never used.
- **Catch-all** addresses can't be proved. They go in `catchall_email`, never in `email`.
- **The results file** keeps every row and every original column in its order, with **one** `email` column (a blank one
  is filled with the verified address; a listed one is never overwritten). Right after `email`:
  - `email_status`: `verified`, `catch_all`, `not_found`, `unknown`, `duplicate`, `not_owner`, `hold_state` or
    `pending`;
  - `email_source`: leadocean, apollo, smartlead or list;
  - `email_lane`: `main`, or `separate` for its own stricter campaign;
  - `catchall_email`.

  At the end: `state`, `state_on_hold`, `title_check`, `checked_by`, `checked_at` and `enrich_note`. Two rows never
  get the same address (`duplicate`). A listed email that didn't pass says "NOT verified" in `enrich_note`.
  **Send only rows whose `email_status` is `verified`.**
- **Progress** is saved after every row (`.progress.jsonl`): run the same command again and it carries on, never paying
  for a row twice. Add `redo` at the end to look again at rows the first, stricter rules left without an address.
- **Writes to Supabase:** only the job row and its costs rows (the budgets need them), never a contact.
- **The first test (2026-10-29, 50 rows):** 13 verified (26%), 18 catch-all, about $0.02 a row, $0.08 per verified
  email. [inferred, a small sample]

## What it doesn't do

It doesn't send email or push to Smartlead (that's the outreach phase). It never collects
people's phone numbers. It reads LinkedIn only through a provider's API. It uses no n8n.
