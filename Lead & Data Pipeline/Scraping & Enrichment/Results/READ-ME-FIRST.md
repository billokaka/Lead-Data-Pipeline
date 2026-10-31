# The owners list, with emails (2026-10-30)

From the lemlist export `contacts-10-29-2026 (1).csv`: 19,973 people, mostly owners, CEOs, founders and presidents of
US private companies.

## The three files

| File | What it holds | Use it for |
| :-- | :-- | :-- |
| **`contacts-10-29-2026_1_-enriched-verified-only.csv`** | **9,753 people with a verified email.** Sorted industry by industry | **Sending.** Start here |
| `contacts-10-29-2026_1_-enriched-organized.csv` | Everyone, 19,846 people, sorted the same way, with or without an email | The full picture |
| `contacts-10-29-2026_1_-enriched-duplicates-removed.csv` | 127 people whose email already belongs to someone else on the list | Nothing, unless you want to check them |

Every column from the lemlist export is kept, in its order. The rows are sorted by `companyIndustry` (Construction
first, the largest), with verified people first inside each industry.

## The columns to read

Right after `email`:

| Column | Meaning |
| :-- | :-- |
| **`email`** | The email to use, filled only when it's verified |
| **`email_status`** | `verified`: send to this one. `catch_all`: an email was found, but the company's mail server accepts every address, so it can't be proved (it's in `catchall_email`). `not_found`: no email. `unknown`: the check couldn't decide. `not_owner`: skipped, because the title isn't owner, CEO, founder or president |
| `email_source` | Who found it: Smartlead, Apollo, Leadocean, Kitt, or the list itself |
| `email_lane` | `main`: on the company's own website domain, the safest. `separate`: on the same firm's other domain, so send these in their own campaign |
| `catchall_email` | An unprovable guess for `catch_all` people. Don't mix them with verified emails. If you use them, send them in a small campaign of their own |

At the end:

| Column | Meaning |
| :-- | :-- |
| `state` | The person's US state |
| `state_on_hold` | `approved (D9-7)` for CA, FL, CO, AZ, RI, MI and MN. Read the note below |
| `title_check` | `president (approved as owner, D9-6)` where the title is just "President" |
| `checked_by`, `checked_at` | Which check passed the email, and when |
| `enrich_note` | Details of what was tried |

## Before sending

- **Send only `email_status = verified`.** The verified-only file already holds only those rows.
- **How "verified" was checked:** most addresses were marked verified by the tool that found them (Smartlead "Valid",
  Apollo or Leadocean "verified"). A few were checked by MillionVerifier. A small sample check (200 addresses,
  about $0.30) hasn't been run yet; it would show how far each tool's "verified" holds.
- **States CA, FL, CO, AZ, RI, MI and MN** were approved for outreach by Ahmed on 2026-10-30. Wraith's broker or
  real-estate licences in those states are still unconfirmed. **California expects the broker licence number in the
  email itself.**
- Every email needs the usual parts: an honest sender and subject, an opt-out, and a postal address (CAN-SPAM).
