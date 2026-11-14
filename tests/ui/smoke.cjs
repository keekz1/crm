const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:8765/';
(async () => {
  fs.mkdirSync(__dirname + '/screenshots', { recursive: true });
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.route('**/supabase-js@2/+esm', r => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(__dirname + '/fake-supabase.mjs', 'utf8') }));
  await ctx.route('**/js/config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'window.CRM_CONFIG={SUPABASE_URL:"https://fake.supabase.co",SUPABASE_ANON_KEY:"x",COMPANY_NAME:"CoreCRM"}' }));
  await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ body: '' }));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) process.exitCode = 1; };
  const login = async (email) => {
    await page.evaluate(() => sessionStorage.removeItem('fake-session'));
    await page.goto(BASE); await page.waitForSelector('#af');
    await page.fill('input[name=email]', email); await page.fill('input[name=password]', 'password123'); await page.click('#asub');
  };

  await page.goto(BASE); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForSelector('#af');
  ok(await page.isVisible('text=Sign in to your workspace'), 'login screen renders');
  await page.fill('input[name=email]', 'sales@x.com'); await page.fill('input[name=password]', 'wrongpass1'); await page.click('#asub');
  await page.waitForSelector('.msg.err'); ok(true, 'bad password shows error');
  await page.screenshot({ path: __dirname + '/screenshots/01-login.png' });

  // ADMIN: create company, contact, deal, ticket
  await login('admin@x.com'); await page.waitForSelector('.shell');
  ok(await page.isVisible('nav >> text=Sales pipeline') && await page.isVisible('nav >> text=IT Support') && await page.isVisible('nav >> text=Users & roles'), 'admin sees all sections');
  await page.click('nav >> text=Companies'); await page.click('text=+ Company');
  await page.fill('#modal input[name=name]', 'Acme Ltd'); await page.click('#msave');
  await page.waitForSelector('td >> text=Acme Ltd'); ok(true, 'company created');
  await page.click('nav >> text=Contacts'); await page.click('text=+ Contact');
  await page.fill('#modal input[name=full_name]', 'Jane Doe'); await page.selectOption('#modal select[name=company_id]', { label: 'Acme Ltd' }); await page.fill('#modal input[name=email]', 'jane@acme.com'); await page.click('#msave');
  await page.waitForSelector('td >> text=Jane Doe'); ok(true, 'contact created');

  await page.click('nav >> text=Sales pipeline'); await page.click('text=+ Sales ticket');
  await page.fill('#modal input[name=title]', 'Website rebuild'); await page.selectOption('#modal select[name=contact_id]', { label: 'Jane Doe · Acme Ltd' }); await page.fill('#modal input[name=value]', '12000'); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=SAL-1001'); ok(true, 'deal created as SAL-1001 and drawer opened');
  ok(await page.isVisible('#drawer >> a:has-text("Acme Ltd")'), 'company auto-filled from contact');
  await page.selectOption('#dstage', 'proposal'); await page.waitForSelector('#drawer >> text=Stage: new → proposal'); ok(true, 'stage change logged in activity');
  await page.selectOption('#nk', 'call'); await page.fill('#nt', 'Called Jane, keen to proceed'); await page.click('#addn');
  await page.waitForSelector('#drawer >> text=Called Jane, keen to proceed'); ok(true, 'note added');
  await page.click('#dclose');
  ok(await page.isVisible('.col[data-stage=proposal] >> text=Website rebuild'), 'deal sits in Proposal column');
  // drag to Won
  await page.dragAndDrop('.card:has-text("Website rebuild")', '.col[data-stage=won]');
  await page.waitForSelector('.col[data-stage=won] >> text=Website rebuild'); ok(true, 'drag & drop moved deal to Won');
  await page.screenshot({ path: __dirname + '/screenshots/02-pipeline.png' });

  await page.click('nav >> text=IT Support'); await page.click('text=+ IT ticket');
  await page.fill('#modal input[name=subject]', 'Printer jammed'); await page.selectOption('#modal select[name=contact_id]', NEW = '__new');
  ok(await page.isVisible('#modal input[name=new_contact]'), 'new-contact fields appear');
  await page.fill('#modal input[name=new_contact]', 'Bob Smith'); await page.selectOption('#modal select[name=priority]', 'urgent'); await page.click('#msave');
  await page.waitForSelector('#drawer.on >> text=IT-1001'); ok(true, 'ticket created as IT-1001 with inline contact');
  await page.selectOption('#tassign', { label: 'Ian IT' }); await page.selectOption('#tstatus', 'in_progress');
  await page.waitForSelector('#drawer >> text=Status: open → in_progress'); ok(true, 'ticket status logged');
  await page.click('#dclose');
  ok(await page.isVisible('td >> text=Printer jammed'), 'ticket in queue');
  await page.screenshot({ path: __dirname + '/screenshots/03-queue.png' });
  await page.click('nav >> text=Dashboard'); await page.waitForSelector('text=Open pipeline');
  await page.screenshot({ path: __dirname + '/screenshots/04-dashboard-admin.png' });
  await page.click('nav >> text=Users & roles'); await page.waitForSelector('text=Nina New');
  await page.selectOption('select[data-role=u-new]', 'it'); await page.waitForSelector('.toast >> text=is now IT Support'); ok(true, 'admin can change roles');
  await page.screenshot({ path: __dirname + '/screenshots/05-users.png' });
  await page.click('#signout'); await page.waitForSelector('#af'); ok(true, 'sign out works');

  // SALES: must not see tickets
  await login('sales@x.com'); await page.waitForSelector('.shell');
  ok(!(await page.isVisible('nav >> text=IT Support')), 'sales: no IT Support in nav');
  ok(!(await page.isVisible('nav >> text=Users & roles')), 'sales: no admin section');
  ok(!(await page.isVisible('text=Past SLA')), 'sales: dashboard has no IT stats');
  await page.goto(BASE + '#queue'); await page.waitForSelector('.shell'); await page.waitForTimeout(300);
  ok(await page.isVisible('text=Open pipeline') && !(await page.isVisible('text=IT Support queue')), 'sales: #queue URL falls back to dashboard');
  await page.click('nav >> text=Contacts'); await page.click('td >> text=Bob Smith');
  ok(!(await page.isVisible('#drawer >> text=IT tickets')) && !(await page.isVisible('#drawer >> text=Printer jammed')), 'sales: contact drawer shows no IT tickets');
  await page.click('#dclose');
  await page.screenshot({ path: __dirname + '/screenshots/06-sales-contacts.png' });

  // IT: must not see deals
  await login('it@x.com'); await page.waitForSelector('.shell');
  ok(!(await page.isVisible('nav >> text=Sales pipeline')), 'IT: no Sales pipeline in nav');
  ok(!(await page.isVisible('text=Open pipeline')), 'IT: dashboard has no sales stats');
  await page.click('nav >> text=Companies'); await page.click('td >> text=Acme Ltd');
  ok(!(await page.isVisible('#drawer >> text=Website rebuild')), 'IT: company drawer hides deals');
  await page.click('#dclose');
  await page.click('nav >> text=Dashboard'); await page.waitForSelector('text=Assigned to me');
  ok(await page.isVisible('text=Printer jammed'), 'IT: assigned ticket shows on dashboard');
  await page.screenshot({ path: __dirname + '/screenshots/07-it-dashboard.png' });

  // PENDING
  await login('new@x.com'); await page.waitForTimeout(400);
  ok(await page.isVisible('.shell'), 'promoted user (now IT) gets in');

  ok(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
