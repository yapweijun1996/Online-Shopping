import test from 'node:test';
import assert from 'node:assert/strict';
import { orderDocumentModel } from '../public/seller/order-document-model.js';
function fixture(){return {orderNo:'DEMO-TEST',status:'CONFIRMED',revision:3,currency:'MYR',totalMinor:3750,simulation:true,buyer:{fullName:'Synthetic buyer'},deliveries:[{recipient:{fullName:'First synthetic recipient'},address:{line1:'First address'},items:[{sku:'A',name:'First snapshot',quantity:2,priceMinor:1250,lineTotalMinor:2500,currency:'MYR'}]},{recipient:{fullName:'Second synthetic recipient'},address:{line1:'Second address'},items:[{sku:'B',name:'Second snapshot',quantity:1,priceMinor:1250,lineTotalMinor:1250,currency:'MYR'}]}]};}
test('documents preserve currency, immutable snapshots, totals and destination separation',()=>{const f=fixture(),m=orderDocumentModel(f,'packing');assert.equal(m.revision,3);assert.equal(m.totalMinor,3750);assert.equal(m.deliveries[0].quantity,2);assert.equal(m.deliveries[1].quantity,1);f.deliveries[0].items[0].name='Edited catalog';f.deliveries[0].address.line1='Changed';assert.equal(m.deliveries[0].items[0].name,'First snapshot');assert.equal(m.deliveries[0].address.line1,'First address');assert.ok(!JSON.stringify(m.deliveries[0]).includes('Second synthetic'));});
test('documents reject inconsistent amounts, currency and unsafe integers',()=>{for(const change of [f=>f.totalMinor++,f=>f.deliveries[0].items[0].currency='SGD',f=>f.deliveries[0].items[0].quantity=0,f=>f.deliveries[0].items[0].lineTotalMinor++,f=>f.revision=0]){const f=fixture();change(f);assert.throws(()=>orderDocumentModel(f));}});
test('packing requires confirmed state; summaries remain truthful for rejected/submitted and SGD',()=>{const f=fixture();f.status='REJECTED';f.events=[{status:'REJECTED',reason:'Synthetic unavailable'}];assert.throws(()=>orderDocumentModel(f,'packing'));assert.equal(orderDocumentModel(f).rejectionReason,'Synthetic unavailable');f.status='SUBMITTED';assert.equal(orderDocumentModel(f).status,'SUBMITTED');f.currency='SGD';f.deliveries.forEach(d=>d.items.forEach(i=>i.currency='SGD'));assert.equal(orderDocumentModel(f).currency,'SGD');});

test('a new order prints as a Sales Order; only a confirmed one is a Sales Order Confirmation', async () => {
  const { documentTitleKey } = await import('../public/seller/order-document-model.js');
  for (const status of ['SUBMITTED', 'REJECTED', 'CANCELLED']) assert.equal(documentTitleKey('summary', status), 'salesOrderDocument', status);
  for (const status of ['CONFIRMED', 'SHIPPED', 'DELIVERED']) assert.equal(documentTitleKey('summary', status), 'salesOrderConfirmationDocument', status);
  assert.equal(documentTitleKey('packing', 'CONFIRMED'), 'packingSheet');
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../public/shared/i18n.js', import.meta.url), 'utf8');
  for (const key of ['salesOrderDocument', 'salesOrderConfirmationDocument']) assert.equal(source.split(`"${key}":`).length - 1, 7, `${key} exists in all seven languages`);
});
