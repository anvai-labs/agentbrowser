# ADR-014: npm Distribution for the MCP Server (Trusted Publishing, `@anvailabs` scope)

**Status:** Accepted
**Context:** 2026-09-03
**Related:** [TD-BROWSER-5](../td/TD-BROWSER-5-single-binary-mcp-distribution.md) (bun-compiled
binaries), [ADR-009](009-mcp-high-level-tools.md) (the MCP surface),
anvai-labs/sandhi's RELEASING.md + release workflow (the pattern mirrored here)

## Context

The MCP server ships today as bun-compiled single binaries on GitHub Releases (TD-BROWSER-5) —
the right shape for standalone/no-Node users, and unchanged. But the typical consumer of an MCP
server already runs Node and an MCP client; for them, `npm i -g` is the expected install, and its
absence is friction. Meanwhile the org has standardized npm publishing on **OIDC Trusted
Publishing** (sandhi ships PyPI and npm this way): no token exists anywhere to leak, rotate, or
scope, and the binding — (repository, workflow filename, environment) — *is* the authorization.

The `agentbrowser` name is not owned as an npm org, and chasing it is unnecessary: the org
publishes under **`@anvailabs`** (GitHub `anvai-labs/*` ↔ npm `@anvailabs/*`, one estate; sandhi
already ships as `@anvailabs/sandhi`).

## Decision

1. **The MCP server publishes to npm as `@anvailabs/agentbrowser-mcp`** — the plain-JS package
   (`dist/bin.js`, no platform binaries: it is a thin HTTP proxy to an AgentBrowser service;
   Node ≥ 18 required). The package is a rename of the internal `@agentbrowser/mcp-server`
   (nothing in the monorepo imports it by name; internal workspace references are unaffected).
2. **Two channels, one source**: npm for Node users; bun-compiled GitHub-Release binaries for
   standalone/no-Node users. Both build from the same tree; the tag-guard (tag == package
   version) keeps them from drifting.
3. **The server (`@agentbrowser/api`) is NOT published to npm** — it stays fat-tarball + Docker
   self-build: Playwright is bundler-hostile and the server carries real runtime weight; a
   registry package would promise an install experience we cannot honor. Recorded so the
   question does not reopen casually.
4. **Publishing is OIDC Trusted Publishing**: npm Trusted-Publisher binding pins repository
   `anvai-labs/agentbrowser`, workflow `release.yml`, environment `npm`. The workflow's publish
   job mints the assertion (`id-token: write`) and publishes with **npm ≥ 11** (which speaks
   OIDC) from a **pnpm-packed tarball**.
5. **The npm package is bundled and dependency-free.** The monorepo's internal dependencies
   (`@agentbrowser/protocol`, `@agentbrowser/sdk-typescript`) are private workspace packages that
   do not exist on npm — pnpm's `workspace:*` resolution at pack time would emit version pins
   for packages no one can install (found during the local dry-run pack, before any publish).
   The build therefore bundles (esbuild) the dist into self-contained files and the package
   carries **zero runtime dependencies**; the internal deps stay devDependencies. The shipped
   tarball's own extracted `dist/bin.js` passes the full MCP stdio smoke — verified locally
   before the first publish. The bun-compile channel was already a proof the code bundles.
6. **Verification is enforced, not token-keyed** (sandhi's lesson): the release workflow checks
   the npm registry for the tag's version after publishing, and that check is unconditional —
   it never consults a token's existence to decide whether to look.
7. **Publishing hygiene**: `files: ["dist"]` whitelist (an unlisted package tree once swallowed
   a 1.8 GB build dir in the sibling repo — never again, anywhere), `publishConfig.access:
   public`, `prepublishOnly` = the full build (type-check + bundle; inert for CI tarball publishes, live for directory-context publishes like the bootstrap).

## Consequences

- `npm i -g @anvailabs/agentbrowser-mcp` becomes the primary install for Node users; the binary
  needs an AgentBrowser service reachable at `AGENTBROWSER_BASE_URL` (documented in the package
  README, which npm displays).
- One-time setup: the npm Trusted Publisher registration (owner-side, in the npm UI) and a
  GitHub environment named `npm`. A bootstrap publish from a short-lived local token bridges the
  chicken-and-egg of binding a not-yet-existing package name; the token is retired immediately
  after (same procedure sandhi used).
- Version numbering continues from the binary lineage (1.7.0 is the first npm-carried release);
  the tag-guard enforces tag == version for both channels.
- A CHANGELOG.md is adopted (Keep-a-Changelog, org consistency), seeded from the tag history.
