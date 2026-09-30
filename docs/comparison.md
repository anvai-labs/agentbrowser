---
hide:
  - navigation
---

# AgentBrowser vs Chrome debug mode & Claude integrations

This page exists so nobody has to guess. It compares AgentBrowser with the
three tool stacks a practitioner would actually weigh it against — raw
Chrome DevTools debugging, Google's chrome-devtools-mcp, and Anthropic's
Claude browser integrations — and it keeps AgentBrowser's own documented
footguns in the picture. **Every claim about AgentBrowser cites the repo's
own docs or tests; every claim about the others cites their published
sources.** Items we could not verify are marked.

Ground rule: AgentBrowser's security story is *falsifiable by design* —
the repo ships tests that assert its gaps exist rather than hiding them
(see [Ugly](#agentbrowser-good-bad-ugly)). That is the standard this page
holds the others to as well.

## Ground truth per subject

### AgentBrowser (this repo)

A session-based browser **service** for agents: REST+WebSocket on a
loopback port with hashed multi-tenant bearer keys and per-route ownership
checks ([operations](operations.md), [threat model](threat-model.md));
semantic accessibility observations bounded to ~300 elements and byte
budgets, with untrusted-content flagging and screenshots/PDF as opt-in
evidence only ([ADR-003](adr/003-headless-first-semantic-observations.md));
server-managed refs `e<rev>_<ordinal>` re-checked against page revision
and fingerprint before every action, typed `STALE_TARGET`, never
auto-retried ([ADR-004](adr/004-stable-element-refs-revision-checking.md));
a network egress layer with SSRF defaults ([ADR-006](adr/006-network-egress-policy-ssrf.md));
single-use approval tokens bound to session/revision/fingerprint;
delegated human-in-the-loop sessions ([delegated sessions](delegated-sessions.md));
four surfaces (REST/OpenAPI, TS SDK, CLI, MCP stdio with 16 tools) with
`evaluate()` and raw network tools **deliberately excluded**
([ADR-009](adr/009-mcp-high-level-tools.md), [catalog](mcp-tool-catalog.md));
an engine-neutral contract with a loud engine matrix
([engines](engines.md)); headed sessions with branded-Chrome
de-fingerprinting and an explicit refusal to arms-race CDP-fingerprinting
walls ([ADR-013](adr/013-headed-sessions-and-walled-logins.md)).

### Raw CDP / chrome debug mode

Chrome's DevTools protocol (`--remote-debugging-port`, inspected via
`chrome://inspect`). An agent connecting to the debug port gets
**everything**: arbitrary page JavaScript (`Runtime.evaluate`), full DOM
read/write, network bodies and `Fetch` interception, console, tracing and
performance metrics, httpOnly cookies, screenshots, synthetic input
([DevTools protocol](https://chromedevtools.github.io/devtools-protocol/),
[remote debugging](https://developer.chrome.com/docs/devtools/remote-debugging)).
The protocol has **no** staleness guard (raw node handles), no egress
policy, no approval gates, no tenancy, no output bounding. Security-wise
the port binds localhost but *any local process* can connect and dump all
cookies including httpOnly
([cookie-dumping walkthrough](https://specterops.io/blog/2020/12/17/hands-in-the-cookie-jar-dumping-cookies-with-chromiums-remote-debugger-port/));
since Chrome 136 the flag is **ignored for the default user-data-dir**
precisely because it was abused for cookie theft
([Chrome announcement](https://developer.chrome.com/blog/remote-debugging-port)).

### chrome-devtools-mcp (Google)

Google's official DevTools MCP server (September 2025,
[announcement](https://developer.chrome.com/blog/chrome-devtools-mcp)):
`npx chrome-devtools-mcp@latest`, driving real Chrome via Puppeteer/CDP.
About 35 tools: accessibility snapshots with `uid` refs (stale uid yields a
typed "no longer exists" error, but there is no revision counter),
`evaluate_script`, performance traces and insight analysis, Lighthouse
audits, network request listing, console tools, screenshots/screencast,
emulation
([tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)).
Its own security note is explicit: URL patterns are "optional guardrails,
not a complete network sandbox — an OS/VM sandbox is recommended", input
validation belongs to the MCP client, it is a single-user local server,
and attaching to your running Chrome gives access to all windows of the
selected profile. Usage statistics are on by default.

### Claude browser integrations (Anthropic)

Claude in Chrome: an extension where Claude works **inside the user's own
logged-in Chrome** via a sidepanel
([announcement](https://claude.com/blog/claude-for-chrome)), with
per-action approval, site-level "Always allow" permissions, and prohibited
action classes (purchases, account creation, card data, deletions,
following instructions from web content)
([permissions guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)).
Anthropic publishes measured prompt-injection results: 23.6% → 11.2%
attack success at launch, 1% with Opus 4.5 — which they still call
"meaningful risk"
([injection defenses](https://www.anthropic.com/research/prompt-injection-defenses)).
GA to paid plans with a Claude Code integration (`--chrome`) in December
2025; the extension is Chrome-only
([Claude Code docs](https://code.claude.com/docs/en/chrome)). No hosted
sessions, no multi-tenancy, no egress-policy layer — the trust model is
user permission in a consumer profile.

## Capability table

| Capability | AgentBrowser | Raw CDP | chrome-devtools-mcp | Claude in Chrome / `--chrome` |
| --- | --- | --- | --- | --- |
| Semantic element refs | Yes — protocol-level, opaque ([ADR-004](adr/004-stable-element-refs-revision-checking.md)) | No — raw node handles | Yes — `uid` per snapshot | Internal; user sees actions, not refs |
| Staleness protection | Revision + fingerprint check, typed `STALE_TARGET`, never auto-retried ([ADR-004](adr/004-stable-element-refs-revision-checking.md)) | None | Typed stale-uid errors; no revision counter | UNVERIFIED internals |
| Egress + SSRF policy | Default-on deny lists — **partial enforcement, see ugly** ([ADR-006](adr/006-network-egress-policy-ssrf.md), [threat model](threat-model.md)) | None | Explicitly "not a sandbox" (their SECURITY.md) | None documented |
| Approval gates | Single-use tokens bound to session/rev/fingerprint; "records caller confirmation; does not independently authenticate a human" | None | None — "the AI agent or client validates input" (their SECURITY.md) | Yes — human-visible per-action approval, site permissions, prohibited classes |
| Isolation + multi-tenancy | Ephemeral isolated contexts, hashed tenant keys, per-route ownership; OS isolation not shipped ([threat model](threat-model.md)) | None | Single user, one Chrome | Consumer profile, no tenancy |
| Visual + performance debugging | None — no JS eval, console, network inspection, or traces (deliberate: [ADR-009](adr/009-mcp-high-level-tools.md)) | Full (Tracing, Performance, Console, Network) | First-class (traces, insights, Lighthouse, screencast) | Console/DOM via `--chrome` |
| Token efficiency | Bounded by design: ~300 elements, byte budgets, truncation priority ([ADR-003](adr/003-headless-first-semantic-observations.md)) | Unbounded raw output | Snapshot text, unbounded | UNVERIFIED |
| Setup weight | Heavier: service + tenant keys (brew/npm/Docker) vs one-liners ([operations](operations.md)) | One flag — but dangerous (Chrome 136 change) | `npx` one-liner | Extension / plan-gated |

## AgentBrowser: good, bad, ugly

### Good

- **The safety controls are enforced in-core and test-pinned, not
  advisory.** Staleness rejection, approval-token consumption, and tenancy
  ownership each have dedicated suites the threat model names
  ([threat model](threat-model.md)).
- **The security posture is falsifiable by design.** A real-Chromium test
  asserts the R4 redirect bypass *exists* instead of hiding it
  (`redirect-gap-real-chromium.test.ts`); the experimental Obscura engine's
  tests assert its own non-enforcement as a truth guard
  ([engines](engines.md)).
- **Secret redaction** across observations, logs, and errors
  ([threat model](threat-model.md)).
- **Token-budgeted observations**: ~32 KiB semantic state vs multi-MB
  screenshots ([ADR-003](adr/003-headless-first-semantic-observations.md)).
- **No silent engine fallback** — an unavailable engine is a typed error,
  never a quiet swap ([engines](engines.md)).

### Bad (real gaps vs the others)

- **No debugging surface at all.** No JS eval, no console, no network
  inspection, no performance traces — deliberate
  ([ADR-009](adr/009-mcp-high-level-tools.md)), so any perf/console/debug
  work belongs in chrome-devtools-mcp or raw CDP, not here.
- **Egress enforcement is partial**, so the headline safety layer cannot
  promise containment on its own — the threat model says do not rely on
  it alone ([threat model](threat-model.md)).
- **Heavier setup** than `npx` one-liners
  ([operations](operations.md)).
- **Chromium-first.** Safari refuses all policy-bearing sessions, so the
  REST service effectively cannot run Safari; native Firefox is
  experimental and unqualified ([engines](engines.md),
  [operations](operations.md)).
- **Delegated-session records are ephemeral** — "records and grants
  disappear on session close/restart"; durable receipts are future work
  ([delegated sessions](delegated-sessions.md)). (The durable operation
  journal is under construction — [T5](spec/tasks/t5-durable-recovery.md).)
- **No prompt-injection classifier of its own**; it flags untrusted
  content and relies on the calling harness — weaker guarantees than
  Anthropic's measured defenses
  ([threat model](threat-model.md) vs
  [Anthropic research](https://www.anthropic.com/research/prompt-injection-defenses)).

### Ugly (documented footguns, each admitted by the repo)

- **R4 later-hop redirect bypass**: a public URL that 302s to a blocked
  host *reaches it*; the policy callback never sees the denied hop — open,
  explicitly "not accepted debt"
  ([threat model](threat-model.md); the test asserts it).
- **DNS rebinding** is only partially covered: browser connections are not
  pinned to validated addresses ([threat model](threat-model.md)).
- **Response-size caps check after buffering**, and only on routed
  responses ([threat model](threat-model.md)).
- **POST/PUT/PATCH bypass response inspection** via `route.continue()` —
  S3 presigned uploads forced this exception
  ([ADR-006](adr/006-network-egress-policy-ssrf.md)).
- **Service workers must be blocked whenever a policy is attached**
  (Playwright limitation), breaking SW-dependent sites unless explicitly
  opted in ([ADR-019](adr/019-explicit-service-worker-opt-in.md)).
- **WebSocket coverage is partial**; explicit off/no-policy modes are
  unguarded ([threat model](threat-model.md)).
- **Safari cannot do egress policy at all** — WebDriver cannot intercept
  network; policy-bearing Safari sessions fail loudly
  ([ADR-011](adr/011-safari-via-safaridriver-webdriver.md)).
- **CDP-attach lane is navigation-preflight-only** — traffic from an
  existing profile is uncontained
  ([operations](operations.md)).
- **Turnstile-class walls can still defeat headed sessions**; cookie
  handoff is the workaround, refused as an arms race
  ([ADR-013](adr/013-headed-sessions-and-walled-logins.md)).
- **OS containment is not shipped** — "an ordinary Docker bridge is not
  forced egress"; hostile multi-tenancy needs an OS-level layer
  ([threat model](threat-model.md)).
- **SecretManager lives in process memory** ([threat model](threat-model.md)).

## Where each tool wins

- **Raw CDP** — building your own automation or guardrails; full-fidelity
  scraping and instrumentation; CI harnesses. With open eyes: the port is
  a local cookie-dumping hazard, so prefer
  `--remote-debugging-pipe` and a non-default `--user-data-dir`.
- **chrome-devtools-mcp** — a developer debugging *their own* web app:
  performance traces, LCP/CLS insights, console, network, CSS. The fastest
  path from prompt to trace. Its own docs steer it away from hostile-page
  and multi-tenant agent workloads.
- **Claude in Chrome / Claude Code `--chrome`** — personal agentic
  browsing in your logged-in browser with human oversight and
  injection-hardened refusals: watched purchases, authenticated sites.
  Chrome-only, consumer profile, no policy layer.
- **AgentBrowser** — untrusted-page agent workloads where the *service*
  must bound the blast radius: egress allowlists, SSRF denial, approval
  tokens, tenant isolation, token-budgeted observations, and an
  audit/replay spine across REST, SDK, CLI, and MCP. It wins on governance
  and honest limits; it loses on debugging depth and setup weight, and it
  does not yet deliver full network containment — for hostile
  multi-tenancy its own docs say to pair it with OS-enforced egress.

!!! note "Corrections welcome"

    This page is held to the repo's own standard: falsifiable claims with
    sources. If a cell is wrong or stale — including favorable ones —
    open an issue or PR against `docs/comparison.md`. Unverified items are
    marked UNVERIFIED rather than guessed.
