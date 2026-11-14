# CoreCRM — Sales & IT Support on AWS

A multi-user web CRM where **Sales and IT Support are completely separate**. Sales staff never see IT tickets and IT staff never see deals. Both teams share one directory of contacts and companies.

It runs entirely on AWS through **Amplify Gen 2**:

| Piece | AWS service |
|---|---|
| Logins, sign-up, password reset | Amazon Cognito |
| Database | Amazon DynamoDB |
| API and access rules | AWS AppSync |
| Admin user management, first-admin setup | AWS Lambda |
| Website hosting and deploys | AWS Amplify Hosting |

The separation is enforced by the **AppSync API on every request**, using Cognito groups. It's not just hidden in the UI.

| Role (Cognito group) | Can use |
|---|---|
| *Pending* (no group) | Nothing. New sign-ups wait here until an admin approves them |
| **Sales** (`SALES`) | Dashboard, sales pipeline, contacts, companies |
| **IT Support** (`IT`) | Dashboard, IT ticket queue, contacts, companies |
| **Sales + IT** | Both of the above |
| **Admin** (`ADMINS`) | Everything, plus *Users & roles*, and deleting shared contacts/companies |

The **first person to sign up becomes admin** automatically.

## Features

**Sales**: tickets numbered `SAL-1001`, … on a drag-and-drop pipeline (New lead → Qualified → Proposal → Negotiation → Won / Lost); value, owner, expected close, lead source, reason lost; activity log of notes, calls, emails and meetings, plus automatic stage history; dashboard with open pipeline, won this month, win rate and deals closing in 30 days.

**IT Support**: tickets numbered `IT-1001`, … with category, priority, status and assignee; SLA timers (Urgent 4h · High 8h · Normal 24h · Low 72h) with overdue tickets flagged and floated to the top; internal notes, plus automatic status, priority and assignee history; dashboard with open, past SLA, unassigned, resolved this week and *assigned to me*.

**Shared**: contacts and companies, each showing only the linked records the viewer is allowed to see; create a contact inline while logging a ticket; live updates; CSV export; search and filters.

## Deploy to AWS (about 15 minutes)

1. **Push this repo to GitHub** (already done if you're reading this on GitHub).
2. In the **AWS console**, switch to the region you want your data in (e.g. **Europe (London) eu-west-2**, top-right), then open **AWS Amplify → Create new app → GitHub**. Authorise, then pick this repo and branch.
3. Amplify detects `amplify.yml`. Leave the build settings as they are. If it asks for a **service role**, let it create one. It needs permission to deploy the backend (the managed policy is `AmplifyBackendDeployFullAccess`).
4. Click **Save and deploy**. The first build creates Cognito, DynamoDB, AppSync and the Lambda functions. It takes about 5–10 minutes.
5. Open the app link Amplify gives you (`https://main.xxxxx.amplifyapp.com`), click **Create account**, and confirm with the code sent to your email. **You're the admin.**
6. Teammates create their own accounts; you assign them **Sales**, **IT Support** or **Sales + IT** under **Users & roles**.

Every push to the connected branch redeploys both the backend and the website.

**Emails:** Cognito sends sign-up and reset codes from a shared AWS address, with a low daily limit. That's fine for a small team. For more volume or your own "from" address, connect Amazon SES (Amplify docs: *Auth → Email customization*).

**If the first build fails**, open the build log in Amplify and look at the **Backend** step. The error message there is what needs fixing.

## Local development

```bash
npm install
npx ampx sandbox      # deploys a personal cloud sandbox and writes amplify_outputs.json (needs AWS credentials)
npm run dev           # http://localhost:5173
```

## Project layout

```
index.html                         app shell
src/main.js                        the app (vanilla JS)
src/app.css                        styles
amplify/backend.ts                 wires the backend together
amplify/auth/resource.ts           Cognito: email login, ADMINS / SALES / IT groups
amplify/auth/post-confirmation/    makes the first user an admin
amplify/data/resource.ts           data models + who can access what
amplify/data/next-ref.js           atomic SAL-/IT- number counter (AppSync resolver)
amplify/data/admin-users/          Lambda for listing users and changing roles
amplify.yml                        Amplify Hosting build
tests/ui/                          browser smoke test using an in-memory fake of AWS
```

## Tests

The UI smoke test signs in as admin, sales, IT and a brand-new sign-up against an in-memory fake of AWS that applies the same group rules. It checks each role only sees its own section, that the API refuses cross-team reads, SLA maths, numbering, activity logs and role changes.

```bash
npm i -D playwright && npx playwright install chromium
python3 -m http.server 8765 &      # from the repo root
node tests/ui/smoke.cjs
```

## Roadmap ideas
- Email-to-ticket (inbound email creates an IT ticket via SES)
- Customer portal for requesters to view their own tickets
- File attachments (Amplify Storage / S3)
- Reports: SLA compliance, revenue by month
- Move to Aurora Postgres if reporting needs outgrow DynamoDB
