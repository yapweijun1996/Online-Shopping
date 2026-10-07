import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openNodeStore} from '../src/store.js';
import {migrateStore,ready} from '../src/db.js';

const [open,migrate,isReady]=[openNodeStore,migrateStore,ready];
test(`Node recognizes actual divergent schema12, preserves historical orders and fails readiness on missing columns`,async t=>{
  const store=open(':memory:');t.after(()=>store.close());
  await store.exec(readFileSync(new URL('./fixtures/sqlite-repair-schema12.sql',import.meta.url),'utf8'));
  const order=await store.get('SELECT * FROM shop_order');
  const snapshot=await store.all('SELECT * FROM order_item');
  assert.equal(await store.schemaVersion(),12);
  assert.equal(await isReady(store),false);
  await migrate(store);
  assert.equal(await store.schemaVersion(),17);
  assert.equal(await isReady(store),true);
  const upgraded=await store.get('SELECT * FROM shop_order');
  assert.deepEqual({...upgraded},{...order,tracking_carrier:null,tracking_no:null});
  assert.deepEqual(await store.all('SELECT * FROM order_item'),snapshot);
  assert.equal((await store.get('SELECT stock_quantity FROM product')).stock_quantity,null);
  await store.run("UPDATE shop_order SET status='CANCELLED'");
  assert.equal((await store.get('SELECT status FROM shop_order')).status,'CANCELLED');
  await store.exec('ALTER TABLE product DROP COLUMN stock_quantity');
  assert.equal(await isReady(store),false);
});
