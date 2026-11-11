// Shop-local estimates, never a provider invoice. All money uses integer micro-USD.
import { randomUUID } from 'node:crypto';
import { ApiError } from '../http.js';
import { FieldError } from '../validation.js';

export const PRICE_VERSION = 'openai-standard-2026-11-11';
export const budgetSchema = `
CREATE TABLE IF NOT EXISTS ai_studio_budget (
 id INTEGER PRIMARY KEY CHECK (id = 1), daily_microusd BIGINT, monthly_microusd BIGINT,
 mode TEXT NOT NULL DEFAULT 'WARN' CHECK (mode IN ('WARN','BLOCK')),
 alert_percent INTEGER NOT NULL DEFAULT 80 CHECK (alert_percent BETWEEN 1 AND 100),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
 CHECK (daily_microusd IS NULL OR daily_microusd BETWEEN 10000 AND 100000000000),
 CHECK (monthly_microusd IS NULL OR monthly_microusd BETWEEN 10000 AND 100000000000)
);
INSERT INTO ai_studio_budget (id, updated_at) VALUES (1, '1970-01-01T00:00:00.000Z') ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS ai_studio_cost (
 id TEXT PRIMARY KEY, model TEXT NOT NULL,
 tokens_json TEXT, estimated_microusd BIGINT CHECK (estimated_microusd IS NULL OR estimated_microusd >= 0),
 price_version TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_studio_budget_event (
 id TEXT PRIMARY KEY, actor TEXT NOT NULL, settings_json TEXT NOT NULL, created_at TEXT NOT NULL
);`;
export const BUDGET_TABLES = ['ai_studio_budget', 'ai_studio_cost', 'ai_studio_budget_event'];
export const migrateStudioBudget = store => store.exec(budgetSchema);
export async function getBudget(store) {
 const r = await store.get('SELECT * FROM ai_studio_budget WHERE id = 1');
 return { dailyMicrousd:r.daily_microusd === null ? null : Number(r.daily_microusd), monthlyMicrousd:r.monthly_microusd === null ? null : Number(r.monthly_microusd), mode:r.mode, alertPercent:Number(r.alert_percent), revision:Number(r.revision), currency:'USD', timezone:'UTC' };
}
export async function saveBudget(store, input, actor) {
 if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!['dailyMicrousd','monthlyMicrousd','mode','alertPercent','expectedRevision'].includes(k))) throw new FieldError('budget','Enter supported budget settings.');
 const {dailyMicrousd = null, monthlyMicrousd = null, mode, alertPercent, expectedRevision} = input;
 for(const n of [dailyMicrousd,monthlyMicrousd]) if(n !== null && (!Number.isSafeInteger(n)||n<10000||n>100000000000)) throw new FieldError('budget','Use USD 0.01 to 100,000, or leave the budget empty.');
 if(!['WARN','BLOCK'].includes(mode)||!Number.isInteger(alertPercent)||alertPercent<1||alertPercent>100||!Number.isSafeInteger(expectedRevision)||expectedRevision<1) throw new FieldError('budget','Check the budget settings.');
 return store.transaction(async()=>{
 const r = await store.get('UPDATE ai_studio_budget SET daily_microusd=?,monthly_microusd=?,mode=?,alert_percent=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=? RETURNING id',dailyMicrousd,monthlyMicrousd,mode,alertPercent,new Date().toISOString(),expectedRevision);
 if(!r) throw new ApiError(409,'STALE_REVISION','Budget changed. Reload and try again.');
 const setting=await getBudget(store);
 await store.run('INSERT INTO ai_studio_budget_event (id,actor,settings_json,created_at) VALUES (?,?,?,?)',randomUUID(),String(actor).slice(0,64),JSON.stringify(setting),new Date().toISOString()); return setting;
 });
}
const counted = "u.outcome IN ('PENDING','OK','AMBIGUOUS')";
async function totals(store,start,end) {
 const r=await store.get(`SELECT COUNT(*) AS calls, COALESCE(SUM(c.estimated_microusd),0) AS estimated, SUM(CASE WHEN c.estimated_microusd IS NULL THEN 1 ELSE 0 END) AS unknown FROM ai_studio_usage u LEFT JOIN ai_studio_cost c ON c.id=u.id WHERE u.day>=? AND u.day<? AND ${counted}`,start,end);
 return {calls:Number(r.calls),estimatedMicrousd:Number(r.estimated),unknownCalls:Number(r.unknown||0)};
}
export async function budgetStatus(store,now=new Date()) {
 const day=new Date(now).toISOString().slice(0,10), month=day.slice(0,7)+'-01';
 const next=new Date(day+'T00:00:00Z'); next.setUTCDate(next.getUTCDate()+1);
 const nextMonth=new Date(month+'T00:00:00Z');nextMonth.setUTCMonth(nextMonth.getUTCMonth()+1);
 const setting=await getBudget(store), today=await totals(store,day,next.toISOString().slice(0,10)), monthly=await totals(store,month,nextMonth.toISOString().slice(0,10));
 const decorate=(t,limit)=>({...t,budgetMicrousd:limit,remainingMicrousd:limit===null||t.unknownCalls>0?null:Math.max(0,limit-t.estimatedMicrousd),state:limit===null?'UNSET':t.estimatedMicrousd>=limit?'EXCEEDED':t.unknownCalls?'UNCERTAIN':t.estimatedMicrousd*100>=limit*setting.alertPercent?'NEAR':'NORMAL'});
 return {setting,today:decorate(today,setting.dailyMicrousd),month:decorate(monthly,setting.monthlyMicrousd),dayResetsAt:next.toISOString(),monthResetsAt:nextMonth.toISOString(),asOf:new Date(now).toISOString()};
}
// Called within reserve's writer transaction. Current image/vision requests have no proven maximum
// billable cost. BLOCK fails closed rather than promise a monetary ceiling with a guessed reservation.
export async function checkBudget(store,now) {
 const s=await budgetStatus(store,now);
 if(s.setting.mode!=='BLOCK'||s.setting.dailyMicrousd===null&&s.setting.monthlyMicrousd===null) return;
 if([s.today,s.month].some(t=>t.budgetMicrousd!==null&&t.estimatedMicrousd>=t.budgetMicrousd)) throw new ApiError(429,'AI_STUDIO_BUDGET','The AI budget has been reached.');
 throw new ApiError(409,'AI_STUDIO_BUDGET_UNCERTAIN','A safe maximum cost is unavailable for this request. Owner can choose warning mode.');
}
const token = n => Number.isSafeInteger(n)&&n>=0&&n<=100000000;
export function usageEstimate(model,usage,serviceTier='default') {
 if(serviceTier!=='default')return null;
 if(!usage||!token(usage.input_tokens)||!token(usage.output_tokens)) return null;
 let micro;
 if(model==='gpt-6-astra') {
  if (Object.entries(usage.input_tokens_details||{}).some(([k,v])=>k!=='cached_tokens'&&Number(v)!==0)) return null;
  const cached=usage.input_tokens_details?.cached_tokens;
  if(!token(cached)||cached>usage.input_tokens) return null;
  micro=(usage.input_tokens-cached)*10+cached+usage.output_tokens*50;
 } else if(model==='gpt-image-2.5-sunburst') {
  if (Object.entries(usage.input_tokens_details||{}).some(([k,v])=>!['text_tokens','image_tokens'].includes(k)&&Number(v)!==0)) return null;
  const {text_tokens:text,image_tokens:image} = usage.input_tokens_details||{};
  if(!token(text)||!token(image)||text+image!==usage.input_tokens) return null;
  micro=text*5+image*8+usage.output_tokens*30;
 } else return null;
 return Number.isSafeInteger(micro)?micro:null;
}
export async function recordUsage(store,id,{model,usage,serviceTier='default'}) {
 // Whitelist usage fields: never persist raw provider response/prompt/image or arbitrary errors.
 const clean=usage&&token(usage.input_tokens)&&token(usage.output_tokens)?{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,input_tokens_details:Object.fromEntries(['cached_tokens','text_tokens','image_tokens'].filter(k=>token(usage.input_tokens_details?.[k])).map(k=>[k,usage.input_tokens_details[k]]))}:null;
 const estimate=usageEstimate(model,usage,serviceTier);
 if (!await store.get('SELECT id FROM ai_studio_usage WHERE id=?',id)) throw new Error('Unknown AI usage record.');
 await store.run('INSERT INTO ai_studio_cost (id,model,tokens_json,estimated_microusd,price_version,recorded_at) VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING',id,String(model||'unknown').slice(0,100),clean?JSON.stringify({...clean,service_tier:String(serviceTier).slice(0,30)}):null,estimate,PRICE_VERSION,new Date().toISOString());
}
export async function analytics(store,params,now=new Date()) {
 const day=new Date(now).toISOString().slice(0,10), raw=params.get('days')||'30';
 const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
 let from=params.get('from'), to=params.get('to');
 if(params.has('from')||params.has('to')) { if(!from||!to||!validDate(from)||!validDate(to)||from>to||to>day||Date.parse(to)-Date.parse(from)>365*86400000) throw new FieldError('range','Choose a valid range of up to 366 days.'); }
 else { if(!['1','7','30','90','month'].includes(raw)) throw new FieldError('days','Choose a valid period.'); const start=new Date(day+'T00:00:00Z'); if(raw==='month') start.setUTCDate(1); else start.setUTCDate(start.getUTCDate()-Number(raw)+1); from=start.toISOString().slice(0,10);to=day; }
 const end=new Date(Date.parse(to+'T00:00:00Z')+86400000).toISOString().slice(0,10);
 const number=(key,fallback,max)=>{const value=params.get(key);if(value===null)return fallback;if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>max)throw new FieldError(key,'Choose a valid page.');return Number(value)};
 const limit=number('limit',25,100),offset=number('offset',0,10000);if(limit<1)throw new FieldError('limit','Choose a valid page size.');
 const aggregates=await store.all(`SELECT u.day, u.kind, c.model, COUNT(*) AS calls, SUM(CASE WHEN c.estimated_microusd IS NULL AND ${counted} THEN 1 ELSE 0 END) AS unknown, COALESCE(SUM(CASE WHEN ${counted} THEN c.estimated_microusd ELSE 0 END),0) AS estimated FROM ai_studio_usage u LEFT JOIN ai_studio_cost c ON c.id=u.id WHERE u.day>=? AND u.day<? GROUP BY u.day,u.kind,c.model ORDER BY u.day`,from,end);
 const items=await store.all('SELECT u.id,u.created_at,u.kind,u.outcome,c.model,c.estimated_microusd,c.price_version FROM ai_studio_usage u LEFT JOIN ai_studio_cost c ON c.id=u.id WHERE u.day>=? AND u.day<? ORDER BY u.created_at DESC,u.id DESC LIMIT ? OFFSET ?',from,end,limit+1,offset);
 return { ...await budgetStatus(store,now),range:{from,to},series:aggregates.map(r=>({day:r.day,kind:r.kind,model:r.model,calls:Number(r.calls),unknownCalls:Number(r.unknown),estimatedMicrousd:Number(r.estimated)})),items:items.slice(0,limit).map(r=>({id:r.id,at:r.created_at,kind:r.kind,outcome:r.outcome,model:r.model,estimatedMicrousd:r.estimated_microusd===null?null:Number(r.estimated_microusd),priceVersion:r.price_version})),limit,offset,nextOffset:items.length>limit&&offset+limit<=10000?offset+limit:null,priceVersion:PRICE_VERSION,invoiceConnected:false };
}

export async function budgetStorageReady(store) {
 try {
  await store.all('SELECT daily_microusd,monthly_microusd,mode,alert_percent,revision,updated_at FROM ai_studio_budget LIMIT 0');
  await store.all('SELECT id,model,tokens_json,estimated_microusd,price_version,recorded_at FROM ai_studio_cost LIMIT 0');
  await store.all('SELECT id,actor,settings_json,created_at FROM ai_studio_budget_event LIMIT 0');
  const b=await getBudget(store);return ['WARN','BLOCK'].includes(b.mode)&&Number.isSafeInteger(b.revision)&&b.revision>0;
 }catch{return false}
}
