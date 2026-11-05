"""Generate and validate the proposed MCP contracts from one local source.

Run from the repository root with Python 3 and jsonschema installed. This
generator writes documentation only; it does not register or enable tools.
"""

from pathlib import Path
import json
from copy import deepcopy
from jsonschema import Draft202012Validator, RefResolver

out = Path("docs/mcp-v2")
defs = {}
def ref(name): return {"$ref": "#/$defs/" + name}
def obj(props, required=None, **kwargs):
    return {"type":"object", "properties":props, "required":list(props) if required is None else required, "additionalProperties":False, **kwargs}
def text(n=128, minimum=1, **kw): return {"type":"string", "minLength":minimum, "maxLength":n, **kw}
def array(items, maximum=50, minimum=0): return {"type":"array", "items":items, "minItems":minimum, "maxItems":maximum}
def optional(schema): return {"anyOf":[schema, {"type":"null"}]}
def result(success): return {"oneOf":[success, ref("error")]}
def preview(before, after):
    return obj({"operationId":ref("uuid"),"status":{"const":"PENDING_APPROVAL"},"previewHash":ref("hash"),
                "expiresAt":ref("instant"),"approvalUrl":text(2048,format="uri"),"before":before,"after":after,"warnings":array(text(240),20)})
def commit(item):
    return obj({"operationId":ref("uuid"),"status":{"const":"COMMITTED"},"result":item})
def page(item, extra=None):
    fields={"items":array(item),"nextOffset":optional({"type":"integer","minimum":0,"maximum":10000}),"paginationCapped":{"type":"boolean"}}
    if extra: fields.update(extra)
    return obj(fields)
defs.update({
  "uuid":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},
  "hash":{"type":"string","pattern":"^[0-9a-f]{64}$"},
  "instant":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$","format":"date-time"},
  "date":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}$","format":"date"},
  "revision":{"anyOf":[{"type":"integer","minimum":0},text(128)]},
  "idem":{"type":"string","pattern":"^[A-Za-z0-9._~-]{16,128}$"},
  "currency":{"enum":["MYR","SGD"]},
  "error":obj({"error":obj({"code":{"enum":["NOT_FOUND","INVALID_INPUT","INSUFFICIENT_SCOPE","FORBIDDEN","CONFLICT","STALE_REVISION","EXPIRED","INVALID_APPROVAL","IDEMPOTENCY_CONFLICT","RESULT_TOO_LARGE","TEMPORARILY_UNAVAILABLE"]},"message":text(160)})}),
})
company_fields={
 "defaultCurrency":ref("currency"), "sellerWhatsAppPhone":optional(text(15)),
 "mobileHideBarsOnScroll":{"type":"boolean"},
 "availabilityText":optional(text(1000,0)), "shippingText":optional(text(1000,0)), "returnsText":optional(text(1000,0)),
 "senderName":optional(text(120,0)), "senderPhone":optional(text(15,0)),
 "senderAddressLine1":optional(text(240,0)), "senderAddressLine2":optional(text(240,0)),
 "senderCity":optional(text(120,0)), "senderState":optional(text(120,0)),
 "senderPostcode":optional(text(20,0)), "senderCountry":optional(text(2,0)),
}
defs["company"]=obj({"revision":ref("revision"),**company_fields})
defs["companyChanges"]=obj(company_fields,[],minProperties=1)
option=obj({"typeId":ref("uuid"),"valueId":ref("uuid")})
stock=optional({"type":"integer","minimum":0,"maximum":1000000})
product_fields={
 "sku":text(40), "name":text(120), "description":text(2000), "category":text(80),
 "priceMinor":{"type":"integer","minimum":1,"maximum":1000000000},
 "currency":ref("currency"),"active":{"type":"boolean"},"variantGroup":optional(text(40,0)),
 "variantLabel":optional(text(80,0)),"stockQuantity":stock,"options":array(option,6)
}
defs["productCreate"]=obj(product_fields,["sku","name","description","category","priceMinor","currency","active"])
defs["productChanges"]=obj(product_fields,[],minProperties=1)
product_output_fields={**product_fields,"category":text(200),"categoryCode":text(80)}
defs["product"]=obj({"id":ref("uuid"),"revision":ref("revision"),**product_output_fields})
image=obj({"id":text(128),"sha256":optional(ref("hash")),"previewPath":text(512,pattern="^/")})
defs["layout"]=obj({"productId":ref("uuid"),"revision":ref("revision"),"images":array(image,10),"primaryId":optional(text(128))})
defs["inventory"]=obj({"productId":ref("uuid"),"revision":ref("revision"),"stockQuantity":stock,
                       "reservedQuantity":{"type":"integer","minimum":0},"availableQuantity":stock,
                       "reservationShortfall":{"type":"integer","minimum":0}})
defs["order"]=obj({"id":ref("uuid"),"status":{"enum":["SUBMITTED","CONFIRMED","REJECTED","SHIPPED","DELIVERED","CANCELLED"]},
                   "revision":{"type":"integer","minimum":1},"currency":ref("currency"),"totalMinor":{"type":"integer","minimum":0}})
defs["movement"]=obj({"id":ref("uuid"),"productId":ref("uuid"),"delta":{"type":"integer","minimum":-1000000,"maximum":1000000},
                      "reason":text(500),"occurredAt":ref("instant")})
defs["operation"]=obj({"operationId":ref("uuid"),"toolName":text(128),"resourceType":text(64),
                       "resourceId":optional(text(128)),"status":{"enum":["PREPARED","PENDING_APPROVAL","APPROVED","COMMITTED","REJECTED","EXPIRED","CANCELLED","CONFLICT","FAILED"]},
                       "previewHash":ref("hash"),"expiresAt":ref("instant"),"correlationId":ref("uuid")})
defs["auditEvent"]=obj({"at":ref("instant"),"operationId":ref("uuid"),"tenantId":text(100),"accountId":optional(ref("uuid")),
                        "clientId":optional(text(128)),"toolName":text(128),"resourceId":optional(text(128)),
                        "approverId":optional(ref("uuid")),"outcome":text(80),"correlationId":ref("uuid")})
point=obj({"key":text(160),"label":text(160),"quantity":{"type":"integer","minimum":0},"totalMinor":{"type":"integer","minimum":0}})
period=obj({"from":ref("date"),"toExclusive":ref("date")})
defs["metrics"]=obj({"metricName":text(80),"definitionVersion":text(40),"currency":ref("currency"),"timeZone":{"const":"UTC+8"},
                     "dateRange":period,"filters":obj({"groupBy":text(20)},[]),"dataPoints":array(point,366),
                     "totals":obj({"quantity":{"type":"integer","minimum":0},"totalMinor":{"type":"integer","minimum":0}}),
                     "coverage":obj({"complete":{"type":"boolean"},"note":optional(text(240))}),
                     "comparison":optional(obj({"dateRange":period,"quantity":{"type":"integer","minimum":0},
                                                  "totalMinor":{"type":"integer","minimum":0},"changeMinor":{"type":"integer"}}))})
defs["metricsResult"]=page(ref("metrics"))
defs["inventoryRisk"]=obj({"inventory":ref("inventory"),"lowStock":{"type":"boolean"},"slowMoving":optional({"type":"boolean"}),
                            "acceptedQuantityInPeriod":optional({"type":"integer","minimum":0})})
defs["inventoryRiskResult"]=page(ref("inventoryRisk"),{
    "metricName":{"const":"inventory_risk"},"definitionVersion":text(40),"currency":{"type":"null"},"timeZone":{"const":"UTC+8"},
    "asOf":ref("instant"),"slowDays":{"type":"integer","minimum":1,"maximum":366},"threshold":{"type":"integer","minimum":0,"maximum":1000000},
    "coverage":obj({"complete":{"type":"boolean"},"note":optional(text(240))})})
defs["stage"]=obj({"operationId":ref("uuid"),"status":{"const":"PREPARED"},"stageId":ref("uuid"),"uploadPath":text(512,pattern="^/"),
                   "expectedSha256":ref("hash"),"expiresAt":ref("instant")})
page_in={"limit":{"type":"integer","minimum":1,"maximum":50},"offset":{"type":"integer","minimum":0,"maximum":10000}}
id_req=obj({"operationId":ref("uuid")})
idem=ref("idem"); rev=ref("revision")
date_req={"from":ref("date"),"toExclusive":ref("date")}
u="00000000-0000-4000-8000-000000000001"; v="00000000-0000-4000-8000-000000000002"
ts="2026-11-04T00:10:00.000Z"; h="a"*64; key="synthetic-key-1234"
company={"revision":1,"defaultCurrency":"MYR","sellerWhatsAppPhone":None,"mobileHideBarsOnScroll":False,
         "availabilityText":None,"shippingText":None,"returnsText":None,"senderName":None,"senderPhone":None,
         "senderAddressLine1":None,"senderAddressLine2":None,"senderCity":None,"senderState":None,"senderPostcode":None,"senderCountry":None}
product={"id":u,"revision":1,"sku":"SYN-01","name":"Synthetic product","description":"Sample","category":"Synthetic category","categoryCode":"SYNTHETIC",
         "priceMinor":1200,"currency":"MYR","active":False,"variantGroup":None,"variantLabel":None,"stockQuantity":4,"options":[]}
layout={"productId":u,"revision":1,"images":[],"primaryId":None}
inventory={"productId":u,"revision":1,"stockQuantity":4,"reservedQuantity":1,"availableQuantity":3,"reservationShortfall":0}
order={"id":u,"status":"SUBMITTED","revision":1,"currency":"MYR","totalMinor":1200}
operation={"operationId":u,"toolName":"catalog.preview_update","resourceType":"product","resourceId":u,
           "status":"PENDING_APPROVAL","previewHash":h,"expiresAt":ts,"correlationId":v}
audit={"at":"2026-11-04T00:00:00.000Z","operationId":u,"tenantId":"synthetic-shop","accountId":v,
       "clientId":"synthetic-client","toolName":"catalog.preview_update","resourceId":u,"approverId":None,"outcome":"PREPARED","correlationId":v}
metric={"metricName":"accepted_order_value","definitionVersion":"proposed-1","currency":"MYR","timeZone":"UTC+8",
        "dateRange":{"from":"2026-11-01","toExclusive":"2026-11-02"},"filters":{},"dataPoints":[],
        "totals":{"quantity":0,"totalMinor":0},"coverage":{"complete":True,"note":None},"comparison":None}
def prv(before,after): return {"operationId":u,"status":"PENDING_APPROVAL","previewHash":h,"expiresAt":ts,
                               "approvalUrl":"https://seller.example.test/operations/"+u,"before":before,"after":after,"warnings":[]}
def cmt(item): return {"operationId":u,"status":"COMMITTED","result":item}
def pg(items,**extra): return {"items":items,"nextOffset":None,"paginationCapped":False,**extra}
product_update={**product,"name":"New name"}; company_update={**company,"shippingText":"Synthetic policy"}
inventory_update={**inventory,"stockQuantity":5,"availableQuantity":4}
order_confirmed={**order,"status":"CONFIRMED","revision":2}
specs=[]
def add(name,description,inp,success,scope,cap,kind,risk,approval,example_in,example_out,concurrency):
    specs.append((name,description,inp,result(success),scope,cap,kind,risk,approval,example_in,example_out,concurrency))

add("company.get","Read supported settings.",obj({}),ref("company"),"company.read","settings.write","read","LOW","None",{},company,"Snapshot read.")
add("company.preview_update","Prepare current settings changes.",obj({"expectedRevision":rev,"changes":ref("companyChanges"),"idempotencyKey":idem}),preview(ref("company"),ref("company")),"company.write","settings.write","write","HIGH if currency changes; otherwise MEDIUM","First-party human",{"expectedRevision":1,"changes":{"shippingText":"Synthetic policy"},"idempotencyKey":key},prv(company,company_update),"Company revision compared at prepare and commit.")
add("company.commit_update","Apply approved stored company proposal.",id_req,commit(ref("company")),"company.write","settings.write","write","HIGH if currency changes; otherwise MEDIUM","Required",{"operationId":u},cmt(company_update),"CAS and current currency policy.")
add("catalog.preview_create","Prepare one SKU using existing variant/options rules.",obj({"product":ref("productCreate"),"idempotencyKey":idem}),preview({"type":"null"},ref("product")),"catalog.write","catalog.write","write","MEDIUM","First-party human",{"product":{**{k:product[k] for k in ["sku","name","description","priceMinor","currency","active"]},"category":"SYNTHETIC"},"idempotencyKey":key},prv(None,product),"Recheck SKU, category and company currency.")
add("catalog.commit_create","Apply approved stored create proposal.",id_req,commit(ref("product")),"catalog.write","catalog.write","write","MEDIUM","Required",{"operationId":u},cmt(product),"Unique SKU and idempotent single commit.")
add("catalog.preview_update","Prepare a product patch and before/after review.",obj({"productId":ref("uuid"),"expectedRevision":rev,"changes":ref("productChanges"),"idempotencyKey":idem}),preview(ref("product"),ref("product")),"catalog.write","catalog.write","write","MEDIUM","First-party human",{"productId":u,"expectedRevision":1,"changes":{"name":"New name"},"idempotencyKey":key},prv(product,product_update),"Revision compared across Portal and MCP.")
add("catalog.commit_update","Apply approved stored product proposal.",id_req,commit(ref("product")),"catalog.write","catalog.write","write","MEDIUM","Required",{"operationId":u},cmt(product_update),"CAS and product history in same transaction.")
add("media.list","Read a product's owned gallery.",obj({"productId":ref("uuid")}),ref("layout"),"media.read","catalog.write","read","LOW","None",{"productId":u},layout,"Snapshot read.")
add("media.prepare_upload","Prepare a bounded same-origin binary staging session.",obj({"productId":ref("uuid"),"expectedRevision":rev,"mime":{"enum":["image/png","image/jpeg","image/webp"]},"sizeBytes":{"type":"integer","minimum":1,"maximum":524288},"sha256":ref("hash"),"idempotencyKey":idem}),ref("stage"),"media.write","catalog.write","write (staging)","MEDIUM","Image review before commit",{"productId":u,"expectedRevision":1,"mime":"image/png","sizeBytes":100,"sha256":h,"idempotencyKey":key},{"operationId":u,"status":"PREPARED","stageId":v,"uploadPath":"/api/v1/seller/mcp/upload/"+v,"expectedSha256":h,"expiresAt":ts},"Bound stage expires; checksum and revision rechecked.")
add("media.commit_upload","Attach only an approved staged upload.",id_req,commit(ref("layout")),"media.write","catalog.write","write","MEDIUM","Old/new image in first-party UI",{"operationId":u},cmt(layout),"Atomic gallery layout and blob association.")
add("media.preview_layout","Prepare reorder, removal or primary image selection.",obj({"productId":ref("uuid"),"expectedRevision":rev,"imageIds":array(text(128),10),"idempotencyKey":idem}),preview(ref("layout"),ref("layout")),"media.write","catalog.write","write","MEDIUM","First-party human",{"productId":u,"expectedRevision":1,"imageIds":[],"idempotencyKey":key},prv(layout,layout),"Validate ownership and shared-variant gallery.")
add("media.commit_layout","Apply approved stored gallery layout.",id_req,commit(ref("layout")),"media.write","catalog.write","write","MEDIUM","Required",{"operationId":u},cmt(layout),"CAS and atomic association rollback.")
add("inventory.summary","Read stock and computed 48-hour holds.",obj({"productId":ref("uuid")}),ref("inventory"),"inventory.read","catalog.write","read","LOW","None",{"productId":u},inventory,"Snapshot; null stock means unlimited.")
add("inventory.movements","Read bounded ledger and coverage.",obj({"productId":ref("uuid"),**page_in},["productId"]),page(ref("movement"),{"coverageStart":optional(ref("instant"))}),"inventory.read","catalog.write","read","LOW","None",{"productId":u},pg([],coverageStart=None),"No invented pre-ledger history.")
adjustment={"productId":ref("uuid"),"expectedRevision":rev,"quantity":stock,"reason":text(500),"idempotencyKey":idem}
add("inventory.preview_adjustment","Prepare a stock quantity and reason.",obj(adjustment),preview(ref("inventory"),ref("inventory")),"inventory.adjust","catalog.write","write","HIGH","First-party human",{"productId":u,"expectedRevision":1,"quantity":5,"reason":"Synthetic stocktake","idempotencyKey":key},prv(inventory,inventory_update),"CAS; preserve active submitted holds and tracking rules.")
add("inventory.commit_adjustment","Apply approved stock change and ledger atomically.",id_req,commit(ref("inventory")),"inventory.adjust","catalog.write","write","HIGH","Required",{"operationId":u},cmt(inventory_update),"CAS and movement audit in same transaction.")
decision=obj({"action":{"enum":["confirm","reject","ship","deliver","cancel"]},"reason":text(500),"carrier":text(40),"trackingNo":text(60,0)},["action"])
add("orders.preview_decision","Prepare a permitted seller decision.",obj({"orderId":ref("uuid"),"expectedRevision":{"type":"integer","minimum":1},"decision":decision,"idempotencyKey":idem}),preview(ref("order"),ref("order")),"orders.decide","orders.decide","write","HIGH","First-party human",{"orderId":u,"expectedRevision":1,"decision":{"action":"confirm"},"idempotencyKey":key},prv(order,order_confirmed),"Validate action-specific fields and current transition.")
add("orders.commit_decision","Apply approved stored order decision once.",id_req,commit(ref("order")),"orders.decide","orders.decide","write","HIGH","Required",{"operationId":u},cmt(order_confirmed),"CAS, stock, order event and operation audit atomic.")
analytics_in={**date_req,"groupBy":{"enum":["day","week","month"]},"compare":{"type":"boolean"}}
add("analytics.sales_trend","Read bounded accepted-order trends, by currency.",obj(analytics_in,["from","toExclusive","groupBy"]),ref("metricsResult"),"analytics.extended","figures.read","read","LOW","None",{"from":"2026-11-01","toExclusive":"2026-11-02","groupBy":"day"},pg([metric]),"Bound range; UTC+8 and accepted statuses.")
add("analytics.top_products","Read bounded product or category performance.",obj({**date_req,"groupBy":{"enum":["product","category"]},**page_in},["from","toExclusive","groupBy"]),ref("metricsResult"),"analytics.extended","figures.read","read","LOW","None",{"from":"2026-11-01","toExclusive":"2026-11-02","groupBy":"product"},pg([metric]),"Currency separate; totals are not cash or profit.")
add("analytics.inventory_risk","Read low stock and slow-movement risk.",obj({"threshold":{"type":"integer","minimum":0,"maximum":1000000},"slowDays":{"type":"integer","minimum":1,"maximum":366},**page_in},["threshold","slowDays"]),ref("inventoryRiskResult"),"analytics.extended","figures.read","read","LOW","None",{"threshold":5,"slowDays":30},pg([{"inventory":inventory,"lowStock":True,"slowMoving":None,"acceptedQuantityInPeriod":None}],metricName="inventory_risk",definitionVersion="proposed-1",currency=None,timeZone="UTC+8",asOf=ts,slowDays=30,threshold=5,coverage={"complete":False,"note":"Synthetic coverage only."}),"Bounded indexed query; indicate incomplete history.")
add("operations.get","Read one operation bound to the authenticated grant/client.",id_req,ref("operation"),"operations.read","underlying operation capability","read","LOW","None",{"operationId":u},operation,"Revalidate live binding.")
cancelled={**operation,"status":"CANCELLED"}
add("operations.cancel","Cancel a nonterminal operation; cannot undo a commit.",id_req,ref("operation"),"operations.cancel","underlying operation capability","write","MEDIUM","No business mutation",{"operationId":u},cancelled,"CAS against approval/commit.")
add("operations.audit","Read redacted operation audit for this grant/client.",obj({"operationId":ref("uuid"),**page_in},["operationId"]),page(ref("auditEvent")),"operations.read","underlying operation capability","read","LOW","None",{"operationId":u},pg([audit]),"Bounded and tenant/client scoped.")
schema={"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"urn:online-shopping:mcp-v2:proposed",
        "$defs":defs,"x-toolPolicies":{name:{"scope":scope,"capability":cap}
                                        for name,_,_,_,scope,cap,*_ in specs}}
for name,desc,inp,output,*_ in specs:
    defs[name+".input"]=inp
    defs[name+".output"]=output
Draft202012Validator.check_schema(schema)
resolver=RefResolver.from_schema(schema)
for name,desc,inp,output,scope,cap,kind,risk,approval,example_in,example_out,concurrency in specs:
    Draft202012Validator(inp,resolver=resolver).validate(example_in)
    Draft202012Validator(output,resolver=resolver).validate(example_out)
(out/"03-TOOL-CONTRACTS.proposed.json").write_text(json.dumps(schema,indent=2,ensure_ascii=False)+"\n")
md=["# MCP v2 tool contracts", "",
"## Implemented company subset (isolated, default-off)", "",
"`company.get`, `company.preview_update` and `company.commit_update` use the implemented contracts in [03-COMPANY-IMPLEMENTED.json](03-COMPANY-IMPLEMENTED.json), generated by `node docs/mcp-v2/export-company-contracts.mjs` from `companyReadTool()` / `companyMutationTool()` in `src/mcp/company-tools.js` and the shared registry in `src/mcp/operation-tools.js`.", "",
"The actual company revision is a SHA-256 string; preview arguments wrap `{input:{expectedRevision,changes},idempotencyKey}`. Before/after values appear only in first-party review. Commit returns a minimal receipt, never the complete company object. Every company mutation is HIGH risk and OWNER-only; actual currency changes additionally require explicit human acknowledgment. See [COMPANY-TOOLS.md](COMPANY-TOOLS.md) for current fields, errors, examples and activation limits. Historical company candidates remain only in the proposed JSON bundle and are not the implemented API.", "",
"## Remaining 21 tools: proposed", "",
"The historical JSON bundle still includes three superseded company candidates for traceability; only the separate implemented company bundle is authoritative for those names.", "",
"Generated from `generate-contracts.py`; change that source and regenerate both this document and its JSON Schema bundle together.",
"",
"**PROPOSED, NOT IMPLEMENTED OR DEPLOYED.** The contract bundle and examples are design candidates, not evidence that a tool, scope, approval flow, migration or endpoint exists. Resolve every open issue and validate against existing services before exposing a tool.",
"",
"Machine-readable complete JSON Schemas: [03-TOOL-CONTRACTS.proposed.json](03-TOOL-CONTRACTS.proposed.json). Each input and output below refers to a definition in that bundle; output schemas include the common error object. Existing eight v1 schemas are authoritative in `src/mcp/tools.js` and remain unchanged.",
"",
"All tool calls bind tenant, account, OAuth client and resource from authenticated server context; no input field selects an authority. A preview accepts an idempotency key and captures immutable server-validated changes; same key plus same intent replays the result, different intent conflicts. Commit takes only the server operation ID, rechecks authorization/approval/revision and executes stored values once. Read operations have no side effects. All operation/audit output excludes secrets, raw personal data and raw images. Approval URL is server-generated, constrained to the seller origin and must be opened by a human through the first-party Seller Portal.",
"",
"Common proposed errors: `NOT_FOUND`, `INVALID_INPUT`, `INSUFFICIENT_SCOPE`, `FORBIDDEN`, `CONFLICT`, `STALE_REVISION`, `EXPIRED`, `INVALID_APPROVAL`, `IDEMPOTENCY_CONFLICT`, `RESULT_TOO_LARGE`, `TEMPORARILY_UNAVAILABLE`. OAuth/protocol failures may use the existing transport errors instead.",
"",
"Common acceptance tests for each tool: valid input, malformed input, missing auth, scope and role denial, cross-tenant/unknown resource, bounded/schema-valid response and metadata-only audit. Every mutation additionally needs stale revision, approval mismatch/expiry/replay, idempotency/concurrency, failure/rollback and audit atomicity on both databases. Phase-specific tests are in [07-TEST-PLAN.md](07-TEST-PLAN.md).",
"",
"**Open contract issues:** metric pagination/comparison, exact before/after field projections, image-byte staging protocol and authenticated image preview, tool-specific TTL/retention and product revision design require implementation-level review. For tracked stock the proposed inventory projection reports available units as `max(0, stockQuantity - reservedQuantity)` and separately reports `reservationShortfall=max(0, reservedQuantity - stockQuantity)`; null stock remains unlimited. These are display projections, not a change to existing hold or confirmation rules. In particular, `media.prepare_upload` only stages: binary bytes must arrive through its same-origin bounded upload path, be fully decoded and checksum-verified before a first-party approval can be granted. Uploaded data is never a path or remote URL supplied by the model. A `PREPARED` stage is not approval.",
""]
for name,desc,inp,output,scope,cap,kind,risk,approval,example_in,example_out,concurrency in specs:
    if name.startswith("company."): continue
    md += ["## `"+name+"`","",desc,
           "",f"- Input JSON Schema: `#/$defs/{name}.input`.",
           f"- Output JSON Schema: `#/$defs/{name}.output`.",
           f"- OAuth scope: `{scope}`; RBAC: `{cap}`.",
           f"- Classification: {kind}; risk: {risk}; approval: {approval}.",
           f"- Tenant binding, idempotency and audit: common rules above. Concurrency: {concurrency}",
           "- Acceptance: common matrix above plus the matching phase test plan.","",
           "Example arguments: `"+json.dumps(example_in,ensure_ascii=False,separators=(",",":"))+"`",
           "",
           "Example structured result: `"+json.dumps(example_out,ensure_ascii=False,separators=(",",":"))+"`",""]
(out/"03-TOOL-CONTRACTS.md").write_text("\n".join(md))
print("Generated",len(specs),"proposed contracts; all input and output examples match their schemas.")
