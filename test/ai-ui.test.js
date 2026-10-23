import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAiSettings } from '../public/seller/ai-settings.js';
import { mountAiSuggestions } from '../public/seller/ai-suggestions.js';
import { messages, languages } from '../public/shared/i18n.js';
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.value = ''; this.textContent = ''; this.hidden = false; }
  get isConnected() { return this.connected || Boolean(this.parent?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of nodes) node.parent = this; this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key,value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(key,value) { this.events[key] = value; }
  descendants() { return this.children.flatMap(node => [node,...node.descendants()]); }
  querySelectorAll() { return []; }
  focus() { document.activeElement = this; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const find = (root,key) => root.descendants().find(node => node.dataset.i18n === `ai_${key}`);
const options = { csrfToken: () => 'fictional', onUnauthorized() { assert.fail('unauthorized'); } };
const settings = { available:true, enabled:true, tone:'Friendly', businessNotes:'Open daily', dailyTokenCap:1000, revision:7 };
const response = (data,status=200) => ({ ok:status<400,status,json:async()=>data });
async function fixture(run) {
  const previous = globalThis.document;
  globalThis.document = { createElement: tag => new Element(tag), dispatchEvent() {} };
  const root = new Element('main'); root.connected = true;
  try { await run(root); } finally { globalThis.document = previous; }
}
test('AI copy covers all seven languages', () => {
  for (const {code} of languages) for (const key of Object.keys(messages.en).filter(key=>key.startsWith('ai_'))) assert.equal(typeof messages[code][key],'string',`${code}/${key}`);
});
for (const value of [response({},404),response({available:false})]) test(`Unavailable AI settings stay hidden (${value.status})`, async()=>fixture(async root=>{
  const previous=globalThis.fetch; globalThis.fetch=async()=>value;
  try { const page=mountAiSettings(root,options); await page.ready; assert.equal(page.available,false); assert.equal(page.section.hidden,true); assert.equal(page.hasUnsavedChanges(),false); } finally { globalThis.fetch=previous; }
}));
test('Settings saves revision, preserves edits on conflict, maps field errors and 403', async()=>fixture(async root=>{
  const previous=globalThis.fetch; let mode='ok', body;
  globalThis.fetch=async(path,init)=>{
    if(init.method==='GET') return response(settings);
    body=JSON.parse(init.body); assert.equal(init.headers['X-CSRF-Token'],'fictional');
    return mode==='ok' ? response({...settings,...body,revision:8}) : response({error:{code:mode,field:mode==='VALIDATION_ERROR'?'tone':undefined}},mode==='FORBIDDEN'?403:mode==='VALIDATION_ERROR'?400:409);
  };
  try {
    const page=mountAiSettings(root,options); assert.equal(await page.ready,true); assert.equal(page.available,true);
    const tone=root.descendants().find(n=>n.name==='tone'), form=root.descendants().find(n=>n.tagName==='form');
    tone.value='Warm'; assert.equal(page.hasUnsavedChanges(),true); await form.events.submit({preventDefault(){}});
    assert.equal(body.expectedRevision,7); assert.equal(body.tone,'Warm'); assert.equal(page.hasUnsavedChanges(),false);
    mode='VALIDATION_ERROR'; tone.value='changed'; await form.events.submit({preventDefault(){}}); assert.equal(tone.attributes['aria-invalid'],'true');
    mode='FORBIDDEN'; await form.events.submit({preventDefault(){}}); assert.ok(root.descendants().some(n=>n.textContent==='Only the Owner can save AI settings.')); assert.equal(find(root,'save').disabled,false);
  } finally { globalThis.fetch=previous; }
}));
const draft={items:[{productId:'p',name:'<img src=x onerror=alert(1)>',quantity:2,unitPriceMinor:1250,currency:'MYR'}],totalMinor:2500,currency:'MYR',recipientName:'<img>',address:'Somewhere',notes:'Check',missing:['address','recipientName','product:p:unavailable']};
async function suggestions(run,{enabled=true,available=true,canReply=true,confirm=true}={}) {
  return fixture(async root=>{
    const form=new Element('form'), textarea=new Element('textarea'); root.append(form); form.append(textarea);
    let calls=[], result={reply:'Review me',handoff:false,orderDraft:null}, error=null, confirmation=confirm;
    const page=mountAiSuggestions(form,textarea,{current:()=>true,changed(){},confirm:async()=>confirmation,request:async(path,body)=>{ if(path==='ai-settings') return {available,enabled}; calls.push({path,body}); if(error) throw error; return result; }});
    await flush(); page.update('one',canReply);
    await run({root,form,textarea,page,calls,button:find(root,'suggest'),setResult:value=>{result=value;},setError:value=>{error=value;},setConfirm:value=>{confirmation=value;}});
  });
}
for(const flags of [{enabled:false},{available:false},{canReply:false},{}]) test(`Suggestion visibility ${JSON.stringify(flags)}`,async()=>suggestions(async({button})=>{assert.equal(button.hidden,Boolean(flags.enabled===false||flags.available===false||flags.canReply===false));},flags));
test('Overwrite cancel makes no request; acceptance puts draft in composer without sending',async()=>suggestions(async({textarea,button,calls,setConfirm})=>{
  textarea.value='My words'; setConfirm(false); await button.events.click(); assert.equal(calls.length,0); assert.equal(textarea.value,'My words'); assert.equal(button.disabled,false);
  setConfirm(true); await button.events.click(); assert.equal(textarea.value,'Review me'); assert.deepEqual(calls,[{path:'chats/one/suggestions',body:{}}]); assert.equal(document.activeElement,textarea); assert.equal(button.disabled,false);
}));
for(const reason of ['COMPLAINT','REFUND','UNKNOWN','SENSITIVE','OTHER']) test(`Handoff ${reason} and safe order draft`,async()=>suggestions(async({root,textarea,button,setResult})=>{
  setResult({reply:'Draft',handoff:true,handoffReason:reason,orderDraft:draft}); await button.events.click();
  assert.equal(textarea.value,'Draft'); assert.ok(root.descendants().some(n=>n.textContent===messages.en.ai_handoff.replace('{reason}',messages.en[`ai_${reason}`])));
  assert.ok(root.descendants().some(n=>n.textContent==='an item is unavailable')); assert.ok(root.descendants().some(n=>n.tagName==='li'&&n.textContent==='Recipient name'));
  assert.equal(root.descendants().some(n=>n.tagName==='img'),false); assert.ok(root.descendants().some(n=>n.textContent.includes(draft.items[0].name))); assert.equal(button.disabled,false);
}));
for(const [error,key] of [[{code:'AI_CAP'},'cap'],[{code:'AI_DISABLED'},'disabled'],[{status:429,retryAfter:7},'retry'],[{code:'AI_UNAVAILABLE'},'unavailable'],[{code:'AI_TIMEOUT'},'timeout'],[{},'failed']]) test(`Suggestion error ${key} resets button`,async()=>suggestions(async({root,button,setError})=>{
  setError(error); await button.events.click(); assert.ok(root.descendants().some(n=>n.textContent===messages.en[`ai_${key}`].replace('{n}','7'))); assert.equal(button.disabled,false);
}));
test('Thread switch clears card and notices, ignores late response',async()=>suggestions(async({root,page,button,setResult,textarea})=>{
  setResult({reply:'Draft',handoff:true,handoffReason:'OTHER',orderDraft:draft}); await button.events.click();
  page.clear('two'); assert.equal(root.descendants().find(n=>n.className==='ai-order-card').hidden,true); assert.equal(root.descendants().find(n=>n.className==='ai-handoff').hidden,true);
  textarea.value=''; page.update('two',true); assert.equal(button.disabled,false);
}));
test('Copy summary handles absent clipboard and rejected writes',async()=>suggestions(async({root,button,setResult})=>{
  setResult({reply:'Draft',handoff:false,orderDraft:draft}); await button.events.click(); await find(root,'copy').events.click();
  assert.ok(root.descendants().some(n=>n.textContent==='Could not copy summary.'));
}));
for (const accept of [false,true]) test(`Stale revision reload confirmation ${accept}`,async()=>fixture(async root=>{
  const previous=globalThis.fetch; let gets=0;
  globalThis.fetch=async(path,init)=>init.method==='GET' ? (gets++,response({...settings,tone:gets===1?'Old':'New',revision:gets})) : response({error:{code:'STALE_REVISION'}},409);
  try {
    const page=mountAiSettings(root,{...options,confirm:async()=>accept}); await page.ready;
    const tone=root.descendants().find(n=>n.name==='tone'); tone.value='Unsaved';
    await root.descendants().find(n=>n.tagName==='form').events.submit({preventDefault(){}});
    assert.equal(tone.value,accept?'New':'Unsaved'); assert.equal(page.hasUnsavedChanges(),!accept); assert.equal(find(root,'save').disabled,false);
  } finally {globalThis.fetch=previous;}
}));
test('Late suggestion cannot populate a newly selected thread',async()=>fixture(async root=>{
  const textarea=new Element('textarea'), form=new Element('form'); root.append(form); form.append(textarea);
  let resolve; const pending=new Promise(done=>{resolve=done;});
  const page=mountAiSuggestions(form,textarea,{current:()=>true,changed(){},request:async path=>path==='ai-settings'?{available:true,enabled:true}:pending});
  await flush(); page.update('one',true);
  const click=find(root,'suggest').events.click(); await flush(); assert.equal(find(root,'suggest').disabled,true);
  page.update('two',true); resolve({reply:'Old thread',handoff:false,orderDraft:draft}); await click;
  assert.equal(textarea.value,''); assert.equal(root.descendants().find(n=>n.className==='ai-order-card').hidden,true); assert.equal(find(root,'suggest').disabled,false);
}));
test('Clipboard summary contains item, total and translated missing fields',async()=>suggestions(async({root,button,setResult})=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator'); let copied;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>{copied=value;}}}});
  try {
    setResult({reply:'Draft',handoff:false,orderDraft:draft}); await button.events.click(); await find(root,'copy').events.click();
    assert.ok(copied.includes('MYR 25.00')); assert.ok(copied.includes('an item is unavailable')); assert.ok(copied.includes(draft.items[0].name));
    assert.ok(root.descendants().some(n=>n.textContent==='Summary copied.'));
    navigator.clipboard.writeText=async()=>{throw new Error('denied');}; await find(root,'copy').events.click(); assert.ok(root.descendants().some(n=>n.textContent==='Could not copy summary.'));
  } finally {if(previous) Object.defineProperty(globalThis,'navigator',previous); else delete globalThis.navigator;}
}));
test('Typing during generation is preserved when the second overwrite prompt is cancelled',async()=>fixture(async root=>{
  const textarea=new Element('textarea'), form=new Element('form'); root.append(form); form.append(textarea);
  let resolve, prompts=0; const pending=new Promise(done=>{resolve=done;});
  const page=mountAiSuggestions(form,textarea,{current:()=>true,changed(){},confirm:async()=>{prompts++; return false;},request:async path=>path==='ai-settings'?{available:true,enabled:true}:pending});
  await flush(); page.update('one',true);
  const click=find(root,'suggest').events.click(); await flush(); textarea.value='New human text';
  resolve({reply:'Generated',handoff:false,orderDraft:null}); await click;
  assert.equal(textarea.value,'New human text'); assert.equal(prompts,1); assert.equal(find(root,'suggest').disabled,false);
}));
test('Pending settings save blocks navigation until the mutation finishes',async()=>fixture(async root=>{
  const previous=globalThis.fetch; let resolve;
  const pending=new Promise(done=>{resolve=done;});
  globalThis.fetch=async(path,init)=>init.method==='GET'?response(settings):pending;
  try {
    const page=mountAiSettings(root,options); await page.ready;
    const submit=root.descendants().find(n=>n.tagName==='form').events.submit({preventDefault(){}});
    assert.equal(page.isBusy(),true); assert.equal(page.hasUnsavedChanges(),true);
    resolve(response({...settings,revision:8})); await submit;
    assert.equal(page.isBusy(),false); assert.equal(page.hasUnsavedChanges(),false);
  } finally {globalThis.fetch=previous;}
}));
