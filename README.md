# CoreCRM: a department-based CRM on AWS

A general multi-user CRM organised by **departments**:

- **Invite-only.** There's no public sign-up. The owner account, **hello@soustap.com**, is created automatically as the manager when the app is deployed. Managers add everyone else from **Team & access**, and each new person is emailed a temporary password.
- **Two-step verification.** Managers must sign in with a password plus a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…). It's optional for everyone else, who can turn it on under *Profile*.
- **Managers** create departments (Sales, IT Support, Accounts, Customer Service…), add people to them, and see and assign every ticket.
- **Team members** only see tickets from the departments they belong to. Someone in Sales can't see IT tickets, and vice versa. People can belong to more than one department.
- **Customers** (contacts and companies) are one shared directory, so the same customer isn't entered twice. Each person still only sees *tickets* from their own departments.

Each department is one of two types:

| Type | Board | Fields |
|---|---|---|
| **Support queue** | Ticket list with filters | Priority, status, SLA timer (Urgent 4h · High 8h · Normal 24h · Low 72h), category, assignee |
| **Sales pipeline** | Drag-and-drop stages | Deal value, stage (New lead → … → Won / Lost), owner, expected close, lead source |

**Old tickets** are never deleted automatically. Resolved/closed tickets drop out of the default *Active* view but stay searchable. Managers can **bulk delete**: on any department board, use the *Closed* filter (e.g. "Closed 1+ year ago"), tick tickets or "select all", then click *Delete* twice to confirm. Each ticket's activity history is deleted with it. Members can't delete tickets, and AppSync refuses it.

Tickets are numbered per department with a prefix you choose (`IT-1001`, `SAL-1001`, `ACC-1001`).

## How the separation is enforced

It runs entirely on AWS through **Amplify Gen 2**: Cognito (logins), AppSync (API), DynamoDB (data), Lambda (team admin) and Amplify Hosting.

- Each department is a **Cognito group** (`dept-xxxx`), created automatically when a manager adds the department.
- Every ticket stores its department's group, and **AppSync only returns it to members of that group, or to MANAGERS**. This is checked on every API request, not just hidden in the UI.
- `MANAGERS` see everything. `STAFF` (any approved person) can use the shared customer directory. People in no group are *pending* and see nothing.
- Self sign-up is switched off in Cognito (`AllowAdminCreateUserOnly`), so accounts can only be created by managers through the app (an admin Lambda calls `AdminCreateUser`).
- The owner account can't be removed, disabled or demoted from the app, and there must always be at least one manager.
- Team-management calls are refused unless the calling manager has two-step verification switched on, so the rule isn't just enforced by the screen.

Because people can be in many departments, the app refreshes every 30 seconds instead of using live push updates. AWS limits live updates for this kind of per-record access rule.

## Deploy to AWS (about 15 minutes)

1. In the **AWS console**, switch to the region you want your data in (e.g. **Europe (London) eu-west-2**, top-right), then open **AWS Amplify → Create new app → GitHub**. Authorise, then pick this repo and branch (`main`).
2. Amplify detects `amplify.yml`. Leave the build settings as they are. If it asks for a **service role**, let it create one (it needs `AmplifyBackendDeployFullAccess`).
3. Click **Save and deploy**. The first build creates Cognito, DynamoDB, AppSync, the Lambda functions, and the **hello@soustap.com** manager account. It takes about 5–10 minutes.
4. **Check the hello@soustap.com inbox** (and spam) for *"You've been invited to CoreCRM"*. It contains a temporary password, valid for 7 days.
5. Open the app link Amplify shows (`https://main.xxxxx.amplifyapp.com`) and sign in with that email and temporary password. You'll:
   - choose your own password, then
   - scan a QR code with an authenticator app and enter the 6-digit code. This is required for managers.
6. Under **Manage → Departments**, create your departments. Under **Team & access → + Add person**, add your team and tick their departments. Each person gets an invite email.

Every push to the connected branch redeploys both the backend and the website.

**Changing the owner email:** set `MANAGER_EMAIL` under Amplify → *Hosting → Environment variables* and redeploy. The new address gets a manager account and an invite. The old one stays a manager until you change it in the app.

**Invite expired or lost?** For team members, click **Resend invite** in Team & access. For the owner account, run this with the AWS CLI (the user pool id is in Amplify → *Authentication*):
```bash
aws cognito-idp admin-create-user --user-pool-id <pool-id> --username hello@soustap.com --message-action RESEND
```

**Lost the authenticator phone?** Another manager can't reset it from the app. In the AWS console go to **Cognito → User pools → your pool → Users → the user → Edit MFA** (or delete and re-invite the user).

**Emails:** Cognito sends invites and reset codes from a shared AWS address (often `no-reply@verificationemail.com`), with a low daily limit. That's fine for a small team. For your own "from" address or more volume, connect Amazon SES (Amplify docs: *Auth → Email customization*).

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
amplify/config.ts                  owner email (hello@soustap.com) and app link for invite emails
amplify/backend.ts                 switches off self sign-up, creates the owner manager account on deploy
amplify/auth/resource.ts           Cognito: email login, two-step (TOTP), invite email, MANAGERS / STAFF groups
amplify/data/resource.ts           data models + who can access what
amplify/data/next-ref.js           atomic per-department ticket counter (AppSync resolver)
amplify/data/admin-users/          Lambda: invite / resend / disable / remove people, set access, department groups
amplify.yml                        Amplify Hosting build
tests/ui/                          browser smoke test using an in-memory fake of AWS
```

## Tests

The UI smoke test (28 checks) runs against an in-memory fake of AWS that applies the same access rules. It covers the invite-only sign-in: the owner's first sign-in (temporary password, own password, forced authenticator setup) and the authenticator code on later sign-ins. It covers adding, re-inviting, disabling and removing people; protection of the owner account; a member's first sign-in; and optional 2-step for members. It also checks department isolation: a Sales member and an IT + Accounts member each see only their own departments, including via direct API calls.

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
- Department leads (manage their own department without being a full manager)
- Move to Aurora Postgres if reporting needs outgrow DynamoDB
