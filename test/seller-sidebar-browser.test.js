import test from 'node:test';
import assert from 'node:assert/strict';
import {sellerFixture} from './helpers/seller-app.js';
import {setupShop} from '../src/shop-setup.js';
import {createAccount} from '../src/accounts.js';
const modulePath=process.env.QA_PLAYWRIGHT_MODULE;
test('seller sidebar persists desktop state, retains its header and supports the mobile drawer',{skip:!modulePath,timeout:90000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const f=await sellerFixture();t.after(()=>f.close());await setupShop(f.app.database,{mode:'production',shopName:'Synthetic Store'});const page=await browser.newPage({viewport:{width:1440,height:400},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-grid').waitFor();assert.match(await page.locator('#collapse-nav').getAttribute('aria-label'),/^Seller Studio — .+/);
 await page.locator('#collapse-nav').click();await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===74);
 assert.equal(await page.locator('#collapse-nav').getAttribute('aria-expanded'),'false');assert.match(await page.locator('#collapse-nav').getAttribute('aria-label'),/^Seller Studio — .+/);await page.locator('[data-view=products]').focus();assert.equal(await page.locator('.sidebar-tooltip').isVisible(),true);
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

test('seller sidebar feedback follows the palette and respects reduced motion',{skip:!modulePath,timeout:30000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const f=await sellerFixture();t.after(()=>f.close());const page=await browser.newPage({viewport:{width:1440,height:700},serviceWorkers:'block'});
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();
 const item=page.locator('[data-view=products]'),icon=item.locator('svg');
 for(const palette of ['evergreen-teal','ocean-blue','warm-plum','navy-orange','high-contrast','graphite']){
  await page.mouse.move(1100,600);await page.evaluate(p=>window.sellerPalette.choose(p),palette);await page.waitForFunction(e=>getComputedStyle(e).backgroundColor==='rgba(0, 0, 0, 0)',await item.elementHandle());const idle=await item.evaluate(e=>getComputedStyle(e).backgroundColor);
  await item.hover();await page.waitForFunction(e=>Math.abs(new DOMMatrixReadOnly(getComputedStyle(e).transform).m41-2)<.01,await icon.elementHandle());assert.notEqual(await item.evaluate(e=>getComputedStyle(e).backgroundColor),idle,palette);const group=page.locator('.nav-group[aria-controls="sales-nav-group"]');await group.hover();assert.notEqual(await group.evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)',palette);
 }
 await page.keyboard.press('Tab');await item.focus();assert.equal(await item.evaluate(e=>getComputedStyle(e).outlineStyle),'solid');assert.equal(await page.locator('[data-view=dashboard]').getAttribute('aria-current'),'page');
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await item.evaluate(e=>getComputedStyle(e).transitionDuration),'0s');await item.hover();assert.equal(await icon.evaluate(e=>getComputedStyle(e).transform),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:375,height:700});await page.locator('#open-menu').click();await page.waitForTimeout(250);assert.equal(await item.isVisible(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});

test('touch sidebar feedback does not move icons',{skip:!modulePath,timeout:30000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const f=await sellerFixture();t.after(()=>f.close());const context=await browser.newContext({viewport:{width:375,height:700},isMobile:true,hasTouch:true,serviceWorkers:'block'}),page=await context.newPage();
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.locator('#login-submit').tap();await page.locator('.dashboard-home').waitFor();await page.locator('#open-menu').tap();
 assert.equal(await page.evaluate(()=>matchMedia('(hover:hover) and (pointer:fine)').matches),false);const item=page.locator('[data-view=products]');await item.hover();await page.waitForTimeout(200);assert.equal(await item.locator('svg').evaluate(e=>getComputedStyle(e).transform),'none');
});

test('active indicator follows routes, resizing and reduced-motion preference',{skip:!modulePath,timeout:40000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const f=await sellerFixture();t.after(()=>f.close());await setupShop(f.app.database,{mode:'production',shopName:'Synthetic Store'});const page=await browser.newPage({viewport:{width:1440,height:800},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-grid').waitFor();
 const marker=page.locator('.nav-current-indicator');assert.equal(await marker.getAttribute('aria-hidden'),'true');
 const aligned=()=>page.waitForFunction(()=>{const i=document.querySelector('.nav-current-indicator'),a=document.querySelector('.seller-sidebar [aria-current="page"]');if(!i||!a||i.hidden)return false;const x=i.getBoundingClientRect(),y=a.getBoundingClientRect();return Math.abs(x.top-y.top-9)<1&&Math.abs(x.height-y.height+18)<1;});
 await aligned();await page.locator('[data-view=confirmations]').click();await page.waitForFunction(()=>document.querySelector('[data-view=confirmations]').getAttribute('aria-current')==='page');await aligned();
 await page.locator('#collapse-nav').click();await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===74);await aligned();
 await page.setViewportSize({width:375,height:700});await page.locator('#open-menu').click();await aligned();await page.keyboard.press('Escape');
 await page.setViewportSize({width:1440,height:800});await page.emulateMedia({reducedMotion:'reduce'});await page.locator('[data-view=dashboard]').click();await aligned();assert.equal(await marker.evaluate(e=>getComputedStyle(e).transitionDuration),'0s');assert.deepEqual(errors,[]);
});

test('active indicator follows collapsed navigation without ResizeObserver',{skip:!modulePath,timeout:30000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const f=await sellerFixture();t.after(()=>f.close());
 const page=await browser.newPage({viewport:{width:1440,height:700},serviceWorkers:'block',reducedMotion:'reduce'});await page.addInitScript(()=>{window.ResizeObserver=undefined;});
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();await page.locator('[data-view=confirmations]').click();await page.evaluate(async()=>{const {setLocale}=await import('/shared/i18n.js');setLocale('zh-Hans');});
 const aligned=()=>page.waitForFunction(()=>{const i=document.querySelector('.nav-current-indicator'),a=document.querySelector('.seller-sidebar [aria-current="page"]');return i&&!i.hidden&&Math.abs(i.getBoundingClientRect().top-a.getBoundingClientRect().top-9)<1;});
 await aligned();await page.locator('#collapse-nav').click();await aligned();
});

test('navigation groups preserve compact access, current-page context and mobile keyboard focus',{skip:!modulePath,timeout:45000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const f=await sellerFixture();t.after(()=>f.close());
 await setupShop(f.app.database,{mode:'production',shopName:'Synthetic Store'});const page=await browser.newPage({viewport:{width:1440,height:800},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-grid').waitFor();
 const group=page.locator('.nav-group[aria-controls="sales-nav-group"]'),panel=page.locator('#sales-nav-group'),orders=page.locator('[data-view=orders]');assert.equal(await group.getAttribute('aria-expanded'),'true');
 await orders.click();await page.waitForFunction(()=>document.querySelector('[data-view=orders]').getAttribute('aria-current')==='page');await group.focus();await page.keyboard.press('Enter');assert.equal(await group.getAttribute('aria-expanded'),'false');assert.equal(await panel.evaluate(e=>e.inert),true);assert.equal(await panel.getAttribute('aria-hidden'),'true');assert.equal(await group.getAttribute('aria-current'),'location');
 await page.waitForFunction(()=>{const a=document.querySelector('.nav-group[aria-controls="sales-nav-group"]').getBoundingClientRect(),i=document.querySelector('.nav-current-indicator').getBoundingClientRect();return Math.abs(i.top-a.top-9)<1;});
 await page.locator('#collapse-nav').click();await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===74);assert.equal(await panel.evaluate(e=>e.inert),false);assert.equal(await orders.isVisible(),true);assert.equal(await group.isVisible(),false);
 await page.locator('#collapse-nav').click();await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===248);assert.equal(await panel.evaluate(e=>e.inert),true);assert.equal(await group.getAttribute('aria-current'),'location');
 await page.locator('[data-view=categories]').focus();await page.setViewportSize({width:375,height:700});await page.waitForFunction(()=>document.activeElement.id==='open-menu');await page.locator('#open-menu').click();assert.equal(await group.getAttribute('aria-expanded'),'false');for(let i=0;i<12;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('[inert]'))),false);}
 await group.focus();await page.keyboard.press('Space');assert.equal(await group.getAttribute('aria-expanded'),'true');assert.equal(await panel.evaluate(e=>e.inert),false);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'open-menu');
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await panel.evaluate(e=>getComputedStyle(e).transitionDuration),'0s');assert.deepEqual(errors,[]);
});

test('group transition updates the current marker without ResizeObserver',{skip:!modulePath,timeout:30000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const f=await sellerFixture();t.after(()=>f.close());
 const page=await browser.newPage({viewport:{width:1440,height:800},serviceWorkers:'block'});await page.addInitScript(()=>{window.ResizeObserver=undefined;});
 await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();await page.locator('[data-view=categories]').click();await page.locator('.nav-group[aria-controls="sales-nav-group"]').click();
 await page.waitForFunction(()=>document.querySelector('#sales-nav-group').getBoundingClientRect().height<1);
 await page.waitForFunction(()=>{const i=document.querySelector('.nav-current-indicator'),a=document.querySelector('[data-view=categories]');return i&&!i.hidden&&Math.abs(i.getBoundingClientRect().top-a.getBoundingClientRect().top-9)<1;});
});


test('staff navigation hides empty restricted groups',{skip:!modulePath,timeout:30000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const f=await sellerFixture();t.after(()=>f.close());
 const staff=await createAccount(f.app.database,{username:'synthetic.staff',role:'STAFF',password:'Fictional-Staff-2026!'},f.config.username);await f.app.database.run('UPDATE seller_account SET must_change_password=0 WHERE id=?',staff.id);
 const page=await browser.newPage({viewport:{width:1440,height:700},serviceWorkers:'block'});await page.goto(f.origin+'/seller/');await page.fill('#username','synthetic.staff');await page.fill('#password','Fictional-Staff-2026!');await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();
 assert.equal(await page.locator('.nav-group[aria-controls="configuration-nav-group"]').isVisible(),false);assert.equal(await page.locator('#configuration-nav-group').isVisible(),false);assert.equal(await page.locator('[data-view=products]').isVisible(),false);assert.equal(await page.locator('[data-view=orders]').isVisible(),true);
 await page.locator('#collapse-nav').click();await page.setViewportSize({width:375,height:700});await page.locator('#open-menu').click();assert.equal(await page.locator('.nav-group[aria-controls="configuration-nav-group"]').isVisible(),false);assert.equal(await page.locator('[data-view=products]').isVisible(),false);
});

test('compact sidebar tooltips follow focus and scroll, and respect reduced motion',{skip:!modulePath,timeout:30000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const f=await sellerFixture();t.after(()=>f.close());
 const page=await browser.newPage({viewport:{width:1440,height:400},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-home').waitFor();
 await page.locator('#collapse-nav').click();await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===74);const tip=page.locator('.seller-sidebar-tooltip'),orders=page.locator('[data-view=orders]');
 await orders.focus();await page.waitForFunction(()=>document.querySelector('.seller-sidebar-tooltip').classList.contains('is-visible'));assert.equal(await tip.getAttribute('aria-hidden'),'true');assert.equal(await tip.innerText(),'Sales Orders');await page.locator('[data-view=products]').hover();assert.equal(await tip.innerText(),'Products');await page.mouse.move(1000,250);assert.equal(await tip.innerText(),'Sales Orders');const before=await tip.evaluate(e=>parseFloat(e.style.top));
 await page.locator('#sidebar').evaluate(e=>{e.scrollTop=40});await page.waitForFunction(previous=>Math.abs(parseFloat(document.querySelector('.seller-sidebar-tooltip').style.top)-previous)>10,before);
 await page.locator('#sidebar').evaluate(e=>{e.scrollTop=e.scrollHeight});await page.waitForFunction(()=>getComputedStyle(document.querySelector('.seller-sidebar-tooltip')).visibility==='hidden');await page.locator('#sidebar').evaluate(e=>{e.scrollTop=0});await page.waitForFunction(()=>getComputedStyle(document.querySelector('.seller-sidebar-tooltip')).visibility==='visible');
 await page.locator('[data-view=products]').focus();assert.equal(await tip.innerText(),'Products');await page.locator('#page-title').focus();await page.waitForFunction(()=>getComputedStyle(document.querySelector('.seller-sidebar-tooltip')).visibility==='hidden');
 await page.emulateMedia({reducedMotion:'reduce'});await orders.focus();assert.equal(await tip.evaluate(e=>getComputedStyle(e).transitionDuration),'0s');await page.locator('#page-title').focus();assert.equal(await tip.evaluate(e=>getComputedStyle(e).visibility),'hidden');assert.deepEqual(errors,[]);
});

test('desktop sidebar labels appear only after opening completes, including rapid toggles and reduced motion',{skip:!modulePath,timeout:40000},async t=>{
 const {chromium}=await import(modulePath),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());const f=await sellerFixture();t.after(()=>f.close());await setupShop(f.app.database,{mode:'production',shopName:'Synthetic Store'});
 const page=await browser.newPage({viewport:{width:1440,height:800},serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(f.origin+'/seller/');await page.fill('#username',f.config.username);await page.fill('#password',f.config.password);await page.click('#login-submit');await page.locator('.dashboard-grid').waitFor();
 await page.evaluate(()=>document.documentElement.style.setProperty('--ui-motion-fast','600ms'));const toggle=page.locator('#collapse-nav'),label=page.locator('[data-view=confirmations] span').first(),group=page.locator('.nav-group[aria-controls="sales-nav-group"]');
 await toggle.click();await page.waitForTimeout(120);assert.equal(await label.evaluate(e=>getComputedStyle(e).visibility),'hidden');await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===74);
 const middle=await page.evaluate(()=>{const s=document.querySelector('#sidebar');document.querySelector('#collapse-nav').click();void getComputedStyle(s).width;const transition=s.getAnimations().find(a=>a.transitionProperty==='width');if(!transition)throw new Error('Width transition missing');transition.pause();transition.currentTime=transition.effect.getComputedTiming().duration/2;const label=document.querySelector('[data-view=confirmations] span'),group=document.querySelector('.nav-group[aria-controls="sales-nav-group"]');return {width:s.getBoundingClientRect().width,opening:s.classList.contains('sidebar-opening'),label:getComputedStyle(label).visibility,group:getComputedStyle(group).visibility};});assert.ok(middle.width<247&&middle.width>74,JSON.stringify(middle));assert.equal(middle.opening,true);assert.equal(middle.label,'hidden');assert.equal(middle.group,'hidden');await page.evaluate(()=>document.querySelector('#sidebar').getAnimations().filter(a=>a.transitionProperty==='width').forEach(a=>a.play()));
 await page.waitForFunction(()=>!document.querySelector('#sidebar').classList.contains('sidebar-opening')&&document.querySelector('#sidebar').getBoundingClientRect().width===248);assert.equal(await label.evaluate(e=>getComputedStyle(e).visibility),'visible');assert.equal(await group.evaluate(e=>getComputedStyle(e).visibility),'visible');
 await page.evaluate(()=>{const b=document.querySelector('#collapse-nav');b.click();b.click();});await page.waitForFunction(()=>!document.querySelector('#sidebar').classList.contains('sidebar-opening')&&!document.querySelector('#sidebar').classList.contains('collapsed'));assert.equal(await label.evaluate(e=>getComputedStyle(e).visibility),'visible');
 await page.emulateMedia({reducedMotion:'reduce'});await toggle.click();await toggle.click();assert.equal(await page.locator('#sidebar').evaluate(e=>e.classList.contains('sidebar-opening')),false);assert.equal(await label.evaluate(e=>getComputedStyle(e).visibility),'visible');
 await page.emulateMedia({reducedMotion:'no-preference'});await toggle.click();await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().width===74);await toggle.click();await page.setViewportSize({width:375,height:800});await page.waitForFunction(()=>!document.querySelector('#sidebar').classList.contains('sidebar-opening'));await page.locator('#open-menu').click();assert.equal(await page.locator('[data-view=products] span').first().isVisible(),true);assert.deepEqual(errors,[]);
});
