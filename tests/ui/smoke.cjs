// Browser smoke test against an in-memory stand-in for AWS (tests/ui/fake-amplify.js).
// Usage: npx playwright install chromium && python3 -m http.server 8765 & node tests/ui/smoke.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:8765/';
const SHOTS = __dirname + '/screenshots';
(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const fake = fs.readFileSync(__dirname + '/fake-amplify.js', 'utf8');
  const importmap = '<script type="importmap">{"imports":{"aws-amplify":"/__fake.js","aws-amplify/auth":"/__fake.js","aws-amplify/data":"/__fake.js"}}</script><link rel="stylesheet" href="/src/app.css">';
  await ctx.route(/\/(index\.html)?(#.*)?$/, async r => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace('<script type="module"', importmap + '<script type="module"') }); });
  await ctx.route('**/src/main.js', async r => { const res = await r.fetch(); r.fulfill({ response: res, contentType: 'application/javascript', body: (await res.text()).replace('import "./app.css";', '') }); });
  await ctx.route('**/__fake.js', r => r.fulfill({ contentType: 'application/javascript', body: fake }));
  await ctx.route('**/amplify_outputs.json', r => r.fulfill({ contentType: 'application/json', body: '{}' }));
  await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  const page = await ctx.newPage();
  const EXPECTED = /at least one manager|tickets? first/;
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !EXPECTED.test(m.text())) errors.push('console: ' + m.text()); });
  const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) process.exitCode = 1; };
  const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png` });
  const nav = async text => { await page.click(`nav >> text="${text}"`); await page.waitForTimeout(150); };
  const signOutIfIn = async () => { if (await page.isVisible('#signout')) await page.click('#signout'); else if (await page.isVisible('#so')) await page.click('#so'); await page.waitForSelector('#af'); };
  const login = async email => { await signOutIfIn(); await page.fill('input[name=email]', email); await page.fill('input[name=password]', 'Password1!'); await page.click('#asub'); await page.waitForSelector('.shell, .auth-card h1:has-text("Waiting")'); };
  const api = (fn, arg) => page.evaluate(async ([src, arg]) => { const m = await import('/__fake.js'); const c = m.generateClient(); return (new Function('c', 'arg', 'return (' + src + ')(c, arg)'))(c, arg); }, [fn.toString(), arg]);

  await page.goto(BASE); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForSelector('#af');

  // ---- MANAGER sets up departments and team
  await login('manager@x.com');
  ok(await page.isVisible('text=No departments yet'), 'manager: empty state prompts to create a department');
  ok(await page.isVisible('nav >> text="Team & access"'), 'manager: sees Manage section');
  const mkDept = async (name, kind, code) => {
    await page.goto(BASE + '#departments'); await page.click('text=+ New department');
    await page.fill('#modal input[name=name]', name); await page.selectOption('#modal select[name=kind]', kind); await page.fill('#modal input[name=code]', code); await page.click('#msave');
    await page.waitForSelector(`nav >> text="${name}"`);
  };
  await mkDept('Sales', 'pipeline', 'SAL'); await mkDept('IT Support', 'support', 'IT'); await mkDept('Accounts', 'support', 'ACC'); await mkDept('Temp', 'support', 'TMP');
  ok(true, 'manager created 4 departments');
  await shot('01-departments');

  await page.goto(BASE + '#team'); await page.waitForSelector('tr[data-user=u-sam]');
  ok(await page.isVisible('nav .count.alert'), 'manager: pending people flagged');
  const grant = async (user, names) => {
    for (const n of names) await page.check(`tr[data-user=${user}] label.chip:has-text("${n}") input`);
    await page.click(`tr[data-user=${user}] .u-save`); await page.waitForSelector('.toast >> text=Access updated');
    await page.waitForTimeout(200);
  };
  await grant('u-sam', ['Sales']); await grant('u-ian', ['IT Support', 'Accounts']);
  ok(true, 'manager granted Sam → Sales, Ian → IT Support + Accounts');
  await shot('02-team');
  const lastMgr = page.waitForSelector('.toast.err >> text=at least one manager');
  await page.uncheck('tr[data-user=u-manager] .u-mgr'); await page.click('tr[data-user=u-manager] .u-save'); await lastMgr;
  ok(true, 'last manager cannot remove themselves');

  // tickets in each department
  await nav('Contacts'); await page.click('text=+ Contact');
  await page.fill('#modal input[name=fullName]', 'Jane Doe'); await page.fill('#modal input[name=email]', 'jane@acme.com'); await page.click('#msave'); await page.waitForSelector('td >> text=Jane Doe');

  await nav('Sales'); await page.click('text=+ New deal');
  await page.fill('#modal input[name=title]', 'Website rebuild'); await page.selectOption('#modal select[name=contactId]', { label: 'Jane Doe' }); await page.fill('#modal input[name=value]', '12000');
  await page.selectOption('#modal select[name=assigneeId]', { label: 'Sam Sales' }); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=SAL-1001'); ok(true, 'Sales deal numbered SAL-1001');
  ok(!(await page.$$eval('#tassign option', os => os.map(o => o.textContent))).includes('Ian IT'), 'Sales owner list excludes IT-only staff');
  await page.click('#dclose'); await page.waitForTimeout(250);
  await page.dragAndDrop('.card:has-text("Website rebuild")', '.col[data-stage=proposal]'); await page.waitForSelector('.col[data-stage=proposal] >> text=Website rebuild');
  ok(true, 'drag & drop on pipeline board');

  await page.goto(BASE + '#dashboard'); await page.click('text=+ New ticket');
  await page.selectOption('#modal select[name=departmentId]', { label: 'IT Support (Support queue)' }); await page.click('#msave');
  await page.waitForSelector('#modal.on >> text=New ticket · IT Support');
  await page.fill('#modal input[name=title]', 'Laptop won\'t boot'); await page.selectOption('#modal select[name=contactId]', { label: 'Jane Doe' }); await page.selectOption('#modal select[name=priority]', 'urgent');
  await page.selectOption('#modal select[name=assigneeId]', { label: 'Ian IT' }); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=IT-1001'); ok(true, 'dashboard → choose department → IT-1001 created and assigned');
  await page.click('#dclose'); await page.waitForTimeout(250);

  await nav('IT Support'); await page.click('text=+ New ticket');
  await page.fill('#modal input[name=title]', 'Invoice query'); await page.click('#msave'); await page.waitForSelector('#drawer.on >> text=IT-1002');
  await page.selectOption('#tdept', { label: 'Accounts' }); await page.waitForSelector('#drawer >> text=Moved from IT Support to Accounts');
  ok(true, 'manager moved ticket IT → Accounts (logged)');
  await page.click('#dclose'); await page.waitForTimeout(250);
  await nav('Accounts'); ok(await page.isVisible('td >> text=Invoice query'), 'moved ticket appears on Accounts board');
  await page.goto(BASE + '#dashboard'); await page.waitForSelector('.dcards'); await shot('03-manager-dashboard');

  // department delete rules
  await page.goto(BASE + '#departments'); await page.click('tr:has-text("Accounts") [data-editdept]');
  const blocked = page.waitForSelector('.toast.err >> text=ticket(s) first');
  await page.click('#mextra'); await page.click('#mextra'); await blocked; ok(true, 'cannot delete a department that has tickets');
  await page.click('#mcancel');
  await page.click('tr:has-text("Temp") [data-editdept]'); await page.click('#mextra'); await page.click('#mextra');
  await page.waitForSelector('.toast >> text=Department deleted'); ok(!(await page.isVisible('nav >> text="Temp"')), 'empty department deleted');

  // ---- SAM (Sales only)
  await login('sam@x.com');
  ok(await page.isVisible('nav >> text="Sales"') && !(await page.isVisible('nav >> text="IT Support"')) && !(await page.isVisible('nav >> text="Accounts"')), 'Sam: only Sales in nav');
  ok(!(await page.isVisible('nav >> text="Team & access"')), 'Sam: no Manage section');
  const samView = await api(async c => { const t = await c.models.Ticket.list(); return t.data.map(x => x.refCode).sort().join(','); });
  ok(samView === 'SAL-1001', 'Sam: API returns only Sales tickets (got ' + samView + ')');
  const samDepts = await api(async c => (await c.models.Department.list()).data.map(d => d.name).join(','));
  ok(samDepts === 'Sales', 'Sam: API returns only his department (got ' + samDepts + ')');
  const sneaky = await api(async c => { const d = (await c.models.Ticket.list()).data[0]; const r = await c.models.Ticket.create({ title: 'x', departmentId: 'x', departmentGroup: 'dept-not-mine' }); return r.errors?.[0]?.errorType; });
  ok(sneaky === 'Unauthorized', 'Sam: API refuses creating a ticket in another department');
  await page.goto(BASE + '#departments'); await page.waitForTimeout(200); ok(await page.isVisible('h1:has-text("Hi")'), 'Sam: #departments URL falls back to dashboard');
  await nav('Contacts'); await page.click('td >> text=Jane Doe');
  await page.waitForSelector('#drawer.on >> text=Website rebuild');
  ok(!(await page.isVisible('#drawer >> text=Laptop')) && (await page.innerText('#drawer')).includes('Tickets you can see (1)'), 'Sam: contact shows only Sales tickets');
  ok(!(await page.isVisible('#ddel')), 'Sam: cannot delete shared contacts');
  await page.click('#dclose');
  await nav('My tickets'); ok(await page.isVisible('td >> text=Website rebuild'), 'Sam: assigned deal in My tickets');
  await shot('04-sam');

  // ---- IAN (IT + Accounts)
  await login('ian@x.com');
  ok(await page.isVisible('nav >> text="IT Support"') && await page.isVisible('nav >> text="Accounts"') && !(await page.isVisible('nav >> text="Sales"')), 'Ian: IT Support + Accounts, no Sales');
  const ianView = await api(async c => (await c.models.Ticket.list()).data.map(x => x.refCode).sort().join(','));
  ok(ianView === 'IT-1001,IT-1002', 'Ian: API returns IT + Accounts tickets only (got ' + ianView + ')');
  await nav('IT Support'); await page.click('td >> text=Laptop');
  await page.fill('#nt', 'Reseated the RAM, booting now'); await page.click('#addn'); await page.waitForSelector('#drawer >> text=Reseated the RAM');
  await page.selectOption('#tstatus', 'resolved'); await page.waitForSelector('#drawer >> text=Status: Open → Resolved');
  ok(true, 'Ian: adds note and resolves ticket');
  ok(!(await page.isVisible('#tdept')) && !(await page.isVisible('#ddel')), 'Ian: cannot move or delete tickets');
  await shot('05-ian-ticket');
  await page.click('#dclose');

  // ---- New sign-up → pending → approved
  await signOutIfIn(); await page.click('[data-m=signup]');
  await page.fill('input[name=name]', 'Nina New'); await page.fill('input[name=email]', 'nina@x.com'); await page.fill('input[name=password]', 'Password1!'); await page.click('#asub');
  await page.fill('input[name=code]', '123456'); await page.click('#asub');
  await page.waitForSelector('text=Waiting for approval'); ok(true, 'new sign-up waits for approval');
  await login('manager@x.com'); await page.goto(BASE + '#team'); await page.waitForSelector('tr[data-user=u-nina]');
  await grant('u-nina', ['Accounts']);
  await login('nina@x.com');
  ok(await page.isVisible('nav >> text="Accounts"') && !(await page.isVisible('nav >> text="IT Support"')), 'approved user sees only Accounts');
  await shot('06-nina');

  ok(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
