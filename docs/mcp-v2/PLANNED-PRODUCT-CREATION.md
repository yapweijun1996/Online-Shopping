# Planned product creation foundation

This internal business primitive prepares future catalog CREATE effects with
server-owned IDs. It registers no MCP tool, enables no policy, proves no authority
or human approval, and adds no draft/reservation table. Ordinary `createProduct`
retains its random-ID path and service write order.

`plannedProductCreationIdentity` accepts exactly:

```js
{ version: 1, productId, targetCode, targetListingId, newListingId }
```

All IDs are canonical lowercase UUID strings. For an existing group, `targetCode`
is the canonical group code, `targetListingId` is the actual listing UUID and
`newListingId` is null. For a new/private listing, `targetListingId` is null and
`newListingId` is a server-generated UUID; `targetCode` may be null for a private
listing. Extra, inherited, accessor and symbol fields are rejected. The validated
identity is an immutable copy, not an authorization token.

`planProductCreationListing(read, normalizedInput, context)` performs SELECT-only
checks against the actual listing plan. The planned product ID must be absent,
the target code/ID and existing/new outcome must agree, and a new listing ID must
also be absent. A conflict produces `PRODUCT_CREATE_PLAN_CONFLICT` with status409;
it never adopts an appearing code or allocates a replacement UUID.

`preparePlannedProductCreate(read, input, context)` uses the ordinary product,
category, currency, uniqueness and options validators. It accepts only existing
create metadata fields, including initial nullable `stockQuantity`. Image,
thumbnail, gallery, stage, byte, ID and context fields cannot enter its input.
Preparation returns normalized create input and resolved options/derived label;
the actual listing plan still determines shared title/description/category.
It makes no writes and does not reserve the proposed IDs.

Options validation uses the actual absent, non-null planned product UUID. Passing
null to the existing group-exclusion predicate does not establish that a new SKU
may omit structured options. The preparation helper validates active dictionaries,
same type sets and duplicate combinations through the existing option service.

`applyPlannedProductCreate(store, input, context)` owns a writer transaction and
repeats live checks there. It enters the same product creation executor as the
ordinary service: actual listing/product creation, initial inventory coverage and
movement, options, shared-gallery handling and final product read. Its internal
listing helper repeats the exact target lookup before application. UUID/code
conflicts fail closed; no ghost row or random/adoption fallback exists.

The real service still computes `created_at` at commit as the maximum of current
time and the latest group member plus1ms. The context cannot supply a timestamp.
Existing-group copy adoption, oldest gallery holder, main-copy/thumbnail behavior
and existing member stock remain the original service behavior.

Callers remain responsible for current tenant/grant/RBAC, complete revisions,
immutable proposals, image review, approval and operation audit. They supply the
existing trusted inventory context and `trackCreate` wrapper for actor/client/
grant/operation/correlation attribution and product history. Creation initializes
stock once; modifying existing stock remains the separate inventory operation.

The regular seller HTTP route continues calling ordinary `createProduct` and
rejects ID/context fields. This foundation changes no route, registry, flag,
engine, image contract or projection. Future full CREATE integration needs its
own fixed dual-scope/HIGH policy and actual first-party approval acceptance.
