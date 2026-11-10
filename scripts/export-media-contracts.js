import { writeFileSync } from 'node:fs';
import { MEDIA_TOOL_CONTRACTS } from '../src/mcp/media-contracts.js';
import { MEDIA_TOOLS_ACCEPTED } from '../src/mcp/media-tools.js';
import { MEDIA_LIMITS } from '../src/mcp/media-schema.js';
import { operationAuthorityPolicy } from '../src/mcp/operation-policy.js';
const productId='00000000-0000-4000-8000-000000000001',stageId='00000000-0000-4000-8000-000000000002',operationId='00000000-0000-4000-8000-000000000003',sha='a'.repeat(64);
const examples={
 'media.upload_file':[{productId,targetSlot:'MAIN',expectedRevision:sha,idempotencyKey:'documented-file-shape-0001',file:{file_id:'synthetic-file',download_url:'https://files.oaiusercontent.com/synthetic-not-downloadable',mime_type:'image/png'}}],
 'media.list':[{productId,limit:5,offset:0}],
 'media.prepare_upload':[
  {input:{action:'begin',productId,targetSlot:'MAIN',expectedRevision:sha,sourceSha256:sha,sourceMime:'image/png',declaredBytes:1,idempotencyKey:'documented-begin-shape-0001'}},
  {input:{action:'append',stageId,offset:0,dataParts:['iQ==']}},
  {input:{action:'seal',stageId,idempotencyKey:'documented-seal-shape-0001'}},
  {input:{action:'discard',stageId}},
 ],
 'media.commit_upload':[{operationId}],
 'media.preview_layout':[{input:{productId,expectedRevision:sha,gallery:[{id:'main'}],removeMain:false},idempotencyKey:'documented-layout-shape-0001'}],
 'media.commit_layout':[{operationId}],
};
const output={status:MEDIA_TOOLS_ACCEPTED?'development-feature-off-by-default':'explicit-factory-candidate-default-ineligible',production:'blocked',
 note:'Examples demonstrate closed argument shapes only. Replace synthetic IDs/hashes/bytes with real owned resources and complete validated source bytes; they do not provide authorization or demonstrate successful approval.',
 limits:{requestBytes:65536,stringCharacters:4096,responseBytes:262144,readDtoBytes:65536,stage:MEDIA_LIMITS},
 tools:Object.entries(MEDIA_TOOL_CONTRACTS).map(([name,contract])=>({name,scope:operationAuthorityPolicy(name).scope,capability:operationAuthorityPolicy(name).capability,
 risk:name==='media.list'?null:'HIGH',...contract,examples:examples[name]}))};
writeFileSync(new URL('../docs/mcp-v2/03-MEDIA-IMPLEMENTED.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
