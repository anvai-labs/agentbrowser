# Independent browser and application qualification

This milestone qualifies a native Firefox adapter and an owned-application
UI/API parity fixture. It does **not** register Firefox as a guarded REST/MCP
fallback. The service always attaches a network policy; this adapter refuses
that policy before browser launch. Removing that refusal requires separate
egress acceptance evidence. There is no automatic replay or browser switch
after an uncertain write.

## First principles and selection

1. A browser implements human-facing interaction, not business correctness.
2. An owned application can offer versioned commands and authoritative receipts.
3. A session grant controls who may operate. An application version controls
   what state a command may change. Neither substitutes for the other.
4. A redundancy is independent only if its installed execution path works
   without the dependency whose failure it is meant to survive.
5. Unsupported behavior must be visible before relying on the capability.

| Option | Independent seam | Decision |
| --- | --- | --- |
| Playwright + Firefox | Renderer | Useful coverage, insufficient driver independence |
| Selenium + Firefox/BiDi | Driver and renderer | Retain as next candidate if interception or observation requirements justify a second adapter; requires driver lifecycle qualification |
| Puppeteer-core + native Firefox/BiDi | Driver and renderer | Implement the bounded local qualification first; explicit executable and protocol, no Chrome download |
| Direct application HTTP/MCP | Business operation | Prefer for owned, authorized commands when version and receipt semantics exist; separately test the UI |
| WebMCP | In-page discovery of application operations | Bind to the same application contract later; avoid coupling the domain model to a changing browser API |
| Remote Chromium | Hosting | Useful deployment redundancy; does not remove renderer/driver risks |

Puppeteer is a dependency, not the end of dependency risk. Its package contains
CDP support and a Chromium BiDi bridge, even though this adapter selects native
Firefox BiDi. The independent deployment gate excludes Playwright and runs a
real Firefox action from the extracted production dependency tree. It does not
claim that Puppeteer contains no Chromium-related code.

Primary references: [Puppeteer BiDi support](https://pptr.dev/webdriver-bidi),
[supported browser versions](https://pptr.dev/supported-browsers),
[Selenium BiDi](https://www.selenium.dev/documentation/webdriver/bidi/), and
[Firefox command-line parameters](https://firefox-source-docs.mozilla.org/browser/CommandLineParameters.html).
Puppeteer's published Firefox gaps include native accessibility snapshots and
response-body access. These make policy and semantic qualification necessary;
request interception alone is insufficient evidence of containment.

## Delivered browser scope

`@agentbrowser/engine-firefox` uses `puppeteer-core` with `browser: firefox`,
`protocol: webDriverBiDi`, and `--no-remote`. Every session owns a temporary
profile and browser process. It never attaches to the user's profile.

Qualified operations are HTTP(S) navigation, main-document DOM observations,
ref-based click/fill/press/select, cookie access, and explicit unmasked PNG
capture. Acknowledgments describe dispatch, not verified application outcomes.
Input and action behavior are tested against a local application with state
measured outside the browser. Replaced nodes and changed semantic evidence
refuse stale references. Private salted evidence digests also detect edits beyond
display truncation and changes to password values; these digests and password
values are not included in element observations. URL discovery leaves references alone. The adapter
rejects concurrent page calls instead of queuing stale commands.

Observations carry `degraded: true` and `degradedReason: dom-semantic-subset`.
The interpretation includes native controls, labels and explicit ARIA roles;
it is not a native accessibility tree. Frames, shadow DOM, overlays, full
accessible-name computation and popup lifecycle events remain unqualified.
Page enumeration can discover tabs, but this is not a popup-event guarantee.
Native dialogs, PDF, uploads, download policies, service-worker policies,
locale/timezone emulation, target remapping and sensitive screenshot masking
are refused or unadvertised. Use `maskSensitive: false` explicitly for PNGs.

Policy-bearing sessions return `ENGINE_UNSUPPORTED` with
`reason: EGRESS_UNSUPPORTED` before launching. Do not remove the service policy
to make this adapter selectable. Future service promotion must qualify redirects,
DNS/connection binding, body limits, workers, WebSockets and lifecycle races
against the [threat model](threat-model.md), preferably behind an independently
enforced gateway. The default server and its packaging remain unchanged.

## Application seam and coexistence

The reusable testkit fixture exposes a small typed command:

```ts
type CounterCommand = {
  operationId: string;
  expectedVersion: number;
  amount: number;
};
```

The application atomically checks the expected version, applies the effect and
stores the receipt. Identical retries return the same receipt; altered retries
conflict; stale versions have no effect. The bounded fixture ledger never
evicts executed IDs to admit new work. A real application must persist the state
and receipt in one transaction and scope operation IDs to authenticated actors
and resources. The fixture is in-memory, unauthenticated, loopback-only test
infrastructure, not a production application gateway.

`qualifyApplicationParity` runs the same case on Chromium and native Firefox:

- UI click commits an effect but loses its usable HTTP acknowledgment.
- A deliberate UI retry reconciles the application's original operation ID.
- A direct application command produces an independently verified effect.
- Duplicate application calls leave the version and total unchanged.
- The old human-facing page is now stale; its next write conflicts.
- A broken UI that acknowledges clicks without effects fails the outcome oracle.

This is a reusable test seam, not a new privileged agent tool. Victor, Codex and
Claude retain their existing bound MCP transport and session authority. Before
exposing application operations there, route them through the same admission,
takeover, review and operation-record controls, while retaining application-level
version checks and receipts. Agent-side claimed success never serves as the oracle.

## Runner economy and promotion gates

Use local focused qualification before submitting one candidate. Firefox tests
are opt-in for ordinary developer test runs; the dedicated qualification command
and existing CI Test job must configure a binary and fail if it is absent.
Pin and cache the Firefox installer in that job. Add no runner matrix or new
workflow. Production-tree acceptance must reject an installed Playwright package
and actually launch the extracted adapter; a manifest-only check is insufficient.

The existing CI host-library helper provisions Chromium and Firefox dependencies
in one step. The Firefox binary comes from Mozilla through the pinned standalone
installer. This diversifies the deployed runtime; it does not make the entire
repository's CI independent of Playwright. Linux execution remains a CI
qualification; the local evidence here comes from macOS arm64.

Run `pnpm firefox:install`, `pnpm test:firefox`, then
`pnpm test:firefox-independence`. The latter audits symlinks and nested installed
manifests, repairs only pnpm 9's verified workspace self-reference, and runs a
real action/capture from the production tree. Negative audit tests reject
Playwright packages and references that escape to the source checkout.

After this local milestone, the next promotion gates are enforced Firefox egress,
broader semantic/iframe coverage, delegated REST/MCP parity, and a durable,
authorized application-operation adapter. These gates remain explicit work;
this experiment does not establish general-site or hosted readiness.
