import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewFixture } from './helpers/mcp-review-fixture.js';
import { freshCatalogAccess,legacyCatalogScopes } from './helpers/mcp-catalog-default-grant.js';
import { MEDIA_STORAGE_TABLES } from '../src/mcp/media-schema.js';
import { catalogue } from '../src/mcp/tools.js';
for(const dialect of ['sqlite','postgres'])test(`${dialect}: schema31 exposes no media tool or upload authority even with explicit fresh media scope consent`,
  {skip:dialect==='postgres'&&!process.env.SHOP_TEST_DATABASE_URL},async t=>{
    const f=await reviewFixture(t,dialect,{operationTools:undefined,config:{mcpRedirectUris:['https://client.example.com/catalog-callback']}});
    const client=await freshCatalogAccess(f,legacyCatalogScopes+' media.read media.write');
    assert.deepEqual((await client.rpc('tools/list',{})).data.result.tools,catalogue.map(({scope:_scope,...tool})=>tool));
    for(const name of ['media.list','media.prepare_upload','media.commit_upload','media.preview_layout','media.commit_layout'])assert.equal((await client.call(name,{})).data.error.code,-32602,name);
    for(const table of MEDIA_STORAGE_TABLES)assert.equal((await f.store.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,0,table);
  });
