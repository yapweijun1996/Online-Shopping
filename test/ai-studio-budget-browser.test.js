import test from 'node:test';
import assert from 'node:assert/strict';
import { sellerFixture } from './helpers/seller-app.js';
import { reserve,settle } from '../src/ai-studio/usage.js';
import { recordUsage } from '../src/ai-studio/budget.js';
const modulePath=process.env.QA_PLAYWRIGHT_MODULE;
for(const width of [390,1440])test(`Owner budget dashboard renders and saves at ${width}px`,{skip:!modulePath},async t=>{
 const {chromium}=await import(modulePath);const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const f=await sellerFixture();t.after(()=>f.close());
 const [id,unknown]=await reserve(f.app.database,['ANALYZE','IMAGE'],'review_owner');await recordUsage(f.app.database,id,{model:'gpt-6-astra',usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:0}}});await settle(f.app.database,id,'OK');await settle(f.app.database,unknown,'AMBIGUOUS');
 const page=await browser.newPage({viewport:{width,height:960},serviceWorkers:'block',reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();await page.goto(f.origin+'/seller/#aistudio/tab/budget');await page.locator('.ai-budget-table').first().waitFor();
 assert.equal(await page.locator('.ai-budget-metric').count(),2);assert.match(await page.locator('.ai-budget').textContent(),/Unknown cost/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.locator('input[name=dailyBudget]').fill('12.50');await page.locator('input[name=monthlyBudget]').fill('100');await page.locator('select[name=budgetMode]').selectOption('BLOCK');
 let release;const gate=new Promise(resolve=>{release=resolve});let started;const intercepted=new Promise(resolve=>{started=resolve});await page.route('**/api/v1/seller/ai-studio/budget',async route=>{started();await gate;await route.continue()});
 await page.getByRole('button',{name:'Save budget',exact:true}).click();await intercepted;assert.equal(await page.locator('input[name=dailyBudget]').isDisabled(),true);assert.equal(await page.locator('select[name=budgetMode]').isDisabled(),true);release();
 await page.getByText('Budget saved.',{exact:true}).waitFor();assert.equal(await page.locator('input[name=dailyBudget]').isEnabled(),true);
 assert.match(await page.evaluate(async()=>{const {usd}=await import('/seller/budget-ui.js');return usd(1)}),/0\.000001/);assert.equal((await f.app.database.get('SELECT daily_microusd FROM ai_studio_budget')).daily_microusd,12500000);
 for(const palette of ['evergreen-teal','ocean-blue','warm-plum','navy-orange','high-contrast','graphite']){await page.evaluate(p=>window.sellerPalette.choose(p),palette);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)}
 await page.evaluate(()=>scrollTo(0,0)); await page.waitForTimeout(500);
 await page.screenshot({path:`/private/tmp/ai-budget-dashboard-${width}.png`,fullPage:true});assert.deepEqual(errors,[]);
 await page.reload();await page.locator('input[name=dailyBudget]').waitFor();await page.waitForFunction(()=>document.querySelector('input[name=dailyBudget]')?.value==='12.5');
});

test('Owner budget draft retains its revision when analytics refreshes', {skip:!modulePath}, async t=>{
 const {chromium}=await import(modulePath);const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const f=await sellerFixture();t.after(()=>f.close());const page=await browser.newPage({serviceWorkers:'block'});await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();await page.goto(f.origin+'/seller/#aistudio/tab/budget');await page.waitForFunction(()=>document.querySelector('select[name=budgetMode]')?.value==='WARN');await page.fill('input[name=dailyBudget]','12');
 const {saveBudget}=await import('../src/ai-studio/budget.js');await saveBudget(f.app.database,{dailyMicrousd:20000000,monthlyMicrousd:null,mode:'WARN',alertPercent:80,expectedRevision:1},'other_owner');await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForTimeout(200);assert.equal(await page.inputValue('input[name=dailyBudget]'),'12');await page.getByRole('button',{name:'Save budget',exact:true}).click();await page.getByText('This changed somewhere else. Reload the page.',{exact:true}).waitFor();assert.equal((await f.app.database.get('SELECT daily_microusd FROM ai_studio_budget')).daily_microusd,20000000);
});

test('Unknown-only usage stays unknown in the Studio summary and budget metrics', {skip:!modulePath}, async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const f=await sellerFixture();t.after(()=>f.close());
 const [id]=await reserve(f.app.database,['IMAGE'],'review_owner');await settle(f.app.database,id,'AMBIGUOUS');
 const page=await browser.newPage({serviceWorkers:'block'});
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();
 await page.goto(f.origin+'/seller/#aistudio/tab/budget');await page.locator('.ai-budget-metric').first().waitFor();
 await page.waitForFunction(()=>document.querySelector('.ai-studio-summary')?.textContent.includes('Unknown cost'));
 const summary=await page.locator('.ai-studio-summary').innerText();assert.match(summary,/Today: Unknown cost/);assert.match(summary,/This month: Unknown cost/);assert.doesNotMatch(summary,/\$0\.00/);
 assert.match(await page.locator('.ai-budget-metric>strong').first().innerText(),/Unknown cost/);
});

test('analytics failure disables pagination and refresh recovers without a page error',{skip:!modulePath},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const f=await sellerFixture();t.after(()=>f.close());const page=await browser.newPage({serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();
 await page.route('**/api/v1/seller/ai-studio/analytics?*',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":{"code":"UNAVAILABLE"}}'}));
 await page.goto(f.origin+'/seller/#aistudio/tab/budget');await page.locator('.ai-budget>p[role=status]').filter({hasText:/./}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Previous',exact:true}).isDisabled(),true);
 await page.unroute('**/api/v1/seller/ai-studio/analytics?*');await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.locator('.ai-budget-metric').first().waitFor();assert.deepEqual(errors,[]);
});
