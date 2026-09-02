# Engines

AgentBrowser is engine-neutral by contract: every engine implements the
`BrowserEngine` interface (`packages/engine`), and
`runEngineContractSuite` (`packages/testkit`) is the single verification
mechanism. An engine is correct exactly insofar as the suite passes;
where it does not, the failure names the gap - never hidden, never
worked around silently.

## Engine matrix

| Engine | Package | Status | Contract suite | Egress choke point |
| --- | --- | --- | --- | --- |
| Chromium (local) | `engine-playwright` | Production default | Pass | Enforced (per-request proxy, per-hop redirects, DNS-resolved-IP validation) |
| Chromium (remote CDP) | `engine-playwright` (`cdpEndpoint`) | Supported | Pass | Enforced as above (subject to the remote endpoint's own network position) |
| Firefox / WebKit | `engine-playwright` (`browser:`) | Supported (availability-gated in CI where browsers are installed) | Pass | Enforced |
| FakeEngine | `testkit` | Deterministic reference | Pass (reference) | N/A (no network) |
| Obscura v0.2.1 | `engine-obscura` | **Experimental, benchmark-only** (spec §17.2 backend #3) | Pass (data: URLs) | **NOT enforceable** - see below |
| Safari (real, via safaridriver) | `engine-safari` (TD-BROWSER-7 Phase 2) | **Planned** - macOS only, always headed, `safaridriver --enable` required | Planned (gated on macOS + enablement) | **NOT enforceable** - requests with a policy fail loudly (`EGRESS_UNSUPPORTED`) |

## Engine registry (TD-BROWSER-7 Phase 1)

`AgentBrowserService` accepts named auxiliary engines
(`ServiceDependencies.engines`); `createSession` routes by the request's
`engine` field. Absent/`"auto"` resolves to the primary engine; an unknown
name fails loudly (`ENGINE_NOT_FOUND`) - a session never silently runs on a
different engine than the one requested.

## Obscura (experimental)

[Obscura](https://github.com/h4ckf0r0day/obscura) is a Rust headless
engine with an embedded V8 and no Chromium, speaking CDP over a
WebSocket. It is integrated per spec §17.2 as an optional experimental
adapter and comparative-benchmark target - **not** as a production
engine. The adapter composes the existing CDP path
(`PlaywrightChromiumEngine({ cdpEndpoint })`); no Rust code enters this
repository, and the Bun-compiled MCP binary is unaffected.

### Running it

```bash
# Download the pinned release into .cache/obscura/ (SHA-256 verified,
# cached; env overrides: OBSCURA_VERSION, OBSCURA_BIN).
node packages/engine-obscura/scripts/fetch.mjs

# Env-gated suites (auto-skip when the binary is absent):
pnpm --filter @agentbrowser/engine-obscura test

# Comparative benchmark with the informational Obscura row:
pnpm bench:real
```

Programmatically: `createObscuraEngine({ launch, egress })` starts the
server (ephemeral port, loopback), connects over CDP, and returns
`{ engine, server, shutdown }`. `shutdown()` disconnects AND kills the
process (Playwright's close only disconnects a connected browser).

Obscura blocks private/loopback IPs by its own SSRF defense by default;
tests and benchmarks that use loopback fixtures launch it with
`--allow-private-network` (our own policy remains the intended
authority - see the gap below for why it currently is not).

### What works (probe-verified 2026-08-29, v0.2.1)

- Process lifecycle: launch, CDP endpoint discovery, teardown with zero
  orphans.
- The **full engine contract suite** on data: URLs: capabilities,
  session/page lifecycle, navigate, semantic observation (named
  elements, canonical fingerprints), resolve, act-through-ref with
  monotonic revisions, untargeted actions, screenshots.
- Raw navigation and observation **without request interception**:
  pages load (~10 ms), aria snapshots are fast (30-50 ms), elements are
  named.

### Named gaps (probe-verified 2026-08-29, v0.2.1)

All share one root cause: Obscura's Fetch-domain implementation does
not hold up under Playwright's request interception. The service always
installs a request policy on its engine, so **every service deployment
hits these**:

1. **Egress policy is NOT enforced.** `Fetch.fulfillRequest` is
   accepted but ignored: after the pause, Obscura re-fetches the URL
   from its own network stack regardless of the handler's decision. A
   policy-denied navigation is still sent to the denied host (verified
   with an instrumented fixture: the denied URL is hit twice) and
   reports `success`. The only network guard left is Obscura's own
   private-IP block.
2. **Redirect targets escape the policy check** (the audit-bypass
   shape): `route.fetch` ignores `maxRedirects: 0` and follows 302s
   inside Obscura's network stack, fetching the redirect target before
   the Location check can deny it.
3. **Observations degrade to name-less and 30x slower under
   interception**: with the Fetch domain enabled, `ariaSnapshot` times
   out at Playwright's 30 s default on every call; the engine's
   fallback scrape still finds elements but cannot derive names, so
   ref-loops that select elements by name fail. (Without interception,
   aria snapshots work fine - the timeout is specific to the enabled
   Fetch state.)
4. Subresources (img/script/in-page fetch) are never fetched at all in
   the default build - no subresource exfiltration channel today, but
   also no subresource rendering.
5. Documented upstream gaps: no video/tracing, storageState limited,
   service workers incomplete, raster PDF, shared V8 isolate (one
   page's CPU-bound JS blocks others), file uploads need
   `--allow-file-access`.

These are encoded in `packages/engine-obscura/src/obscura-egress.test.ts`:
the two deny-path tests skip with the gap named, and a **truth guard**
asserts the current bypass behavior (denied URL fetched + `success`
reported) so an upstream fix flips the guard red and prompts removing
the skips. The gap is also recorded in `docs/threat-model.md`.

### Posture

Obscura remains what the spec calls it: an optional experimental
adapter and benchmark target feeding §17.2 comparative data (see
`docs/benchmarks.md`). It must not be used where egress enforcement is
required. Re-evaluate when upstream honors `Fetch.fulfillRequest` and
`maxRedirects` under interception - the CI job (`obscura`) will surface
that change through the truth guard.
