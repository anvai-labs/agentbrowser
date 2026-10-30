# T10 M5 bounty workflow qualification

Base: `5296497f5f95e7a8d81a74efa3d006ba62fd6ef7` (`develop`).
All traffic qualification uses local fixtures. The original live-program
artifacts remain researcher-owned outside this repository.

## Author adversarial pass

This is the author's pre-merge falsification record, not independent approval.
An independent adversarial review remains required before merge.

| Finding | Falsifying evidence | Resolution |
| --- | --- | --- |
| Source credentials crossed a GET redirect when marker injection supplied full request headers | Adding a source-only cookie to the real Chromium fixture made both 307/303 cases fail: the `localhost` destination received the `127.0.0.1` cookie | Redirect overrides omit cookies/Host so the context selects destination cookies. Origin changes permanently remove Authorization and proxy authorization. The fixture verifies source credentials at the first hop, destination cookies at the other host, and no resurrected authorization after a return to the original host |
| Generated MCP and REST catalogs stale after schema additions | MCP digest check and the full API suite's byte-fresh OpenAPI check rejected the committed artifacts | Regenerated the MCP catalog and `openapi.json` from the built protocol surfaces; freshness checks pass |
| Native POST overrides can be reapplied across redirects | During implementation, a top-level form fixture reached an unbound host carrying the marker when `route.continue({headers})` was used | Native bodies now use the existing CDP guard's per-hop overrides, including the initial hop; 307/303 fixtures verify stripping and re-injection across hosts |

The author pass also checked header name/value bounds, CR/LF refusal, unknown
scope fields, marker spoofing, floor/base composition, unsupported engines and
downloads, marker-value withholding, export replacement permissions, and
page-local navigation denial attribution. No network permission was added.

## Local gates

Qualified on macOS with the repository's pinned Playwright Chromium using an
isolated feature worktree and an offline frozen-lockfile install. Commands:

```sh
pnpm build
pnpm -r type-check
pnpm -r lint
pnpm --filter @agentbrowser/protocol --filter @agentbrowser/core --filter @agentbrowser/policy --filter @agentbrowser/cli test
pnpm --filter @agentbrowser/api test -- research-identity-real-chromium.test.ts research-identity.test.ts scope-navigation-diagnostics.test.ts scope-status-routes.test.ts scope-subcode-projection.test.ts scope-lanes.test.ts session-diagnostics.test.ts page-create-navigation.test.ts engagement-ledger.test.ts engagement-ledger-real-chromium.test.ts
pnpm --filter @agentbrowser/engine-playwright test -- body-redirect-guard.test.ts scope-enforcement.test.ts
pnpm --filter @anvailabs/agentbrowser-mcp test -- session-inspection.test.ts mcp-server.test.ts
node scripts/check-doc-links.mjs .
node scripts/spec-context.mjs --check
node scripts/layering-ratchet.mjs
node scripts/duplication-ratchet.mjs
node scripts/exports-ratchet.mjs
node scripts/mcp-catalog-docs.mjs
```

Fixture servers, browser contexts and temporary ledgers are closed in `finally`.
The new listener binds loopback explicitly and rejects startup errors. A local
sandbox denial of the fixture listener was diagnosed as `listen EPERM`; the
browser check was rerun with loopback access rather than skipped.

## Remaining merge gates

The final PR head must pass every configured required GitHub check and the
independent adversarial review. Local tests do not replace Linux, packaging,
Docker, benchmark, journal or documentation CI qualification. Existing scope
coverage boundaries, including unqualified worker/WebSocket lanes, remain as
documented in the T7 design.
