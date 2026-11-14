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
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/at least one admin/.test(m.text())) errors.push('console: ' + m.text()); });
  const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) process.exitCode = 1; };
  const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png` });
  const signOutIfIn = async () => { if (await page.isVisible('#signout')) { await page.click('#signout'); } else if (await page.isVisible('#so')) { await page.click('#so'); } await page.waitForSelector('#af'); };
  const login = async (email) => {
    await signOutIfIn();
    await page.fill('input[name=email]', email); await page.fill('input[name=password]', 'Password1!'); await page.click('#asub');
  };

  await page.goto(BASE); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForSelector('#af');
  ok(await page.isVisible('text=Sign in to your workspace'), 'login screen renders');
  await page.fill('input[name=email]', 'sales@x.com'); await page.fill('input[name=password]', 'wrongpass1'); await page.click('#asub');
  await page.waitForSelector('.msg.err >> text=Incorrect username or password'); ok(true, 'bad password shows error');

  // ADMIN
  await login('admin@x.com'); await page.waitForSelector('.shell');
  ok(await page.isVisible('nav >> text=Sales pipeline') && await page.isVisible('nav >> text=IT Support') && await page.isVisible('nav >> text=Users & roles'), 'admin sees all sections');
  await page.click('nav >> text=Companies'); await page.click('text=+ Company');
  await page.fill('#modal input[name=name]', 'Acme Ltd'); await page.click('#msave');
  await page.waitForSelector('td >> text=Acme Ltd'); ok(true, 'company created');
  await page.click('nav >> text=Contacts'); await page.click('text=+ Contact');
  await page.fill('#modal input[name=fullName]', 'Jane Doe'); await page.selectOption('#modal select[name=companyId]', { label: 'Acme Ltd' }); await page.fill('#modal input[name=email]', 'jane@acme.com'); await page.click('#msave');
  await page.waitForSelector('td >> text=Jane Doe'); ok(true, 'contact created');

  await page.click('nav >> text=Sales pipeline'); await page.click('text=+ Sales ticket');
  await page.fill('#modal input[name=title]', 'Website rebuild'); await page.selectOption('#modal select[name=contactId]', { label: 'Jane Doe · Acme Ltd' }); await page.fill('#modal input[name=value]', '12000'); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=SAL-1001'); ok(true, 'deal created as SAL-1001 and drawer opened');
  ok(await page.isVisible('#drawer >> a:has-text("Acme Ltd")'), 'company auto-filled from contact');
  await page.waitForSelector('#drawer >> text=Sales ticket created'); ok(true, 'creation logged');
  await page.selectOption('#dstage', 'proposal'); await page.waitForSelector('#drawer >> text=Stage: New lead → Proposal'); ok(true, 'stage change logged');
  await page.selectOption('#nk', 'call'); await page.fill('#nt', 'Called Jane, keen to proceed'); await page.click('#addn');
  await page.waitForSelector('#drawer >> text=Called Jane, keen to proceed'); ok(true, 'note added');
  await page.click('#dclose'); await page.waitForTimeout(300);
  ok(await page.isVisible('.col[data-stage=proposal] >> text=Website rebuild'), 'deal sits in Proposal column');
  await page.dragAndDrop('.card:has-text("Website rebuild")', '.col[data-stage=won]');
  await page.waitForSelector('.col[data-stage=won] >> text=Website rebuild'); ok(true, 'drag & drop moved deal to Won');
  await shot('02-pipeline');

  await page.click('nav >> text=IT Support'); await page.click('text=+ IT ticket');
  await page.fill('#modal input[name=subject]', 'Printer jammed'); await page.selectOption('#modal select[name=contactId]', '__new');
  ok(await page.isVisible('#modal input[name=newContact]'), 'new-contact fields appear');
  await page.fill('#modal input[name=newContact]', 'Bob Smith'); await page.selectOption('#modal select[name=priority]', 'urgent'); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=IT-1001'); ok(true, 'ticket created as IT-1001 with inline contact');
  const sla = await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('fake-aws')).t.Ticket[0]; return (Date.parse(t.slaDue) - Date.parse(t.createdAt)) / 3600e3; });
  ok(Math.abs(sla - 4) < 0.01, 'urgent SLA is 4h (got ' + sla.toFixed(2) + 'h)');
  await page.selectOption('#tassign', { label: 'Ian IT' }); await page.waitForSelector('#drawer >> text=Assigned to Ian IT');
  await page.selectOption('#tstatus', 'in_progress'); await page.waitForSelector('#drawer >> text=Status: Open → In progress'); ok(true, 'ticket assignment + status logged');
  await page.selectOption('#tprio', 'low'); await page.waitForSelector('#drawer >> text=Priority: Urgent → Low');
  const sla2 = await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('fake-aws')).t.Ticket[0]; return (Date.parse(t.slaDue) - Date.parse(t.createdAt)) / 3600e3; });
  ok(Math.abs(sla2 - 72) < 0.01, 'priority change recalculates SLA to 72h');
  await shot('03-ticket');
  await page.click('#dclose'); await page.waitForTimeout(300);
  ok(await page.isVisible('td >> text=Printer jammed'), 'ticket in queue');
  await page.click('nav >> text=Dashboard'); await page.waitForSelector('text=Open pipeline'); await shot('04-dashboard-admin');
  await page.click('nav >> text=Users & roles'); await page.waitForSelector('td >> text=Ian IT');
  await shot('05-users');
  const lastAdmin = page.waitForSelector('.toast.err >> text=at least one admin');
  await page.selectOption('select[data-role=u-admin]', 'sales'); await lastAdmin; ok(true, 'last admin cannot be demoted');

  // SIGN UP a new person -> pending
  await signOutIfIn(); await page.click('[data-m=signup]');
  await page.fill('input[name=name]', 'Nina New'); await page.fill('input[name=email]', 'nina@x.com'); await page.fill('input[name=password]', 'Password1!'); await page.click('#asub');
  await page.waitForSelector('text=Check your email'); await page.fill('input[name=code]', '000000'); await page.click('#asub');
  await page.waitForSelector('.msg.err'); ok(true, 'wrong confirmation code rejected');
  await page.fill('input[name=code]', '123456'); await page.click('#asub');
  await page.waitForSelector('text=Waiting for approval'); ok(true, 'new sign-up lands on pending screen');
  await shot('06-pending');

  // ADMIN approves Nina as IT
  await login('admin@x.com'); await page.waitForSelector('.shell'); await page.goto(BASE + '#users');
  await page.waitForSelector('select[data-role=u-nina]');
  ok(await page.isVisible('nav .count.alert'), 'admin sees pending badge');
  await page.selectOption('select[data-role=u-nina]', 'it'); await page.waitForSelector('.toast >> text=is now IT Support'); ok(true, 'admin assigns role');

  // SALES
  await login('sales@x.com'); await page.waitForSelector('.shell');
  ok(!(await page.isVisible('nav >> text=IT Support')), 'sales: no IT Support in nav');
  ok(!(await page.isVisible('nav >> text=Users & roles')), 'sales: no admin section');
  ok(!(await page.isVisible('text=Past SLA')), 'sales: dashboard has no IT stats');
  await page.goto(BASE + '#queue'); await page.waitForSelector('.shell'); await page.waitForTimeout(300);
  ok(await page.isVisible('text=Open pipeline') && !(await page.isVisible('text=IT Support queue')), 'sales: #queue URL falls back to dashboard');
  const salesTickets = await page.evaluate(async () => { const m = await import('/__fake.js'); const c = m.generateClient(); const r = await c.models.Ticket.list(); return { n: r.data.length, err: r.errors?.[0]?.errorType }; });
  ok(salesTickets.n === 0 && salesTickets.err === 'Unauthorized', 'sales: API refuses to list tickets');
  await page.click('nav >> text=Contacts'); await page.click('td >> text=Bob Smith');
  ok(!(await page.isVisible('#drawer >> text=IT tickets')) && !(await page.isVisible('#drawer >> text=Printer jammed')), 'sales: contact drawer shows no IT tickets');
  ok(!(await page.isVisible('#ddel')), 'sales: no delete button on shared contacts');
  await page.click('#dclose');

  // IT (Nina, newly approved)
  await login('nina@x.com'); await page.waitForSelector('.shell');
  ok(await page.isVisible('nav >> text=IT Support') && !(await page.isVisible('nav >> text=Sales pipeline')), 'approved IT user: IT only');
  ok(!(await page.isVisible('text=Open pipeline')), 'IT: dashboard has no sales stats');
  await page.click('nav >> text=Companies'); await page.click('td >> text=Acme Ltd');
  ok(!(await page.isVisible('#drawer >> text=Website rebuild')), 'IT: company drawer hides deals');
  await page.click('#dclose');
  await shot('07-it');

  ok(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
