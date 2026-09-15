# Session-wide Firefox BiDi gate

Status: **session-wide interception also failed the promotion gate**. This
completes the bounded follow-up to the failed
[public page interception gate](firefox-egress-gate.md). Guarded Firefox stays
unavailable; the trusted local adapter is unchanged.

Hypothesis: a single direct WebDriver BiDi session, with `session.subscribe`
and `network.addIntercept` acknowledged without a contexts filter before any
fixture context is created, covers the worker requests missed by page-scoped
Puppeteer interception. This is a standalone loopback probe, not a replacement
production driver, private fork or second controller attached to Puppeteer.

Use the same nine destination-counter fixtures and allowed controls. Preserve
protocol errors and version provenance. Stop if a denied worker destination is
reached or a positive control cannot be established; do not expand into another
driver merely to change the result. Passing request fixtures still leaves
response-byte limits, DNS pinning, startup ordering and forced egress unproven.

The small diagnostic connection must bound pending commands, correlate replies,
reject them on disconnect, and retire itself on timeout without replaying a
mutation. Cover these failures with local tests before the native experiment.
Use the existing pinned Firefox executable and launcher package; add no runtime
dependencies, GitHub jobs or host networking changes.

## Result and decision

The [raw report](evidence/firefox-session-egress-155.0.1.json) records native
Firefox 155.0.1 on macOS arm64, controlled by this repository's diagnostic
`direct-bidi-probe-v1` over Node 24.11.1's WebSocket client. The existing pinned
`@puppeteer/browsers` 3.2.2 package launches an owned temporary profile. No
Puppeteer automation connection or private driver API participates in this
candidate; the shared fixture module also supports the separate public candidate.

Both phases acknowledged the unfiltered subscription and intercept before
creating fixture contexts. All nine allowed controls completed and each reached
its destination once. Setup/interception errors were empty. The denied results
match the earlier page-scoped report:

- Shared-worker and service-worker fetches reached the denied destination once
  each, with zero denial callbacks.
- Navigation, redirects, page fetch, dedicated-worker fetch and page WebSocket
  were blocked in these fixtures, with one callback and zero destination hits.
- Frame and popup attempts had one callback and zero destination hits, but
  completion timed out. They remain inconclusive.

The direct probe did not measure a response-content API (`contentAvailable:
null`), and observed 65,536 body characters after delivery. It must not be read
as evidence that BiDi cannot retrieve content. Response-byte enforcement, DNS
binding, target startup ordering and forced egress remain unverified.

**Decision:** broadening the intercept's context scope is insufficient in this
pinned arrangement. This is evidence against a page-scope-only explanation,
not proof of a specific Firefox defect or of every driver's behavior. Stop
expanding drivers under this hypothesis. Retain the reproducible evidence for a
supported upstream coverage inquiry; no inquiry has been sent. Reopen browser
promotion only with a materially different supported mechanism or upstream fix.
An opaque gateway cannot compensate for absent browser response enforcement.

## Regression and runner cost

`pnpm test:egress-evidence` runs the four evidence checks and five diagnostic
transport tests. The new transport suite first failed because its implementation
was absent; it now covers correlation, disconnect, timeout retirement, pending
capacity and malformed input. No command is retried after uncertainty.

`pnpm test:firefox` includes both native candidates. The focused comparison
passed both tests in about 13 seconds locally. Truth guards deliberately require
review if a browser upgrade changes the bypass evidence. Neither regression
test can enable the production engine or waive REST/SDK/MCP policy refusal.

`pnpm probe:firefox-session-egress` prints a fresh JSON report and exits **1** for
the rejected candidate. That is the expected qualification result, distinct from
the passing regression suite. Tests reuse the existing cached Firefox Test job;
there is no new CI job, dependency download or GitHub workflow dispatch. Linux
behavior remains a CI qualification requirement, not a result of this macOS run.

## Progress checkpoint

| Track | Rechecked status |
| --- | --- |
| Human/agent delegated authority | Local commit `0ec2d7b`; takeover, review, revocation and operation reconciliation covered |
| Victor (`../codingagent`) interoperability | Companion commit `af0d6770d` retained; 61 client tests and real stdio acceptance recorded in [delegated evidence](evidence/delegated-session-validation.md) |
| Independent Firefox and application outcomes | Local commit `34380b5`; production-tree independence and shared UI/API outcome fixture covered |
| Public page egress gate | Local commit `8beed93`; worker bypasses and service refusal covered |
| Session-wide egress gate | Implemented here; the same bypasses remain, so promotion stops |
| Product integration/release | Pending; these commits are isolated, unpushed work, not a delivered release |

The main AgentBrowser checkout remains at `5016364` and the codingagent checkout
at `c8a0950fe` at this recheck. They were not modified. Codex/Claude registration
syntax is documented, but live-account acceptance and persistent registration
were not performed. Victor's prior acceptance uses a fake engine for the stdio
boundary, with browser behavior checked separately by native Chromium fixtures.

The [combined Victor/Chromium acceptance](evidence/victor-chromium-coexistence.md)
now closes the real-stdio/native-browser gap. Integration preparation follows
against an explicitly recorded committed snapshot of the other workstream;
ancestry must be checked rather than inferred from checkout activity. Keep this
separate from Firefox promotion; do not spend runner cycles repeatedly testing
the rejected hypothesis.

The [integration candidate](evidence/coexistence-integration.md) records the
subsequent committed snapshot, ancestry check and verified-fill reconciliation.

Primary references: [Firefox direct BiDi connection](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection),
[W3C network.addIntercept](https://www.w3.org/TR/webdriver-bidi/#command-network-addIntercept),
and [W3C network.failRequest](https://www.w3.org/TR/webdriver-bidi/#command-network-failRequest).
