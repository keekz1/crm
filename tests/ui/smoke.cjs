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
  const importmap = '<script type="importmap">{"imports":{"aws-amplify":"/__fake.js","aws-amplify/auth":"/__fake.js","aws-amplify/data":"/__fake.js","qrcode":"/__fake.js"}}</script><link rel="stylesheet" href="/src/app.css">';
  await ctx.route(/\/(index\.html)?(#.*)?$/, async r => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace('<script type="module"', importmap + '<script type="module"') }); });
  await ctx.route('**/src/main.js', async r => { const res = await r.fetch(); r.fulfill({ response: res, contentType: 'application/javascript', body: (await res.text()).replace('import "./app.css";', '') }); });
  await ctx.route('**/__fake.js', r => r.fulfill({ contentType: 'application/javascript', body: fake }));
  await ctx.route('**/amplify_outputs.json', r => r.fulfill({ contentType: 'application/json', body: '{}' }));
  await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  const page = await ctx.newPage();
  const EXPECTED = /can't be|tickets? first|already has an account/;
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !EXPECTED.test(m.text())) errors.push('console: ' + m.text()); });
  const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) process.exitCode = 1; };
  const shot = n => page.screenshot({ path: `${SHOTS}/${n}.png` });
  const nav = async text => { await page.click(`nav >> text="${text}"`); await page.waitForTimeout(150); };
  const signOutIfIn = async () => { for (const s of ['#signout', '#so']) if (await page.isVisible(s)) { await page.click(s); break; } await page.waitForSelector('#af input[name=email]'); };
  const password = async (email, pw) => { await signOutIfIn(); await page.fill('input[name=email]', email); await page.fill('input[name=password]', pw); await page.click('#asub'); };
  const login = async (email, pw, totp) => { await password(email, pw); if (totp) { await page.waitForSelector('text=Two-step verification'); await page.fill('input[name=code]', '123456'); await page.click('#asub'); } await page.waitForSelector('.shell'); };
  const firstLogin = async (email, newPw) => { await password(email, 'TempPass1!'); await page.waitForSelector('text=Choose your password'); await page.fill('input[name=password]', newPw); await page.fill('input[name=password2]', newPw); await page.click('#asub'); };
  const api = (fn, arg) => page.evaluate(async ([src, arg]) => { const m = await import('/__fake.js'); const c = m.generateClient(); return (new Function('c', 'arg', 'return (' + src + ')(c, arg)'))(c, arg); }, [fn.toString(), arg]);
  const OWNER = 'hello@soustap.com', OWNER_PW = 'Soustap2026!';

  await page.goto(BASE); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForSelector('#af');
  ok(!(await page.isVisible('text=Create account')), 'no public sign-up on the login screen');
  await shot('01-login');

  // ---- OWNER first sign-in: temporary password -> own password -> forced 2-step setup
  await password(OWNER, 'wrongpass1'); await page.waitForSelector('.msg.err >> text=Incorrect email or password'); ok(true, 'wrong password rejected');
  await password(OWNER, 'TempPass1!'); await page.waitForSelector('text=Choose your password'); ok(true, 'owner: temporary password → must choose own password');
  await page.fill('input[name=password]', 'Abcdefg1!'); await page.fill('input[name=password2]', 'different1!'); await page.click('#asub');
  await page.waitForSelector(".msg.err >> text=don't match"); ok(true, 'mismatched passwords caught');
  await page.fill('input[name=password]', OWNER_PW); await page.fill('input[name=password2]', OWNER_PW); await page.click('#asub');
  await page.waitForSelector('text=Set up two-step verification');
  ok(await page.isVisible('.qr img') && !(await page.isVisible('#later')), 'owner: 2-step setup is forced (QR shown, no "Not now")');
  await shot('02-mfa-setup');
  await page.fill('input[name=code]', '000000'); await page.click('#asub'); await page.waitForSelector(".msg.err >> text=isn't right"); ok(true, 'wrong authenticator code rejected');
  await page.fill('input[name=code]', '123456'); await page.click('#asub'); await page.waitForSelector('.shell');
  ok(await page.isVisible('nav >> text="Team & access"'), 'owner lands in the app as manager');

  // ---- departments
  const mkDept = async (name, kind, code) => {
    await page.goto(BASE + '#departments'); await page.click('text=+ New department');
    await page.fill('#modal input[name=name]', name); await page.selectOption('#modal select[name=kind]', kind); await page.fill('#modal input[name=code]', code); await page.click('#msave');
    await page.waitForSelector(`nav >> text="${name}"`);
  };
  await mkDept('Sales', 'pipeline', 'SAL'); await mkDept('IT Support', 'support', 'IT'); await mkDept('Accounts', 'support', 'ACC');
  ok(true, 'manager created departments');

  // ---- team: add people
  const invite = async (name, email, depts) => {
    await page.goto(BASE + '#team'); await page.waitForSelector('tr[data-user]'); await page.click('text=+ Add person');
    await page.fill('#modal input[name=name]', name); await page.fill('#modal input[name=email]', email);
    for (const d of depts) await page.check(`#modal label.chip:has-text("${d}") input`);
    await page.click('#msave'); await page.waitForSelector(`.toast >> text=Invite emailed to ${email}`); await page.waitForSelector(`tr:has-text("${email}")`);
  };
  await invite('Sam Sales', 'sam@x.com', ['Sales']); await invite('Ian IT', 'ian@x.com', ['IT Support', 'Accounts']); await invite('Tom Temp', 'tom@x.com', []);
  ok(await page.isVisible('tr:has-text("sam@x.com") >> text=Invited'), 'invited people show as "Invited"');
  const dupe = page.waitForSelector('.toast.err >> text=already has an account');
  await page.click('text=+ Add person'); await page.fill('#modal input[name=name]', 'Sam again'); await page.fill('#modal input[name=email]', 'sam@x.com'); await page.click('#msave'); await dupe; await page.click('#mcancel');
  ok(true, 'cannot invite the same email twice');
  await page.click('tr:has-text("sam@x.com") .u-resend'); await page.waitForSelector('.toast >> text=New invite emailed'); ok(true, 'resend invite');
  const ownerRow = 'tr:has-text("hello@soustap.com")';
  ok(await page.isDisabled(`${ownerRow} .u-mgr`) && !(await page.isVisible(`${ownerRow} .u-remove`)) && !(await page.isVisible(`${ownerRow} .u-toggle`)), 'owner account cannot be demoted, disabled or removed');
  await page.click('tr:has-text("tom@x.com") .u-toggle'); await page.waitForSelector('tr:has-text("tom@x.com") >> text=Disabled'); ok(true, 'disable a person');
  await page.click('tr:has-text("tom@x.com") .u-remove'); await page.click('tr:has-text("tom@x.com") .u-remove');
  await page.waitForSelector('.toast >> text=Tom Temp removed'); await page.waitForTimeout(300); ok(!(await page.isVisible('tr:has-text("tom@x.com")')), 'remove a person');
  await shot('03-team');

  // ---- tickets
  await nav('Contacts'); await page.click('text=+ Contact'); await page.fill('#modal input[name=fullName]', 'Jane Doe'); await page.click('#msave'); await page.waitForSelector('td >> text=Jane Doe');
  await nav('Sales'); await page.click('text=+ New deal');
  await page.fill('#modal input[name=title]', 'Website rebuild'); await page.selectOption('#modal select[name=contactId]', { label: 'Jane Doe' }); await page.fill('#modal input[name=value]', '12000');
  await page.selectOption('#modal select[name=assigneeId]', { label: 'Sam Sales' }); await page.click('#msave'); await page.waitForSelector('#drawer.on >> text=SAL-1001');
  await page.click('#dclose'); await page.waitForTimeout(250);
  await nav('IT Support'); await page.click('text=+ New ticket');
  await page.fill('#modal input[name=title]', "Laptop won't boot"); await page.selectOption('#modal select[name=contactId]', { label: 'Jane Doe' }); await page.selectOption('#modal select[name=assigneeId]', { label: 'Ian IT' }); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=IT-1001'); await page.click('#dclose'); await page.waitForTimeout(250);
  ok(true, 'manager created and assigned tickets in Sales and IT');

  // ---- Sales CRM: tabs, leads, tasks, convert
  await nav('Sales');
  ok(await page.isVisible('.tabs >> text=Deals') && await page.isVisible('.tabs >> text=Leads') && await page.isVisible('.tabs >> text=Activities & tasks') && !(await page.isVisible('.tabs >> text=Assets')), 'Sales department is a Sales CRM (Deals, Leads, Activities & tasks)');
  await page.click('.tabs >> text=Leads'); await page.click('text=+ New lead');
  await page.fill('#modal input[name=fullName]', 'Maya Ross'); await page.fill('#modal input[name=companyName]', 'Cedar Cafe'); await page.fill('#modal input[name=email]', 'maya@cedar.test');
  await page.fill('#modal input[name=source]', 'Website'); await page.click('#msave'); await page.waitForSelector('#drawer.on >> text=Convert to deal');
  await page.click('#addtask'); await page.fill('#modal input[name=title]', 'Call Maya about tills'); await page.click('#msave');
  await page.waitForSelector('#drawer .task >> text=Call Maya about tills'); ok(true, 'lead created, with a task');
  await page.selectOption('#lstatus', 'contacted'); await page.waitForSelector('.toast >> text=Lead updated');
  await page.click('#lconvert'); await page.fill('#modal input[name=value]', '4800'); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=SAL-1002'); await page.waitForSelector('#drawer >> text=Converted from lead Maya Ross');
  ok(await page.isVisible('#drawer .task >> text=Call Maya about tills') && await page.isVisible('#drawer >> text=Cedar Cafe'), 'convert: deal created with the company, contact and the lead\'s task');
  await shot('06-deal-from-lead');
  await page.check('#drawer .task:has-text("Call Maya") .tdone'); await page.waitForSelector('#drawer >> text=Done: Call: Call Maya about tills');
  ok(true, 'ticking a task done logs it on the deal');
  await page.click('#dclose'); await page.waitForTimeout(250);
  await page.selectOption('#f-lstatus', ''); await page.waitForTimeout(150);
  ok(await page.isVisible('tr:has-text("Maya Ross") >> text=Converted to deal'), 'lead shows as converted');
  await page.click('.tabs >> text=Activities & tasks'); await page.click('text=+ New task');
  await page.fill('#modal input[name=title]', 'Send menu builder demo'); await page.selectOption('#modal select[name=kind]', 'email'); await page.click('#msave');
  await page.waitForSelector('.task >> text=Send menu builder demo'); await shot('07-tasks');
  await nav('Contacts'); ok(await page.isVisible('td >> text=Maya Ross'), 'converted lead is now a shared contact');

  // ---- IT support CRM: assets, ticket for a device, knowledge base
  await nav('IT Support');
  ok(await page.isVisible('.tabs >> text=Tickets') && await page.isVisible('.tabs >> text=Assets') && await page.isVisible('.tabs >> text=Knowledge base') && !(await page.isVisible('.tabs >> text=Leads')), 'IT department is a Support CRM (Tickets, Assets, Knowledge base)');
  await page.click('.tabs >> text=Assets'); await page.click('text=+ New asset');
  await page.fill('#modal input[name=name]', 'Front till'); await page.selectOption('#modal select[name=type]', 'Till / POS'); await page.selectOption('#modal select[name=companyId]', { label: 'Cedar Cafe' });
  await page.fill('#modal input[name=serial]', 'SN-4471'); await page.fill('#modal input[name=warrantyUntil]', '2025-01-31'); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=SN-4471'); ok(await page.isVisible('#drawer .overdue >> text=Ended'), 'asset saved; expired warranty flagged');
  await page.click('#anewticket'); await page.fill('#modal input[name=title]', 'Till screen frozen'); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=Till screen frozen'); ok(await page.isVisible('#drawer a >> text=Front till'), 'ticket raised from the asset is linked to it');
  await page.click('#dclose'); await page.waitForTimeout(250);
  await page.click('.tabs >> text=Knowledge base'); await page.click('text=+ New article');
  await page.fill('#modal input[name=title]', 'Receipt printer prints blank'); await page.fill('#modal input[name=tags]', 'printer, paper');
  await page.fill('#modal textarea[name=body]', '1. Open the printer\n2. Turn the paper roll over (shiny side down)\n3. Close and print a test'); await page.click('#msave');
  await page.waitForSelector('#drawer.on .article'); await page.click('#dclose'); await page.waitForTimeout(250);
  await page.click('.tabs >> text=Tickets'); await page.click('text=+ New ticket'); await page.fill('#modal input[name=title]', 'Printer giving blank receipts'); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=Might help'); ok(await page.isVisible('#drawer .linked >> text=Receipt printer prints blank'), 'ticket suggests the matching knowledge base article');
  await shot('08-ticket-suggestion'); await page.click('#dclose'); await page.waitForTimeout(250);
  await page.click('.tabs >> text=Assets'); await page.waitForSelector('th >> text=Serial'); await shot('09-assets');
  await page.click('.tabs >> text=Tickets'); await page.waitForTimeout(150);

  // ---- bulk delete (manager)
  const mkIT = async title => { await page.click('text=+ New ticket'); await page.fill('#modal input[name=title]', title); await page.click('#msave'); await page.waitForSelector(`#drawer.on >> text=${title}`); };
  await mkIT('Old ticket A'); await page.selectOption('#tstatus', 'resolved'); await page.waitForSelector('#drawer >> text=Status: Open → Resolved'); await page.click('#dclose'); await page.waitForTimeout(250);
  await mkIT('Old ticket B'); await page.selectOption('#tstatus', 'closed'); await page.waitForSelector('#drawer >> text=Status: Open → Closed'); await page.click('#dclose'); await page.waitForTimeout(250);
  await mkIT('Still open C'); await page.click('#dclose'); await page.waitForTimeout(250);
  await page.selectOption('#f-age', '0'); await page.waitForTimeout(200);
  const shown = await page.$$eval('tbody tr', rs => rs.map(r => r.innerText));
  ok(shown.length === 2 && shown.every(t => /Old ticket/.test(t)), 'age filter shows only resolved/closed tickets');
  await page.check('.sel-all'); await page.waitForSelector('#bulkbar >> text=2 selected');
  await shot('03b-bulk');
  await page.click('#bulkdel'); await page.waitForSelector('#bulkdel >> text=Click again'); await page.click('#bulkdel');
  await page.waitForSelector('.toast >> text=Deleted 2 tickets'); await page.selectOption('#f-age', ''); await page.waitForTimeout(200);
  ok(!(await page.isVisible('td >> text=Old ticket')) && await page.isVisible('td >> text=Still open C') && await page.isVisible("td >> text=Laptop won't boot"), 'bulk delete removed only the selected tickets');
  await page.click('td >> text=Still open C'); await page.waitForSelector('#drawer.on'); await page.click('#ddel'); await page.click('#ddel'); await page.waitForSelector('.toast >> text=Deleted');
  await nav('Sales'); await page.click('text=+ New deal'); await page.fill('#modal input[name=title]', 'Lost deal'); await page.selectOption('#modal select[name=stage]', 'lost'); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=SAL-1003'); await page.click('#dclose'); await page.waitForTimeout(250);
  await page.check('.card:has-text("Lost deal") .sel'); await page.waitForSelector('#bulkbar >> text=1 selected');
  await page.click('#bulkdel'); await page.click('#bulkdel'); await page.waitForSelector('.toast >> text=Deleted 1 ticket');
  ok(!(await page.isVisible('.card:has-text("Lost deal")')) && await page.isVisible('.card:has-text("Website rebuild")'), 'bulk delete from the pipeline board');

  // ---- owner signs in again: password + authenticator code
  await signOutIfIn(); await password(OWNER, OWNER_PW); await page.waitForSelector('text=Two-step verification');
  ok(true, 'owner: second sign-in asks for authenticator code');
  await shot('04-totp');
  await page.fill('input[name=code]', '111111'); await page.click('#asub'); await page.waitForSelector(".msg.err >> text=isn't right");
  await page.fill('input[name=code]', '123456'); await page.click('#asub'); await page.waitForSelector('.shell'); ok(true, 'owner: correct code lets them in');

  // ---- SAM first sign-in
  await signOutIfIn(); await firstLogin('sam@x.com', 'SamPass123!'); await page.waitForSelector('.shell');
  ok(true, 'Sam: temporary password → own password → straight in (2-step optional for members)');
  ok(await page.isVisible('nav >> text="Sales"') && !(await page.isVisible('nav >> text="IT Support"')) && !(await page.isVisible('nav >> text="Team & access"')), 'Sam: only Sales, no Manage section');
  const samView = await api(async c => (await c.models.Ticket.list()).data.map(x => x.refCode).join(','));
  ok(samView === 'SAL-1001,SAL-1002', 'Sam: API returns only Sales tickets (got ' + samView + ')');
  const samOther = await api(async c => [(await c.models.Asset.list()).data.length, (await c.models.Article.list()).data.length, (await c.models.Lead.list()).data.length, (await c.models.SalesTask.list()).data.length].join(','));
  ok(samOther === '0,0,1,2', 'Sam: sees Sales leads and tasks, but no IT assets or articles (got ' + samOther + ')');
  const samLeadDel = await api(async c => { const l = (await c.models.Lead.list()).data[0]; return (await c.models.Lead.delete({ id: l.id })).errors?.[0]?.errorType; });
  ok(samLeadDel === 'Unauthorized', 'Sam: API refuses deleting a lead (only managers delete)');
  await nav('Sales'); await page.click('.tabs >> text=Leads'); await page.selectOption('#f-lstatus', ''); await page.click('tr:has-text("Maya Ross")'); await page.waitForSelector('#drawer.on');
  ok(!(await page.isVisible('#ddel')), 'Sam: no Delete button on a lead'); await page.click('#dclose'); await page.waitForTimeout(250);
  await nav('Sales'); ok((await page.$$('.sel, .sel-all')).length === 0, 'Sam: no bulk-delete checkboxes for members');
  const samDel = await api(async c => { const t = (await c.models.Ticket.list()).data[0]; return (await c.models.Ticket.delete({ id: t.id })).errors?.[0]?.errorType; });
  ok(samDel === 'Unauthorized', 'Sam: API refuses ticket deletion by members');
  const samAdmin = await api(async c => (await c.queries.listStaff()).errors?.[0]?.errorType);
  ok(samAdmin === 'Unauthorized', 'Sam: cannot call team admin');
  await page.click('#editme'); await page.waitForSelector('#modal.on >> text=Two-step verification');
  await page.click('#mextra'); await page.waitForSelector('text=Set up two-step verification');
  ok(await page.isVisible('#later'), 'Sam: can choose to set up 2-step (optional)');
  await page.fill('input[name=code]', '123456'); await page.click('#asub'); await page.waitForSelector('.shell');
  await login('sam@x.com', 'SamPass123!', true); ok(true, 'Sam: after turning it on, sign-in asks for a code');

  // ---- IAN
  await signOutIfIn(); await firstLogin('ian@x.com', 'IanPass123!'); await page.waitForSelector('.shell');
  ok(await page.isVisible('nav >> text="IT Support"') && await page.isVisible('nav >> text="Accounts"') && !(await page.isVisible('nav >> text="Sales"')), 'Ian: IT Support + Accounts only');
  const ianView = await api(async c => [(await c.models.Lead.list()).data.length, (await c.models.SalesTask.list()).data.length, (await c.models.Asset.list()).data.length, (await c.models.Article.list()).data.length].join(','));
  ok(ianView === '0,0,1,1', 'Ian: sees IT assets and articles, no Sales leads or tasks (got ' + ianView + ')');
  const ianEdit = await api(async c => { const a = (await c.models.Asset.list()).data[0]; const u = await c.models.Asset.update({ id: a.id, site: 'Bar area' }); const d = await c.models.Asset.delete({ id: a.id }); return [u.data?.site, d.errors?.[0]?.errorType].join(','); });
  ok(ianEdit === 'Bar area,Unauthorized', 'Ian: can edit an asset but not delete it');
  await nav('My tickets'); ok(await page.isVisible("td >> text=Laptop won't boot"), 'Ian: assigned ticket in My tickets');

  // ---- manager disables Ian -> Ian blocked
  await login(OWNER, OWNER_PW, true); await page.goto(BASE + '#team'); await page.waitForSelector('tr:has-text("ian@x.com")');
  ok(await page.isVisible('tr:has-text("ian@x.com") >> text=Active'), 'Ian now shows as Active');
  await page.click('tr:has-text("ian@x.com") .u-toggle'); await page.waitForSelector('tr:has-text("ian@x.com") >> text=Disabled');
  await password('ian@x.com', 'IanPass123!'); await page.waitForSelector('.msg.err >> text=disabled');
  ok(true, 'disabled person cannot sign in');
  await shot('05-disabled');

  ok(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
