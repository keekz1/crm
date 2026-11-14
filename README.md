# CoreCRM: a department-based CRM on AWS

A general multi-user CRM organised by **departments**:

- **Managers** create departments (Sales, IT Support, Accounts, Customer Service…), add people to them, and see and assign every ticket.
- **Team members** only see tickets from the departments they belong to. Someone in Sales can't see IT tickets, and vice versa. People can belong to more than one department.
- **Customers** (contacts and companies) are one shared directory, so the same customer isn't entered twice. Each person still only sees *tickets* from their own departments.

Each department is one of two types:

| Type | Board | Fields |
|---|---|---|
| **Support queue** | Ticket list with filters | Priority, status, SLA timer (Urgent 4h · High 8h · Normal 24h · Low 72h), category, assignee |
| **Sales pipeline** | Drag-and-drop stages | Deal value, stage (New lead → … → Won / Lost), owner, expected close, lead source |

Tickets are numbered per department with a prefix you choose (`IT-1001`, `SAL-1001`, `ACC-1001`).

## How the separation is enforced

It runs entirely on AWS through **Amplify Gen 2**: Cognito (logins), AppSync (API), DynamoDB (data), Lambda (team admin) and Amplify Hosting.

- Each department is a **Cognito group** (`dept-xxxx`), created automatically when a manager adds the department.
- Every ticket stores its department's group, and **AppSync only returns it to members of that group, or to MANAGERS**. This is checked on every API request, not just hidden in the UI.
- `MANAGERS` see everything. `STAFF` (any approved person) can use the shared customer directory. People in no group are *pending* and see nothing.
- The **first person to sign up becomes the manager**. Everyone else waits until a manager adds them under **Team & access**.

Because people can be in many departments, the app refreshes every 30 seconds instead of using live push updates. AWS limits live updates for this kind of per-record access rule.

## Deploy to AWS (about 15 minutes)

1. **Push this repo to GitHub** (already done if you're reading this on GitHub).
2. In the **AWS console**, switch to the region you want your data in (e.g. **Europe (London) eu-west-2**, top-right), then open **AWS Amplify → Create new app → GitHub**. Authorise, then pick this repo and branch.
3. Amplify detects `amplify.yml`. Leave the build settings as they are. If it asks for a **service role**, let it create one. It needs permission to deploy the backend (the managed policy is `AmplifyBackendDeployFullAccess`).
4. Click **Save and deploy**. The first build creates Cognito, DynamoDB, AppSync and the Lambda functions. It takes about 5–10 minutes.
5. Open the app link Amplify gives you (`https://main.xxxxx.amplifyapp.com`), click **Create account**, and confirm with the code sent to your email. **You're the manager.**
6. Under **Manage → Departments**, create your departments and pick a type for each.
7. Teammates create their own accounts. Under **Team & access**, tick the departments each person can see (or make them a manager).

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
amplify/auth/resource.ts           Cognito: email login, MANAGERS / STAFF groups (+ one group per department)
amplify/auth/post-confirmation/    makes the first user the manager
amplify/data/resource.ts           data models + who can access what
amplify/data/next-ref.js           atomic per-department ticket counter (AppSync resolver)
amplify/data/admin-users/          Lambda: list the team, set access, create/delete department groups
amplify.yml                        Amplify Hosting build
tests/ui/                          browser smoke test using an in-memory fake of AWS
```

## Tests

The UI smoke test (30 checks) runs against an in-memory fake of AWS that applies the same access rules. As a manager it creates departments, grants access, creates, moves and assigns tickets, and checks the department delete rules. As a Sales member and an IT + Accounts member it checks that each sees only their departments, including via direct API calls. It also covers a new sign-up being approved.

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
