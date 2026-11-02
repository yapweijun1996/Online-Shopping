import test from 'node:test';
import assert from 'node:assert/strict';
import { sellerFixture } from './helpers/seller-app.js';
const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
test('AI seller settings and chat draft at phone width never send automatically', { skip: !modulePath }, async t => {
  const { chromium } = await import(modulePath);
  const browser = await chromium.launch({headless:true,channel:'chrome'}); t.after(()=>browser.close());
  const f = await sellerFixture(); t.after(()=>f.close());
  const context = await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
  let sent=0, revision=7, chatSettings=false;
  const settings={available:true,enabled:true,tone:'Friendly',businessNotes:'Open daily',dailyTokenCap:1000,revision};
  await context.route('**/*',async route=>{
    const request=route.request(), url=new URL(request.url());
    if(url.origin!==f.origin) return route.abort();
    const fulfill=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname.endsWith('/ai-settings')) { if(request.method()==='PATCH') { const body=request.postDataJSON(); assert.equal(body.expectedRevision,revision); Object.assign(settings,body,{revision:++revision}); } return fulfill(chatSettings ? { available: true, enabled: true, level: 1 } : settings); }
    if(url.pathname.endsWith('/integrations/whatsapp-qr')) return fulfill({available:true,state:'CONNECTED',desired:'RUN',acknowledged:true});
    if(url.pathname.endsWith('/suggestions')) return fulfill({reply:'Please review this draft.',handoff:true,handoffReason:'REFUND',orderDraft:{items:[{name:'<img src=x>',quantity:2,unitPriceMinor:1250,currency:'MYR'}],totalMinor:2500,currency:'MYR',recipientName:'Test',address:'',notes:'',missing:['address','product:p:unavailable','product:p:stock','product:p:currency']}});
    if(url.pathname.endsWith('/chats')) return fulfill([{id:'fictional-thread',displayName:'Test customer',canReply:true,suppressed:false,unreadCount:0}]);
    if(url.pathname.includes('/chats/')) {
      if(url.pathname.endsWith('/replies')) { sent++; return fulfill({}); }
      if(url.pathname.endsWith('/orders')) return fulfill({suggested:[]});
      if(url.pathname.endsWith('/messages')) return fulfill([]);
      return fulfill({});
    }
    return route.continue();
  });
  const page=await context.newPage();
  await page.goto(f.origin+'/seller/');
  await page.locator('#username').fill(f.config.username); await page.locator('#password').fill(f.config.password); await page.locator('#password').press('Enter');
  await page.getByRole('button',{name:'Company settings',exact:true}).click();
  await page.setViewportSize({width:375,height:812});
  await page.getByRole('tab',{name:'AI',exact:true}).click();
  await page.locator('[name=tone]').fill('Warm'); await page.locator('.ai-settings').getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('Settings saved.',{exact:true}).waitFor(); assert.equal(settings.tone,'Warm');
  await page.reload();
  await page.locator('[name=tone]:visible').waitFor();
  assert.equal(await page.getByRole('tab',{name:'AI',exact:true}).getAttribute('aria-selected'),'true');
  // Mount the actual inbox module on the fixture app, retaining the authenticated API helper.
  chatSettings=true;
  await page.evaluate(async()=>{
    const {mountWhatsAppChats}=await import('/seller/whatsapp-chats.js');
    const root=document.createElement('main'), cloud=document.createElement('div'); document.body.replaceChildren(root); root.append(cloud);
    window.aiSmoke=mountWhatsAppChats(root,cloud,{csrfToken:()=> 'fixture-token',onUnauthorized(){throw new Error('unauthorized');}});
  });
  await page.getByRole('button',{name:'WhatsApp chats',exact:true}).click();
  await page.getByRole('button',{name:'Test customer',exact:false}).click();
  await page.getByRole('button',{name:'Suggest reply',exact:true}).click();
  await page.getByText('Draft ready. Check before sending.',{exact:true}).waitFor();
  assert.equal(await page.locator('textarea').inputValue(),'Please review this draft.'); assert.equal(sent,0);
  assert.equal(await page.locator('.ai-order-card img').count(),0);
  assert.equal(await page.locator('.ai-handoff').innerText(),'The assistant suggests a human takes over: refund request');
  await page.getByText('an item has less stock than requested',{exact:true}).waitFor();
  await page.getByText('an item is priced in another currency',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Suggest reply',exact:true}).isEnabled(),true);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.evaluate(()=>window.aiSmoke.dispose());
});
