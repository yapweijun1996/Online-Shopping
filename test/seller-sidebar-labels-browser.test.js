import test from 'node:test';
import assert from 'node:assert/strict';
import {sellerFixture} from './helpers/seller-app.js';

const modulePath=process.env.QA_PLAYWRIGHT_MODULE;
test('seller sidebar labels remain on one line across languages and widths',{skip:!modulePath,timeout:60000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const f=await sellerFixture();t.after(()=>f.close());
 const page=await browser.newPage({viewport:{width:1440,height:800},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();
 // Include restricted items and bold selected states with synthetic badges in the layout check.
 await page.evaluate(()=>{document.querySelectorAll('.seller-sidebar .nav-item').forEach(e=>{e.hidden=false;e.classList.add('active')});document.querySelectorAll('.seller-sidebar .nav-badge').forEach(e=>{e.hidden=false;e.textContent='99'});});
 const sizes={};
 for(const width of [1440,1024,375,320,280]){
  await page.setViewportSize({width,height:800});if(width<=900){await page.locator('#open-menu').click();await page.waitForTimeout(250);}
  for(const locale of ['en','ms','zh-Hans','vi','th','ja','ko']){
   await page.evaluate(async value=>{(await import('/shared/i18n.js')).setLocale(value);document.querySelectorAll('.seller-sidebar .nav-badge').forEach(e=>{e.hidden=false;e.textContent='99'});},locale);
   const state=await page.evaluate(()=>({labels:[...document.querySelectorAll('.seller-sidebar .nav-item>span[data-i18n],.seller-sidebar .nav-group>span')].map(e=>({text:e.textContent,whiteSpace:getComputedStyle(e).whiteSpace,client:e.clientWidth,scroll:e.scrollWidth,font:parseFloat(getComputedStyle(e).fontSize),name:e.parentElement.getAttribute('aria-label')})),badges:[...document.querySelectorAll('.seller-sidebar .nav-badge')].map(e=>({visible:!!e.getBoundingClientRect().width,within:e.getBoundingClientRect().right<=e.parentElement.getBoundingClientRect().right}))}));
   assert.ok(state.labels.every(x=>x.text&&x.whiteSpace==='nowrap'&&x.scroll<=x.client+1),`${width} ${locale}: ${JSON.stringify(state)}`);
   assert.ok(state.badges.every(x=>x.visible&&x.within),`${width} ${locale}: ${JSON.stringify(state)}`);
   if(locale==='en')sizes[width]=state.labels.find(x=>x.text==='Sales Order Confirmation').font;
   assert.equal(await page.locator('[data-view=confirmations]').getAttribute('aria-label'),await page.locator('[data-view=confirmations] span[data-i18n]').innerText());
  }
  if(width<=900)await page.keyboard.press('Escape');
 }
 assert.ok(sizes[375]>sizes[1440],JSON.stringify(sizes));assert.deepEqual(errors,[]);
});
