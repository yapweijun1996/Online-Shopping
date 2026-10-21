const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || '/Users/yapweijun/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs');
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const out=process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out')+1] : '/tmp/platform-ui-shots'; await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}); const context=await browser.newContext({storageState:process.env.QA_PLATFORM_STATE || '/tmp/platform-ui-state.json',viewport:{width:1280,height:800}}); const page=await context.newPage(); const errors=[], checks=[], shots=[]; page.on('pageerror',e=>errors.push(e.message));
const shot=async name=>{await page.waitForTimeout(220);await writeFile(`${out}/${name}.png`,await page.screenshot()); shots.push(name+'.png');};
const home=async()=>{await page.goto('http://localhost:55413/platform/'); await page.locator('.data-table tbody tr').first().waitFor();};
const nav=async name=>{if(await page.getByRole('button',{name:'Open navigation',exact:true}).isVisible())await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.locator('#navigation').getByRole('button',{name,exact:true}).click();await page.locator('.data-table tbody tr').first().waitFor();};
await home();
const response=await context.request.get('http://localhost:55413/api/v1/platform/shops');const all=await response.json();assert.equal(all.items.length,61);
for(const width of [390,1280]) for(const theme of ['light','dark']){
 await page.setViewportSize({width,height:width===390?844:800});await page.emulateMedia({colorScheme:theme});await home(); const prefix=`${width}-${theme}`;
 await shot(`${prefix}-shops-60-first`);
 await page.getByRole('button',{name:'2',exact:true}).click(); await shot(`${prefix}-shops-60-middle`);
 await page.getByRole('button',{name:'3',exact:true}).click(); await shot(`${prefix}-shops-60-last`);
 await page.getByRole('searchbox').fill('North');await page.waitForTimeout(250);assert.match(await page.locator('.panel>p').first().textContent(),/20 of 61/);await shot(`${prefix}-search-results`);
 await page.getByRole('searchbox').fill('no-such-shop');await page.waitForTimeout(250);assert.equal(await page.locator('tbody tr').count(),0);await shot(`${prefix}-search-empty`);
 await page.getByRole('button',{name:'Reset filters'}).click();
 for(const key of ['name','code','status','currency','createdAt']){
  const control=page.locator(`[data-sort="${key}"]`);await control.click();assert.equal(await control.locator('..').getAttribute('aria-sort'),'ascending');await shot(`${prefix}-sort-${key}`);await control.click();assert.equal(await control.locator('..').getAttribute('aria-sort'),'descending');await control.click();assert.equal(await control.locator('..').getAttribute('aria-sort'),'none');
 }
 await page.getByLabel('Status filter',{exact:true}).selectOption('ACTIVE');assert.equal(await page.locator('tbody .status-suspended').count(),0);await shot(`${prefix}-status-active`);
 await page.getByLabel('Status filter',{exact:true}).selectOption('');
 for(const count of ['10','25','50','100']){await page.getByLabel('Rows per page',{exact:true}).selectOption(count);assert.equal(await page.locator('tbody tr').count(),Math.min(Number(count),61));assert.equal(await page.locator('.table-output').evaluate(node=>getComputedStyle(node).maxHeight),'none');await shot(`${prefix}-rows-${count}`);}
 await nav('Activity');await shot(`${prefix}-activity-first`); await page.getByRole('button',{name:'Next',exact:true}).click();await shot(`${prefix}-activity-last`);
 await page.getByRole('searchbox').fill('tenant');await page.waitForTimeout(250);await shot(`${prefix}-activity-search`);
 await page.route('**/api/v1/platform/shops',route=>route.fulfill({json:{items:all.items.slice(0,3)}}));await home();await shot(`${prefix}-shops-3`);await page.unroute('**/api/v1/platform/shops');
 let release; const gate=new Promise(resolve=>release=resolve);await page.route('**/api/v1/platform/shops',async route=>{await gate;await route.continue();});await page.goto('http://localhost:55413/platform/');await page.locator('.skeleton').waitFor();await shot(`${prefix}-loading`);release();await page.locator('tbody tr').first().waitFor();await page.unroute('**/api/v1/platform/shops');
 await page.route('**/api/v1/platform/shops',route=>route.fulfill({status:503,json:{error:{message:'Fixture service unavailable'}}}));await page.reload();await page.getByRole('button',{name:'Retry',exact:true}).waitFor();await shot(`${prefix}-error`);await page.unroute('**/api/v1/platform/shops');await page.getByRole('button',{name:'Retry',exact:true}).click();await page.locator('tbody tr').first().waitFor();
 checks.push(`${prefix}: pagination/search/sort/filter/row count/retry PASS`);
 await page.locator('tbody button').filter({hasText:'Manage'}).first().click();await shot(`${prefix}-shop-detail`);
 for (const name of ['Add shop','Account']) {
   if (width < 1024) await page.getByRole('button',{name:'Open navigation',exact:true}).click();
   await page.locator('#navigation').getByRole('button',{name,exact:true}).click();
   await shot(`${prefix}-${name.toLowerCase().replaceAll(' ','-')}`);
 }
 const anonymous=await browser.newContext({viewport:{width,height:width===390?844:800},colorScheme:theme});
 const signIn=await anonymous.newPage();await signIn.goto('http://localhost:55413/platform/');await signIn.locator('[name=username]').waitFor();
 await signIn.screenshot({path:`${out}/${prefix}-sign-in.png`});shots.push(`${prefix}-sign-in.png`);await anonymous.close();
}
await page.setViewportSize({width:360,height:800});await home();
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);checks.push('360px horizontal overflow: NONE');
const unnamed=await page.locator('button,input,select,a[href]').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length&&!n.closest('[hidden]')).filter(n=>!(n.getAttribute('aria-label')||n.textContent.trim()||n.labels?.length||n.getAttribute('title'))).map(n=>n.outerHTML));assert.deepEqual(unnamed,[]);checks.push('Visible controls without accessible names: 0');
await page.locator('[data-sort=name]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('[data-sort=name]').locator('..').getAttribute('aria-sort'),'ascending');await page.keyboard.press('Space');assert.equal(await page.locator('[data-sort=name]').locator('..').getAttribute('aria-sort'),'descending');
await page.getByRole('searchbox').focus();await page.keyboard.type('North');await page.waitForTimeout(250);assert.equal(await page.locator('tbody tr').count(),20);await page.keyboard.press('ControlOrMeta+A');await page.keyboard.press('Backspace');await page.waitForTimeout(250);
await page.getByRole('button',{name:'Next',exact:true}).focus();await page.keyboard.press('Enter');assert.match(await page.locator('.panel [role=status]').textContent(),/26-50/);
await page.locator('tbody button').filter({hasText:'Manage'}).first().focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Rename shop',exact:true}).waitFor();checks.push('Keyboard Enter/Space sort, typing search, Enter paging and Manage: PASS');
await page.keyboard.press('Tab');checks.push('Keyboard Tab navigation: exercised');
for(const width of [390,1280]){await page.setViewportSize({width,height:width===390?844:800});await home();if(width===1280){await page.getByRole('button',{name:'Collapse navigation',exact:true}).click();await shot('iteration2-sidebar-collapsed');await page.getByRole('button',{name:'Expand navigation',exact:true}).click();}else{await page.getByRole('button',{name:'Open navigation',exact:true}).click();await shot('iteration2-mobile-drawer');await page.getByRole('button',{name:'Close navigation',exact:true}).click();}await page.locator('#account-button').click();await shot(`iteration2-${width}-account-menu`);}
// The reference seller is the default shop in the same isolated rig.
await page.goto('http://127.0.0.1:55413/seller/');await shot('seller-sign-in');await page.locator('#username').fill('rootowner');await page.locator('#password').fill((await readFile(process.env.QA_SELLER_PASSWORD_FILE || '/tmp/platform-ui-owner','utf8')).trim());await page.locator('#login-submit').click();await page.locator('#workspace').waitFor();
for(const width of [390,1280])for(const theme of ['light','dark']){await page.setViewportSize({width,height:width===390?844:800});await page.emulateMedia({colorScheme:theme});await shot(`${width}-${theme}-seller-reference`);}
const { default: sharp } = await import('sharp');
for (const width of [390,1280]) for (const theme of ['light','dark']) {
  const height = width === 390 ? 844 : 800;
  await sharp({create:{width:width*2,height,channels:3,background:'#ffffff'}}).composite([
    {input:`${out}/${width}-${theme}-seller-reference.png`,left:0,top:0},
    {input:`${out}/${width}-${theme}-shops-60-first.png`,left:width,top:0}
  ]).png().toFile(`${out}/compare-${width}-${theme}.png`);
}
assert.deepEqual(errors,[]);checks.push('Browser uncaught errors: 0');
await writeFile(`${out}/verification.json`,JSON.stringify({checks,shots},null,2));console.log(checks.join('\n'));console.log(`Screenshots: ${shots.length}`);await browser.close();
