# T1c: transport feasibility reassessment

Status: **Independently reviewed reassessment for co-design; no production mechanism selected.**
Baseline: `develop` at `4e2ec00`, after [PR 86](https://github.com/anvai-labs/agentbrowser/pull/86)
and all eight [post-merge checks](https://github.com/anvai-labs/agentbrowser/actions/runs/34067622077)
passed. This closes neither T1 nor R4. The
[accepted local/contained profiles](egress-transport-design.md) and ADR-008
network-isolation slice are unchanged.

## Executive conclusion

Keep the adapter/gateway split, but do not implement the tested second-CDP-client
startup gate. T1 has **two independent prerequisites**:

1. A lifecycle owner must establish effective gates before untrusted execution
   and network access, across the complete target lifecycle.
2. A browser-semantic gate must deny forbidden channels while preserving
   ordinary HTTP, origin policy and response behavior.

Recursive attachment does not establish the first. Successful startup control
alone would not repair body-replay policy inheritance or establish the second.
The gateway and OS boundary remain necessary, but cannot supply the missing
semantic checks inside an allowed encrypted tunnel. No currently tested
combination meets the complete transport contract.

## Evidence against the complete acceptance matrix

This table assesses the **proposed browser transport**, not unrelated fixes
already delivered in A-G. “Partial” is evidence for the named subset only;
“unproven” must not be read as passing. Raw captures remain immutable in the
[feasibility record](egress-transport-feasibility.md).

| Dimension | Evidence now available | Remaining requirement / disposition |
| --- | --- | --- |
| Redirects | Real Chromium still reaches a denied later hop; one page-CDP continuation experiment observes three URLs | **Failed for shipped routing; partial mechanism evidence.** All-hop rejection, 0/1/N limits, relative/cross-origin hops and loops need candidate-specific tests |
| Browser semantics | Native worker controls pass; replay changes local-network blocking, including replay without added CSP | **Failed compatibility in tested replay path.** No general public-network failure inferred; method rewriting, single POST execution, origin/history/relative assets, cookies and auth stripping remain unproven |
| Targets | Two T1b runs: 27 positive HTTP controls each; 12 attached workers execute before our release; recursion observes both children | **Failed startup ownership.** Shared controls are outside this observer; initial-document and popup-first requests, cross-origin frames, service-worker policy and downloads still need coverage |
| Connections | D fixes direct-download validation/pinning; this does not validate browser CONNECT behavior | **Unproven browser gateway.** DNS changes/mixed answers, TLS identity, IPv4/IPv6, pooling/coalescing and session attribution remain required |
| Bytes | Existing direct-download limits and routed browser checks are narrower than the proposed transport | **Unproven end-to-end candidate.** False/missing lengths, decoded expansion, slow/aborted streams, finite per-request/aggregate admission and declared streaming limitations remain required |
| Alternative channels | Page WS denial misses workers; native server CSP restricts tested worker connections, but injected/replayed policy is not a compatible all-target replacement | **Failed candidate WS/WSS coverage.** WebTransport/QUIC, WebRTC ICE/STUN/TURN, DNS, proxy bypass and reused remote contexts remain unproven; require actual forbidden-endpoint/network counters |
| Isolation/lifecycle | T1b closes owned contexts/bridges/sockets; failure-path cleanup tests pass; nested detach events are not fully observed | **Partial diagnostic cleanup only.** Concurrent same-URL chains, cross-session auth/credential stripping, revocation of existing tunnels, gateway death, detach and close during I/O remain unproven |
| Observability | Bounded diagnostic events and identity-aware offline verifiers expose missing coverage | **Unproven production contract.** One redacted terminal event, typed failures and denial/admission/cleanup counters still need an implementation owner |

Forty-seven offline diagnostic tests protect evidence integrity; they are not
47 new containment guarantees. CI green means the repository meets its current
checks, including explicit known-gap guards.

## Ranked implementation choices

| Choice | Fix shape | Risk / effort | Recommendation and decision boundary |
| --- | --- | --- | --- |
| Coordinated lifecycle integration with Playwright | One authoritative target initializer installs request/response/upgrade gates, acknowledges setup, then releases execution; preserves existing action/observation implementation | High integration risk / medium-to-large; upstream support and upgrade cost unresolved | **Preferred integration direction to evaluate**, not an available API claim. Establish a supported ownership seam and separately prove semantic gates before committing |
| Browser-owned restriction | Enforce connection-channel policy in a maintained browser/network-service mechanism, independent of page JavaScript; retain adapter redirect/response gates | High feasibility risk / unknown effort until a concrete mechanism is identified | Consider only with documented all-target coverage and pinned-browser positive/negative controls. A generic URL blocklist or a method name is not that evidence |
| Sole CDP driver | Own browser and target lifecycle directly behind the existing engine interface; replace Playwright-dependent actions, observations and lifecycle behavior as needed | High product/maintenance risk / large | A small causal probe may inform ownership feasibility. A replacement production engine is a separate scope decision, not a consequence of a successful probe |
| Playwright/Chromium private patch or fork | Maintain an explicit pre-resume integration or browser policy patch with pinned upgrades and regressions | High continuing ownership risk / large | Requires explicit owner agreement on maintenance, upgrades and upstream strategy; do not monkey-patch installed internals or silently vendor a fork |
| Gateway or container alone | Destination checks and forced network path without browser semantic owner | Does not meet current contract, regardless of implementation effort | **Not a substitute.** Preserve T2/T4 as necessary components; do not claim HTTPS redirect/body or WSS semantics from an opaque CONNECT tunnel |

The installed Playwright 1.62.1 `FrameSession._onAttachedToTarget` issues its own
`Runtime.runIfWaitingForDebugger` and recursively attaches workers. Its public
`BrowserContext.newCDPSession` accepts a Page or Frame; inspection found no
public pre-worker-resume handshake in that API. The
[public API documentation](https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session)
supports CDP access, not transfer of lifecycle ownership. This is a bounded
inspection result, not proof that every possible integration is impossible.

[CDP Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach)
describes related-target attachment, including existing targets and recursive
configuration. T1b proves that this additional client's release command is not
an effective startup gate in the tested arrangement. It does **not** identify
which other actor resumed execution. Likewise,
[Fetch response controls](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)
do not themselves establish metadata-preserving behavior; T1a controls remain
required even if ownership is corrected.

## Smallest next experiment: ownership, not a new engine

Recommend one bounded sole-owner comparison before investing in a production
integration. Its question is narrow: **can a sole owner delay startup, and does
introducing a deliberately competing resumer change that observation?**

The next PR-sized diagnostic unit would:

- Reuse the T1b sentinel semantics, unique worker identities and server counters.
  Keep fixture refactoring mechanical and verify the retained T1b classifications.
- Launch only an owned disposable Chromium process/profile. Use the same pinned
  executable, native response delivery and matched launch settings; record any
  unavoidable configuration differences. Do not use `connectOverCDP` or
  `launchServer` as a supposedly Playwright-free control: both would leave the
  lifecycle-owner question unresolved if a Playwright client remains attached.
- Use three arms: sole owner with immediate release (positive control), sole
  owner with delayed release, and the same delayed owner plus a deliberately
  competing resumer. No Playwright client remains connected in these arms.
  Install root/recursive attachment before creating the test targets. Record
  every owner's relevant setup/release invocation and acknowledgement, not
  page data or credentials. This tests competition, not attribution to Playwright.
- Limit this causal comparison to an external dedicated worker and a depth-two
  nested external chain. Blob/data/shared workers, frames and popups remain
  explicitly outside this experiment; their earlier controls and open acceptance
  obligations remain intact. Do not expand this subset into an all-target claim.
- In delayed-owner arms, withhold that owner's release invocation for 200 ms;
  do not delay the immediate control or deliberate competitor. Compare each
  worker's startup GET to its delayed owner's release lower bound using one
  server-side monotonic clock. Require every worker to complete HTTP 200 and
  exact body without requiring completion after release: early completion is
  valid falsifying evidence. Require correct parent lineage,
  finite command/event/target counts, deadlines and shutdown on every arm.
- Run a small fixed repeat set (three per arm) to expose ordering variability,
  not to claim statistical confidence. A missing request, failed native control,
  timeout, dropped event or ambiguous target identity makes the case inconclusive,
  never enforced. Include setup-failure and disconnect/cleanup tests: failed
  setup must abort the owned target rather than deliberately release it or
  accept silent continuation as successful enforcement.

No CSP modification, replay, socket denial, permission bypass, CA installation,
host firewall change or production adapter is included in this comparison.
The diagnostic bridge remains test-only; do not export raw CDP through core or
the public surfaces.

| Result | What it establishes | Next decision |
| --- | --- | --- |
| A sole-owner sentinel precedes that owner's release | This candidate also fails startup gating | Stop extending this pause mechanism; seek a concrete browser-owned alternative or bring the guarantee/maintenance trade-off to the owner |
| Sole-owner controls succeed only after release, while competitor cases execute before the delayed owner's release | Evidence that a second resumer affects the observed startup window | Evaluate a supported coordinated-lifecycle seam; do not infer exclusive-pause guarantees, historical Playwright attribution or start a new engine automatically |
| Both arrangements wait until the delayed owner's release | The deliberate competitor does not produce the expected distinction | Reconcile attachment/command ordering before an integration decision; do not claim the T1b explanation is isolated |
| Controls, identity, command traces or cleanup fail | The experiment is inconclusive | Correct only the fixture defect within this unit; do not expand mechanisms to obtain a preferred outcome |

Even the favorable result is only bounded evidence about execution startup.
Worker script loading can precede script execution: a paused worker is not
proof that its initial network request was policy-checked. A production design
still needs first-request interception before connection, popup/frame coverage,
effective WS/WSS denial and a response path passing T1a compatibility controls.

## Delivery boundaries and co-design checkpoint

1. Deliver this reassessment as documentation only, with independent review and
   the existing full PR checks. This is the T1c assessment artifact, not T1 closure.
2. The bounded ownership comparison above is the recommended next diagnostic
   unit. Stop after its result and integration-seam assessment; do not accumulate
   a series of broader probes without a new decision-relevant hypothesis.
3. If a maintained private patch, fork or replacement engine is needed, return
   its concrete maintenance/upgrade cost and compatibility burden to the owner
   **before implementation**. Upstream issue/PR submission is separate external
   coordination, not implied permission to publish it.
4. Keep T2 gateway mechanics separately reviewable and reusable with direct
   downloads, but do not use gateway progress to mark T1/T3 complete. Keep T4's
   OS network boundary as the contained-release requirement. Full ADR-008 hostile
   multi-tenant scheduling and resource isolation remain deferred.

Docs-only merge pushes are excluded by the existing CI path filters. Verify
whether a post-merge run was actually created; do not report skipped CI as green
or trigger/change workflows merely to manufacture a post-merge result.
