import { writeFile } from 'node:fs/promises';
import { OPERATION_CONTROL_CONTRACTS } from '../../src/mcp/operation-control-contracts.js';
import { OPERATION_SCOPE_POLICIES } from '../../src/mcp/operation-policy.js';
const definitions={},policies={};
for(const [name,contract] of Object.entries(OPERATION_CONTROL_CONTRACTS)) {
  definitions[name+'.input']=contract.inputSchema;definitions[name+'.output']=contract.outputSchema;
  policies[name]={scope:OPERATION_SCOPE_POLICIES[name].scope,risk:'LOW',requiredUnderlyingPolicy:'Every source-owned scope and current capability of the target original-grant operation; separate consent must precede operation creation.'};
}
await writeFile(new URL('./03-OPERATIONS-IMPLEMENTED.json',import.meta.url),JSON.stringify({$schema:'https://json-schema.org/draft/2020-12/schema',
  $id:'urn:online-shopping:mcp-v2:operations:implemented',$comment:'Actual source schemas. Isolated default-off v2 only; low-risk abort never applies or undoes commerce. No authorization is conferred by metadata.',$defs:definitions,'x-toolPolicies':policies},null,2)+'\n');
