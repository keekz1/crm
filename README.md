# CoreCRM — Sales & IT Support

A multi-user web CRM where **Sales and IT Support are completely separate**. Sales staff never see IT tickets and IT staff never see deals. Both teams share one directory of contacts and companies.

The separation is enforced **by the database** (Postgres Row Level Security), not just hidden in the UI. Even someone poking at the API with their own login can't read the other team's data.

| Role | Sees |
|---|---|
| **Pending** | Nothing. New sign-ups wait here until an admin approves them |
| **Sales** | Dashboard, sales pipeline, contacts, companies |
| **IT Support** | Dashboard, IT ticket queue, contacts, companies |
| **Admin** | Everything, plus *Users & roles* |

The **first person to sign up becomes admin** automatically.

## Features

**Sales**
- Tickets numbered `SAL-1001`, `SAL-1002`, … on a drag-and-drop pipeline (New lead → Qualified → Proposal → Negotiation → Won / Lost)
- Value, owner, expected close, lead source, reason lost
- Activity log: notes, calls, emails, meetings, plus automatic stage-change history
- Dashboard: open pipeline, won this month, win rate, deals closing in 30 days, pipeline by stage

**IT Support**
- Tickets numbered `IT-1001`, … with category, priority, status and assignee
- SLA timers set by the database: Urgent 4h · High 8h · Normal 24h · Low 72h. Overdue tickets are flagged and float to the top
- Internal notes, plus automatic history of status, priority and assignee changes
- Dashboard: open, past SLA, unassigned, resolved in the last 7 days, *assigned to me*

**Shared**
- Contacts and companies, each showing only the linked records the viewer is allowed to see
- Create a contact inline while logging a ticket
- Live updates across users (Supabase Realtime)
- CSV export, search and filters
- Email + password login, sign-up, password reset

## Setup (about 10 minutes)

### 1. Create the database
1. Create a free project at [supabase.com](https://supabase.com).
2. In the dashboard, open **SQL Editor → New query**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**. It's safe to run again later.
3. Under **Authentication → URL Configuration**, set **Site URL** to wherever you'll host the app (e.g. `https://keekz1.github.io/crm/`). This is where confirmation and password-reset emails link to.

### 2. Point the app at it
Edit [`js/config.js`](js/config.js) with values from **Project Settings → API**:

```js
window.CRM_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",   // the "anon public" key, safe to publish
  COMPANY_NAME: "CoreCRM"
};
```

Never put the `service_role` key in this file.

### 3. Host it
It's static files with no build step. Any of these work:
- **AWS Amplify** (recommended): **Deploy an app → GitHub → `keekz1/crm` → branch `main`**. The included [`amplify.yml`](amplify.yml) is picked up automatically. Under **Hosting → Environment variables**, add `SUPABASE_URL`, `SUPABASE_ANON_KEY` (and optionally `COMPANY_NAME`), then redeploy. The build writes `js/config.js` from those variables, so your keys don't need to be committed.
- **GitHub Pages**: repo **Settings → Pages → Deploy from branch → `main` / root**.
- **Netlify / Vercel / Cloudflare Pages**: import the repo, with no build command and the output directory set to the root.
- **Locally**: `python3 -m http.server` in this folder, then open http://localhost:8000.

### 4. First login
Open the site, click **Create account**. You become admin. Teammates create their own accounts, then you assign them **Sales** or **IT Support** under **Users & roles**.

> If you run the SQL editor as the project owner you can also change roles directly:
> `update profiles set role = 'admin' where email = 'you@company.com';`

## Project layout

```
index.html            app shell
css/app.css           styles
js/config.js          your Supabase URL + anon key
js/app.js             the app (vanilla JS, ES modules)
js/vendor.js          loads supabase-js from a CDN
supabase/schema.sql   tables, triggers, Row Level Security, realtime
supabase/tests/       access-rule tests against a local Postgres
tests/ui/             browser smoke test (Playwright) using an in-memory fake backend
```

## Tests

**Database access rules** (34 checks: sales can't read, create or delete tickets; IT can't see deals; pending users see nothing; nobody can promote themselves; the last admin can't be demoted; SLA and activity triggers):

```bash
# needs a local Postgres you can connect to
PGHOST=localhost PGUSER=postgres ./supabase/tests/run_tests.sh
```

**UI smoke test** (logs in as admin, sales and IT, creates records, drags deals, checks each role only sees its own section):

```bash
npm i -D playwright && npx playwright install chromium
python3 -m http.server 8765 &   # from the repo root
node tests/ui/smoke.cjs
```

## Roadmap ideas
- Email-to-ticket (inbound email creates an IT ticket)
- Customer portal for requesters to view their own tickets
- File attachments (Supabase Storage)
- Reports: SLA compliance, revenue by month, rep leaderboard
- Teams within Sales / IT, and per-record ownership rules
