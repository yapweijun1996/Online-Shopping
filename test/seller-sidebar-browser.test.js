import test from 'node:test';
import assert from 'node:assert/strict';
import {sellerFixture} from './helpers/seller-app.js';
import {setupShop} from '../src/shop-setup.js';
const modulePath=process.env.QA_PLAYWRIGHT_MODULE;
test('seller sidebar persists desktop state, retains its header and supports the mobile drawer',{skip:!modulePath,timeout:90000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const f=await sellerFixture();t.after(()=>f.close());await setupShop(f.app.database,{mode:'production',shopName:'Synthetic Store'});const page=await browser.newPage({viewport:{width:1440,height:400},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-grid').waitFor();
 await page.locator('#collapse-nav').click();await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===74);
 assert.equal(await page.locator('#collapse-nav').getAttribute('aria-expanded'),'false');await page.locator('[data-view=products]').focus();assert.equal(await page.locator('.sidebar-tooltip').isVisible(),true);
 await page.reload();await page.locator('.dashboard-home').waitFor();assert.equal(await page.locator('#sidebar').evaluate(e=>e.classList.contains('collapsed')),true);
 await page.locator('#collapse-nav').click();await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===248);
 const position=await page.evaluate(()=>{const side=document.querySelector('#sidebar'),head=document.querySelector('.sidebar-head');side.scrollTop=200;return {scroll:side.scrollTop,head:head.getBoundingClientRect().top,side:side.getBoundingClientRect().top};});assert.ok(position.scroll>0);assert.ok(Math.abs(position.head-position.side)<2);
 await page.locator('#collapse-nav').click();await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===74);
 for(const width of [320,375,768,1024,1440]){await page.setViewportSize({width,height:700});await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);if(width<=900){await page.locator('#open-menu').click();assert.equal(await page.locator('#sidebar').getAttribute('aria-modal'),'true');assert.equal(await page.evaluate(()=>document.activeElement.id),'close-menu');assert.equal(await page.locator('[data-view=products] span').first().isVisible(),true);await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.querySelector('#sidebar').contains(document.activeElement)),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#open-menu').getAttribute('aria-expanded'),'false');assert.equal(await page.evaluate(()=>document.activeElement.id),'open-menu');}}
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('#sidebar').evaluate(e=>getComputedStyle(e).transitionDuration),'0s');assert.deepEqual(errors,[]);
});

test('sidebar remains usable when browser storage is unavailable',{skip:!modulePath,timeout:30000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const f=await sellerFixture();t.after(()=>f.close());const page=await browser.newPage({viewport:{width:1440,height:700},serviceWorkers:'block'});
 await page.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage unavailable','SecurityError');}})});
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();await page.locator('#collapse-nav').click();await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===74);assert.equal(await page.locator('#collapse-nav').getAttribute('aria-expanded'),'false');
});
