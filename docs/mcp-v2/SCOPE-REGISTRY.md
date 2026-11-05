# Private tool scope requirements

The operation registry exposes `requiredScopes(name)` only to server code. It
derives a frozen list from the fixed source policy and the constructor-owned
adapter media marker. A tool's public definition, schema and annotations do not
contain this metadata. Registration does not accept a `requiredScopes` or media
marker argument from an MCP client.

`tools/list` requires every listed scope in both the current effective grant and
the access token. Effective grants retain the existing explicit consent, account,
epoch and identity checks. `tools/call` applies the same scope intersection before
dispatch; an incomplete grant receives OAuth `403 insufficient_scope`, whose
`WWW-Authenticate` header lists the complete fixed requirement in policy order.
Missing, duplicate, unknown or malformed private requirements fail closed. There
is no fallback to a tool's base scope when the private query is unavailable.

Legacy eight tools retain their single-scope filtering and exact definitions.
Ordinary catalog descriptors still require only `catalog.write`; direct media
descriptors retain their existing `media.read` or `media.write` requirements.
Operation controls expose their fixed control scope; each actual call separately
resolves and checks every underlying original-operation scope and capability.
Scope preflight does not replace those resource, transaction, tenant, revision,
approval or commit-time authorization checks.

The engine's `DIRECT`-only media registration guard remains unchanged. The
reserved catalog-media policy cannot be registered by this foundation. Its
metadata describes `catalog.write` plus `media.write`, but describing that pair
does not activate an adapter, flag, default tool, human review or business write.

The focused test uses actual fresh OAuth/PKCE/password/consent/token handlers and
both database implementations. A standalone protocol fixture with constructor
owned dual-scope metadata proves list/call filtering, malformed metadata denial,
closed authority arguments and revoked-token denial. That fixture never enters
the application's default registry or business engine and supplies no approval.
It is transport evidence, not catalog-media execution acceptance. Separate tests
verify the actual registry's immutable private metadata, public definitions and
continued rejection of unknown/RESERVED adapters. The actual default 32-tool
test checks the seven committed contract artifacts and legacy eight definitions.

There is no migration or stored-data change. Rollback requires restoring this
registry/protocol change together before any future multi-scope adapter is
enabled. Production activation, reserved catalog-media execution and coordinated
deployment acceptance remain outside this foundation.
