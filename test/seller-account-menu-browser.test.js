import test from 'node:test';
import assert from 'node:assert/strict';
import {sellerFixture} from './helpers/seller-app.js';
const modulePath=process.env.QA_PLAYWRIGHT_MODULE;
test('seller account menu fits labels on one line and remains inside the viewport',{skip:!modulePath,timeout:45000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const f=await sellerFixture();t.after(()=>f.close());
 const page=await browser.newPage({viewport:{width:1440,height:800},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();
 for(const width of [280,320,375,580,1440]){
  await page.setViewportSize({width,height:800});await page.locator('#account-button').click();const menu=page.locator('#account-menu');assert.equal(await menu.isVisible(),true);
  const metrics=await menu.evaluate(e=>{const rect=e.getBoundingClientRect();return {left:rect.left,right:rect.right,viewport:innerWidth,items:[...e.querySelectorAll('button')].filter(b=>!b.hidden).map(b=>({text:b.textContent,whiteSpace:getComputedStyle(b).whiteSpace,client:b.clientWidth,scroll:b.scrollWidth}))};});
  assert.ok(metrics.left>=0&&metrics.right<=width,JSON.stringify(metrics));assert.ok(metrics.items.every(x=>x.whiteSpace==='nowrap'),JSON.stringify(metrics));assert.ok(metrics.items.every(x=>x.scroll<=x.client+1),JSON.stringify(metrics));
  await page.keyboard.press('Escape');assert.equal(await page.locator('#account-button').getAttribute('aria-expanded'),'false');
 }
 await page.setViewportSize({width:1440,height:800});await page.locator('#account-button').click();
 const sized=await page.locator('#account-menu').evaluate(e=>{const status=e.querySelector('#check-updates-status');status.textContent='';const before=e.getBoundingClientRect().width;status.textContent='A long synthetic update error must wrap without expanding the account menu across the page.';return {before,after:e.getBoundingClientRect().width,statusWidth:status.getBoundingClientRect().width,statusHeight:status.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(status).lineHeight)};});
 assert.ok(Math.abs(sized.before-sized.after)<1,JSON.stringify(sized));assert.ok(sized.statusHeight>sized.lineHeight,JSON.stringify(sized));await page.keyboard.press('Escape');
 await page.setViewportSize({width:280,height:800});await page.locator('#account-button').click();
 for(const width of [280,320,375]) for(const code of ['en','ms','zh-Hans','vi','th','ja','ko']){
  await page.setViewportSize({width,height:800});await page.evaluate(async value=>{const {setLocale}=await import('/shared/i18n.js');setLocale(value);},code);
  const state=await page.locator('#account-menu').evaluate(e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right,viewport:innerWidth,actions:[...e.querySelectorAll('button')].filter(b=>!b.hidden).map(b=>({text:b.textContent,whiteSpace:getComputedStyle(b).whiteSpace,client:b.clientWidth,scroll:b.scrollWidth,font:parseFloat(getComputedStyle(b).fontSize)}))}));
  assert.ok(state.left>=0&&state.right<=state.viewport,`${width} ${code}: ${JSON.stringify(state)}`);assert.ok(state.actions.every(a=>a.text&&a.whiteSpace==='nowrap'&&a.scroll<=a.client+1&&a.font>=13&&a.font<=16),`${width} ${code}: ${JSON.stringify(state)}`);
 }
 assert.deepEqual(errors,[]);
});
