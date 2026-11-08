import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { sellerFixture } from './helpers/seller-app.js';

const modulePath = process.env.QA_PLAYWRIGHT_MODULE;
const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff; for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } const end = Buffer.alloc(4); end.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, body, end]); };
function png() { const header = Buffer.alloc(13); header.writeUInt32BE(16, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2; return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'), chunk('IHDR',header), chunk('IDAT',deflateSync(Buffer.concat(Array.from({length:32},()=>Buffer.concat([Buffer.from([0]),Buffer.alloc(48,170)]))))),chunk('IEND',Buffer.alloc(0))]); }

for (const width of [375,1280]) for (const colorScheme of ['light','dark']) test(`Product editor real browser: ${width}px ${colorScheme}, independent drafts and shopper detail`, {skip:!modulePath}, async(t)=>{
  const {chromium}=await import(modulePath);
  const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu']});t.after(()=>browser.close());
  const f=await sellerFixture();t.after(()=>f.close());
  const context=await browser.newContext({viewport:{width,height:900},colorScheme,serviceWorkers:'block'});
  // Every feature request reaches the real loopback app. External traffic is denied.
  await context.route('**/*',route=>new URL(route.request().url()).origin===f.origin?route.continue():route.abort());
  const page=await context.newPage();let detailStageRequests=0; page.on('request',request=>{ if(request.method()==='POST' && new URL(request.url()).pathname.endsWith('/detail/images')) detailStageRequests++; });const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${f.origin}/seller/#products/${f.product.id}`);
  await page.locator('#username').fill(f.config.username);await page.locator('#password').fill(f.config.password);await page.locator('#password').press('Enter');
  await page.locator('#product-editor-tab-basic').waitFor();
  await page.locator('#product-detail-status').filter({hasText:'Loading'}).waitFor({state:'hidden'});
  assert.equal(await page.locator('#product-editor-tab-basic').getAttribute('aria-selected'),'true');
  await page.locator('#product-editor-tab-basic').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#product-editor-tab-images').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('#product-open-ai').isEnabled(),true,'AI entry opens context, generation restrictions are explained');
  await page.keyboard.press('End');assert.equal(await page.locator('#product-editor-tab-variants').getAttribute('aria-selected'),'true');
  await page.locator('#product-editor-tab-detail').click();
  await page.locator('#product-detail-block-kind').selectOption('heading');await page.getByRole('button',{name:'Add block',exact:true}).click();
  await page.locator('#product-detail-blocks input').fill('Care and dimensions');
  await page.locator('#product-detail-block-kind').selectOption('paragraph');await page.getByRole('button',{name:'Add block',exact:true}).click();
  await page.locator('#product-detail-blocks textarea').fill('<img src=x onerror=window.__xss=1>Long-form product details.');
  await page.getByLabel('Bold paragraph',{exact:true}).check();
  // Header-shaped but undecodable compressed pixels must never reach staging.
  const header = Buffer.alloc(13); header.writeUInt32BE(16,0); header.writeUInt32BE(32,4); header[8]=8; header[9]=2;
  const damaged = Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',Buffer.alloc(20)),chunk('IEND',Buffer.alloc(0))]);
  const stageCount = detailStageRequests;
  await page.locator('#product-detail-block-kind').selectOption('image');await page.getByRole('button',{name:'Add block',exact:true}).click();
  await page.locator('#product-detail-upload').setInputFiles({name:'damaged.png',mimeType:'image/png',buffer:damaged});
  await page.getByText('This image cannot be displayed, or is too large in pixels. Choose a valid image up to 32,768 pixels per side and 40 million pixels in total.',{exact:true}).waitFor();
  assert.equal(detailStageRequests,stageCount,'undecodable bytes never issue an upload request');
  assert.equal(Number((await f.app.database.get('SELECT COUNT(*) AS n FROM listing_detail_image')).n),0,'undecodable bytes never stage an image');
  assert.equal(await page.locator('#product-detail-blocks textarea').inputValue(),'<img src=x onerror=window.__xss=1>Long-form product details.','a failed image preserves the text draft');
  page.once('dialog', dialog=>dialog.dismiss()); await page.locator('#product-back').click();
  assert.equal(await page.locator('#product-detail-blocks textarea').inputValue(),'<img src=x onerror=window.__xss=1>Long-form product details.','detail-only dirty guard preserves draft');
  await page.locator('#product-editor-tab-basic').click();await page.locator('input[name=name]').fill('Updated example item');
  await page.locator('#product-save').click();await page.getByText('Product saved.',{exact:true}).waitFor();
  await page.locator('#product-editor-tab-detail').click();
  assert.equal(await page.locator('#product-detail-blocks textarea').inputValue(),'<img src=x onerror=window.__xss=1>Long-form product details.','saving basic information preserves detail draft');
  await page.locator('#product-detail-block-kind').selectOption('image');await page.getByRole('button',{name:'Add block',exact:true}).click();
  await page.locator('#product-detail-upload').setInputFiles({name:'detail.png',mimeType:'image/png',buffer:png()});
  await page.getByLabel('Image description (required)',{exact:true}).fill('Tall product demonstration');
  // Discarding an unsaved uploaded block releases its staged storage slot.
  await page.getByRole('button',{name:'Add block',exact:true}).click();
  const stagedReply = page.waitForResponse(response=>response.request().method()==='POST' && response.url().endsWith('/detail/images'));
  await page.locator('#product-detail-upload').setInputFiles({name:'discard.png',mimeType:'image/png',buffer:png()});
  const staged = await (await stagedReply).json();
  await page.locator('.product-rich-block').last().getByRole('button',{name:'Delete block',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.product-rich-block').length===3);
  assert.equal((await context.request.get(`${f.origin}${staged.src}`)).status(),404,'unsaved removed image is deleted');
  await page.getByLabel('Caption (optional)',{exact:true}).fill('Example caption');
  await page.getByRole('button',{name:'Mobile',exact:true}).click();
  assert.equal(await page.locator('#product-detail-preview').getAttribute('data-mode'),'mobile');
  assert.equal(await page.locator('#product-detail-preview img').count(),1);
  assert.equal(await page.evaluate(()=>window.__xss),undefined);
  // Detail save keeps an unsaved basic draft.
  await page.locator('#product-editor-tab-basic').click();await page.locator('input[name=name]').fill('Unsaved metadata draft');
  await page.locator('#product-editor-tab-detail').click();await page.locator('#product-detail-save').click();
  await page.getByText('Rich detail saved.',{exact:true}).waitFor();
  await page.locator('#product-editor-tab-basic').click();assert.equal(await page.locator('input[name=name]').inputValue(),'Unsaved metadata draft');
  // Cancel navigation guard really runs and preserves the mounted detail editor.
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('#product-cancel').click();
  assert.equal(await page.locator('input[name=name]').inputValue(),'Unsaved metadata draft');
  await page.locator('input[name=name]').fill('Updated example item');
  await page.locator('#product-editor-tab-detail').click();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);assert.ok(overflow<=0,`no horizontal overflow: ${overflow}`);
  if(process.env.PRODUCT_EDITOR_SHOTS){
    await page.screenshot({path:`${process.env.PRODUCT_EDITOR_SHOTS}/editor-${width}-${colorScheme}.png`,fullPage:true,animations:'disabled'});
    await page.screenshot({path:`${process.env.PRODUCT_EDITOR_SHOTS}/editor-${width}-${colorScheme}-viewport.png`,animations:'disabled'});
    console.log('PRODUCT_EDITOR_LAYOUT',width,colorScheme,await page.evaluate(()=>{const sidebar=document.querySelector('#sidebar');return JSON.stringify({rect:sidebar.getBoundingClientRect().toJSON(),transform:getComputedStyle(sidebar).transform,width:getComputedStyle(sidebar).width,sidebarClass:sidebar.className,bodyClass:document.body.className,scrollX,scrollY});}));
  }
  const buyer=await context.newPage();await buyer.goto(`${f.origin}/shop/#product/${f.product.id}`);
  await buyer.getByText('Care and dimensions',{exact:true}).waitFor();
  await buyer.getByText('Example caption',{exact:true}).waitFor();
  assert.equal(await buyer.locator('.rich-product-detail img').count(),1);assert.equal(await buyer.evaluate(()=>window.__xss),undefined);
  assert.ok(await buyer.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=0);
  // A competing real save cannot silently overwrite a seller's open draft.
  const owner = await f.login();
  const current = await f.request('GET', `/api/v1/seller/products/${f.product.id}/detail`, undefined, owner.headers);
  assert.equal((await f.request('PUT', `/api/v1/seller/products/${f.product.id}/detail`, {expectedRevision:current.data.revision,document:{version:1,blocks:[{type:'heading',text:'Concurrent saved heading'}]}}, owner.headers)).response.status,200);
  await page.locator('#product-detail-blocks input').first().fill('My preserved conflicting draft');
  await page.locator('#product-detail-save').click();
  await page.getByText('Detail changed elsewhere. Copy your draft before reloading saved detail.',{exact:true}).waitFor();
  assert.equal(await page.locator('#product-detail-blocks input').first().inputValue(),'My preserved conflicting draft');
  assert.deepEqual(errors,[]);
});


test('Product editor new product: hidden required fields reveal their tab, save unlocks media and all locales retain drafts', {skip:!modulePath},async(t)=>{
  const {chromium}=await import(modulePath);const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu']});t.after(()=>browser.close());
  const f=await sellerFixture();t.after(()=>f.close());const page=await browser.newPage({viewport:{width:375,height:850},serviceWorkers:'block'});
  await page.goto(`${f.origin}/seller/#products/new`);await page.locator('#username').fill(f.config.username);await page.locator('#password').fill(f.config.password);await page.locator('#password').press('Enter');
  await page.locator('#product-editor-tab-images').click();assert.equal(await page.locator('#product-open-ai').isDisabled(),true);
  await page.locator('#product-save').click();assert.equal(await page.locator('#product-editor-tab-basic').getAttribute('aria-selected'),'true','invalid required field tab is revealed');
  await page.locator('input[name=sku]').fill('NEW-EDITOR');await page.locator('input[name=name]').fill('New editor item');await page.locator('textarea[name=description]').fill('Short plain summary');await page.locator('input[name=price]').fill('19.90');await page.locator('select[name=category]').selectOption('EXAMPLES');
  await page.locator('#product-save').click();await page.getByText('Product saved.',{exact:true}).waitFor();
  await page.locator('#product-editor-tab-detail').click();await page.locator('#product-detail-block-kind').selectOption('list');await page.getByRole('button',{name:'Add block',exact:true}).click();await page.getByLabel('One item per line',{exact:true}).fill('First item\nSecond item');
  await page.locator('#product-detail-block-kind').selectOption('specs');await page.getByRole('button',{name:'Add block',exact:true}).click();await page.getByLabel('One specification per line: label | value',{exact:true}).fill('Material | Steel\nLength | 10 cm');
  await page.locator('.product-rich-block').last().getByRole('button',{name:'Move up: 2',exact:true}).click();assert.equal(await page.locator('.product-rich-block h4').first().innerText(),'1. Specifications');
  for(const code of ['ms','zh-Hans','vi','th','ja','ko','en']){await page.evaluate(async value=>(await import('/shared/i18n.js')).setLocale(value),code);assert.equal(await page.locator('.product-rich-block textarea').first().inputValue(),'Material | Steel\nLength | 10 cm');}
  await page.locator('#product-detail-save').click();await page.getByText('Rich detail saved.',{exact:true}).waitFor();
  await page.locator('#product-editor-tab-images').click();assert.equal(await page.locator('#product-open-ai').isEnabled(),true);
  await page.locator('#product-open-ai').click();await page.locator('.ai-studio').waitFor();assert.match(page.url(),/#aistudio\/[0-9a-f-]{36}$/);assert.equal(await page.locator('#ai-studio-tab-images').getAttribute('aria-selected'),'true','AI opens on image task with current product context');
});
