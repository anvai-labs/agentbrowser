# Human-agent coexistence: implementation plan

Status: proposed design, 2026-09-14. Runtime implementation has not started.
This plan follows the requested plan-first workflow. No GitHub workflow was
started, PR opened, or runtime configuration changed while preparing it.

## Outcome and constraints

Deliver one complete workflow: a human opens a task session, delegates it to
Victor/Codex/Claude, takes control during a multi-step task, edits the application,
and returns control. The agent continues from fresh evidence without executing
an old plan, observing a private credential step, or repeating an uncertain write.

Then run a defined subset of that workflow without Playwright or Chromium, and
exercise an owned application through both UI and typed application operations.

Retain TypeScript, the current public protocol boundary, Playwright as the primary
adapter, and existing local deployment. Add no planner, renderer, general workflow
framework, UI framework, or database to the initial milestone. Preserve current
release checks. Optimize local iteration and CI submission, not correctness gates.

The [review](coexistence-architecture-review-2026-09-14.md) supplies findings and
alternatives; its [evidence](evidence/coexistence-review-2026-09-14.md) supplies
bounded reproductions. Reproduce against the chosen implementation base: another
workstream is changing the shared checkout, including observation semantics.

## First principles translated into requirements

| Principle | Required behavior |
| --- | --- |
| A task has effects, not just tool calls | Distinguish admission, dispatch, completion, verified outcome, and uncertainty |
| Two writers cannot share assumptions | Admit one session operation at a time; reject conflicting new work rather than queue stale plans |
| Observations can mutate ref state | Serialize observation/binding work with actions, not just click calls |
| A human can act outside the service | Make takeover explicit; invalidate automation assumptions after handoff; never claim the service blocks physical input |
| Authority comes from credentials | Separate operator authority from a delegated session credential; ignore caller assertions of human status |
| A timeout is not evidence of failure | Reconcile an in-flight write; no transparent replay or backend switch |
| A valid target is not a valid transaction | Use task preconditions and independent outcome checks for consequential effects |
| Redundancy must remove a failure dependency | Qualify a Firefox/BiDi deployment with Playwright and Chromium absent |
| UI coverage means executing the UI | API/tool paths can verify outcomes but cannot count as tests of the UI interaction |
| Runner time is scarce | Finish local debugging and review before submitting a consolidated CI candidate |

## Implementation boundaries

Keep authentication and transport credentials in `packages/api`. Add a small,
engine-neutral session-control state machine to `packages/core`. Define wire
schemas, enums, and types in `packages/protocol`. Keep adapter-specific input,
accessibility capture, and cancellation behavior in engine packages.

The service coordinates authorization, control admission, observation revisions,
approval, execution, and evidence. Extract operation coordination from the large
service file only as needed for this feature; do not reorganize unrelated code.
Split public admission wrappers from private implementations so plans, remaps,
and internal observations reuse a valid operation context without nested locks.

Expose the same control state through REST, the TypeScript SDK, CLI, and MCP.
The human panel is a thin client of those contracts. It cannot become a second
authority implementation or send arbitrary page JavaScript.

## Authority model

Existing API keys map to tenants, not human/agent roles. For controlled sessions:

1. An operator authenticates using the existing operator API authority and creates
   a controlled session. Existing clients retain legacy session behavior unless
   controlled mode is explicitly selected.
2. The operator issues a random, opaque, session-scoped delegated bearer token.
   Store only its hash and scope in the service. The token is returned once to
   the operator, delivered to the harness outside model-visible tool arguments,
   and never included in observations, logs, URLs, or event payloads.
3. A delegated principal can access only the assigned session's permitted tools
   and evidence. It cannot list other sessions, create privileged sessions,
   issue credentials, return control to itself, or change policy.
4. Authentication creates an internal principal object. Actor, session, grant
   generation, and current control epoch are server-derived. Caller-supplied
   `actorId` or epoch alone grants no authority.
5. Takeover revokes the active automation grant. Resume issues a new grant only
   after operator review; do not put the revoked grant back into service.

Old operator keys remain administrative authority. Giving that key to an agent
would let it administer the session; the deployment guide and harness examples
must use delegated tokens for controlled mode. Trusted embedding APIs need an
explicit operator context rather than a default authorization bypass.

The initial implementation is local and ephemeral. Service restart invalidates
all delegated grants. It does not promise restart-safe task recovery. Remote
deployment and durable state are separate follow-ups.

## State machine and races

Control state is separate from existing session lifecycle state:

```text
HUMAN_ACTIVE -> RESUME_REVIEW -> AGENT_ACTIVE
AGENT_ACTIVE -> PAUSE_REQUESTED -> HUMAN_ACTIVE
any state -> STOPPED
```

Creating a controlled session starts in HUMAN_ACTIVE. Resume-review captures a
fresh, operator-visible view and invalidates old page refs and approvals before
new delegation. The agent must obtain its own fresh observation after delegation.

| Transition or event | Rule |
| --- | --- |
| Agent operation admission | Valid delegated grant, AGENT_ACTIVE, no active operation, within budgets |
| Second operation | Return `SESSION_BUSY`; no unbounded queue |
| Takeover | Synchronously advance the control epoch and revoke new agent admission before awaiting anything |
| Plan between steps | Recheck operation epoch before every await-to-dispatch boundary; stop the remaining suffix on revocation |
| Operation already dispatched | Retain ownership until the actual underlying promise settles; an HTTP timeout cannot release the slot |
| Pending action will not drain | Expose pending/unknown state. Offer operator Stop, which closes the owned session; do not falsely declare safe handoff |
| Human-ready | No active browser command that can still inject input; no new agent observations/captures allowed |
| Resume | Operator validates context, grants a new epoch/credential, requires fresh agent observation |
| Browser/session close | Revoke first, terminate lifecycle, release owned records on actual cleanup |
| Expiry | Explicit bounded handoff deadline within session TTL; human-only activity cannot silently extend a session forever |

Initially admit at most one top-level browser operation per controlled session,
including snapshot/observe/extract/capture operations that touch the page. Internal
plan operations share the admitted context; each step remains revocable.
Independent status reads do not enter browser execution.

Pause stops future dispatch; it cannot undo an effect already sent. Navigation,
popup adoption, remap retries, diagnostics, and download collection must be audited
for bypasses. A blocked or old operation must not emit new sensitive payloads
after revocation merely because it began earlier.

## Operation and evidence records

Require a client operation ID for controlled mutations. Bind it to the session,
authenticated principal, action payload digest, and control generation. Reusing
an ID with different arguments fails. Repeating it with identical arguments
returns its existing outcome without redispatching the browser action.

Store bounded records for the lifetime of the ephemeral session. Do not evict
records and then accidentally permit duplicate effects: when the operation
budget is exhausted, refuse new mutations until the session ends. Keep pending
and uncertain records until reconciliation or session close. Define configurable
limits with a finite default; validate input size before hashing or allocation.

Records contain operation ID, principal reference, admission and dispatch times,
control epoch, page/document context, result status, verification references, and
completed plan prefix. They do not contain credential values or unredacted form
secrets. Distinguish `rejected`, `in_flight`, `completed`, `failed`, and
`outcome_unknown`; `completed` means the command returned, while a separate
verification field describes whether the application outcome was proved.

This is session-lifetime deduplication, not exactly-once transactions on arbitrary
websites. Persisted destination receipts or an owned application's idempotency
contract are needed to reconcile effects across crashes.

Re-observation and target checks remain mandatory. For owned applications, use
business versions/ETags and server-enforced preconditions. For arbitrary websites,
fresh UI evidence cannot guarantee atomic business-state checks; consequential
steps may need an explicit final operator review.

## Proposed public surface

Names below are design targets; implement schemas before routes and generated
OpenAPI. Preserve old endpoints for legacy sessions.

| Surface | Access | Behavior |
| --- | --- | --- |
| Session create with `controlMode: 'delegated'` | Operator | Create controlled session in HUMAN_ACTIVE |
| `GET /v1/sessions/:id/control` | Operator or delegated principal | Read control state and active operation summary without browser I/O |
| `POST /v1/sessions/:id/control/takeover` | Operator | Revoke admission and request drain; return actual current state |
| `POST /v1/sessions/:id/control/prepare-resume` | Operator | Obtain fresh context for review and invalidate old automation state |
| `POST /v1/sessions/:id/control/delegate` | Operator | Validate review generation and issue the new delegated grant |
| `GET /v1/sessions/:id/operations/:operationId` | Scoped principal | Return operation status and permitted evidence |
| Existing close/Stop | Operator; delegated close only if explicitly granted | Revoke authority before shutdown |
| Existing browser endpoints | Appropriate scoped principal | Apply admission, operation ID, policy, and output gates |

Every controlled write carries its operation ID in a transport-neutral request
field; the SDK, CLI and MCP adapter use the same field. Return typed 409 errors
for busy/stale-control/operation-conflict cases, 403 for unauthorized grants,
and existing lifecycle errors for closed sessions. Add error codes once to the
protocol and update exhaustive HTTP mappings.

MCP exposes a read-only control/status tool and a bind-to-existing-session flow
for delegated harnesses. Owner-only takeover/delegation does not become an agent
tool. Keep tokens in the MCP process/client environment. Refresh delegation by
restarting/rebinding that process through its trusted harness integration when
necessary; avoid inventing a model-visible token exchange tool.

Gate all data surfaces: observations, HTML, screenshots/PDF, cookies, extraction,
downloads, trace/event streams, and artifact access. Existing artifact URLs are
bearer capabilities: audit their signing and retrieval path before claiming
revocation. For controlled sessions, new artifact access must also satisfy the
current scoped authorization; operator private captures cannot be reachable
through an old agent URL. Revocation cannot retract bytes already received.

## Minimal human interface

Serve a small static panel from the existing API package, using platform HTML,
CSS, and JavaScript. No new UI runtime dependency. Restrict its origin and use
short-lived operator web sessions with CSRF protection; keep API keys out of
URLs, localStorage, and browser-visible page content from the target application.
Do not treat loopback or wildcard CORS as operator authentication.

Display origin/account context, controller, pending operation, completed steps,
handoff status, expiry, and the next consequential action. Provide accessible
Take over, Prepare resume, Delegate, and Stop controls. Distinguish draining,
human-ready, and unknown outcomes visibly.

Credential entry occurs in the headed target browser. In HUMAN_ACTIVE, deny
agent captures and suspend forwarding of sensitive browser events. Verify cleanup
of observers and in-flight responses. The panel cannot promise to delete secrets
that an application retains in its DOM or that a client already received.

## Independent browser track

Start a narrow Firefox/WebDriver BiDi implementation behind `BrowserEngine`.
Compare Selenium's JavaScript BiDi support with Puppeteer BiDi in a local spike;
choose the smallest maintained client that meets the required task subset.
Do not build a new wire client merely to avoid a dependency.

The acceptance subset is navigate, semantic observe, stable target identity,
click/fill/press/select, frame/page lifecycle, screenshot, and clean shutdown.
Uploads/downloads and advanced observation capabilities must be independently
qualified; unavailable features report unsupported. Use a bounded semantic DOM
extractor where a standards client lacks accessibility support, and report its
limitations instead of claiming a native accessibility tree.

Package the Firefox service profile without `engine-playwright`, Playwright,
Chromium binaries, or CDP. Separate API library imports from default executable
composition. The same MCP binary must operate it through the existing REST
contract. Verify policy-bearing creation and real local fixture traffic;
passing data-URL adapter tests is insufficient for service qualification.

Reuse the existing qualified local-use network posture only where actually
supported. No unsupported policy can be silently dropped to make this adapter
work. Failure to meet policy requirements keeps it experimental and unregistered.
This track does not resume the deferred hosted-containment program.

## Application-operation track and evaluation

Build one deterministic local fixture app, backed by a small in-process state
store, with domain operations such as saving a draft. UI and typed tool handlers
call the same domain validation and authorization. Add an optional WebMCP binding
later; feature-detect it and keep it out of the core contract.

Place application operations beside browser engines behind an operation port,
not inside a fake `EnginePage`. Share admission, authority, preconditions,
deduplication, and evidence above both. Route explicitly in the first version.

The evaluator reads fixture state through a separate test-only oracle and counts
actual effects. The agent cannot manufacture a passing result by writing a
transcript or changing expected-output files. Run UI-only, tool-only, and mixed
human-handoff scenarios; label UI interaction coverage independently.

Victor, Codex, and Claude consume the same task descriptions and outcome checks.
Begin with a deterministic SDK runner before spending model tokens. Fix Victor's
response correlation independently in its repository: one reader, pending-ID map,
notification dispatch, late-response handling, process cleanup, and timeouts that
do not leave competing stdout readers. Preserve structured content and useful
artifact/image delivery through its tool adapter.

## Implementation batches and local acceptance

| Batch | Implementation | Required local exit |
| --- | --- | --- |
| 1A — Existing correctness | Reproduce current defects; fix family capability claims and input-guide statements; preserve current live target checks | Focused regression tests, correct unsupported claims, current Chromium fixture pass |
| 1B — Session authority | Protocol, delegated credentials, core control state, operation admission/dedup, drain behavior, gated evidence | FakeEngine race/negative suite and service-level authorization tests |
| 1C — Complete human workflow | REST/SDK/CLI/MCP integration, minimal panel, bounded handoff lifetime, packaged fixture | Real Chromium takeover/resume through delivered surfaces; stale plan suffix never dispatches |
| V — Victor integration | Correct MCP correlation and artifact handling; delegated-session binding | Fake stdio races plus actual AgentBrowser MCP process against local fixtures |
| 2 — Driver independence | Standards-client spike, Firefox adapter, independent install profile | Supported corpus passes with Playwright/Chromium absent; dependency-closure audit |
| 3 — Interface parity | Owned app operation port and independent evaluator | UI/tool/mixed runs agree on state; negative controls reject fabricated completion |

Batches 1A–1C form one coherent AgentBrowser PR if the final diff remains
reviewable. Victor needs a separate repository change and cannot share an
AgentBrowser CI result. Batches 2 and 3 follow the stable contract; keep them
local until complete. Do not combine unrelated repository-wide cleanup into
these changes just to reduce PR count.

Write failing behavioral tests first for:

- revoked grant used during and after a plan; stale epoch on resume;
- concurrent action/observation and same-session cross-tab operations;
- pause between approval and dispatch, during wait, remap, and navigation;
- timeout while an underlying action is still pending; repeated operation IDs;
- wrong tenant/session, administrative calls using delegated credentials;
- stale artifact URL, open event stream, and in-flight capture after takeover;
- human edits surrounding business context while the button remains unchanged;
- browser crash, expiry, abrupt MCP exit, and shutdown with pending operations;
- ignored submit and fabricated model success versus independent fixture state.

Use fake clocks and deferred promises for race tests. Real-browser tests prove
the delivered behavior and cleanup; they do not replace deterministic race tests.
Use synthetic credentials and local fixtures. Do not restart the user's installed
service or use live accounts for development acceptance.

## GitHub runner budget

The current CI has eight jobs and builds the workspace in six jobs, in addition
to Docker's build. Its PR trigger runs on every PR update. A draft PR does not
itself save those runs. The first optimization is submission discipline:

1. Use an isolated local worktree pinned to the selected base. Keep dependency
   installs and build artifacts local. Do not share mutable `dist` directories
   between concurrently edited checkouts.
2. Iterate with affected package builds/type checks and focused tests. Run the
   full local build/type-check/lint/test suite once the integrated candidate is
   stable, followed by applicable packaged Chromium/CLI/MCP checks.
3. Review the final diff and resolve findings locally. Record source revision,
   dependency/browser versions, tests, and unsupported/skipped cases.
4. Open or update the PR once with that candidate. Target one successful PR CI
   cycle plus the required integration-branch cycle per consolidated batch.
   This is a target, not a guarantee that CI will discover no platform issues.
5. For a genuine CI-only failure, reproduce locally if possible, collect related
   fixes, and submit one corrective update. Re-run only infrastructure-failed
   jobs when the source has not changed; never reuse another revision's success.
6. Defer release/tag/tap workflows until a combined release milestone is ready.
   Preserve required checks, hooks, and branch protection. Do not use skip-ci
   messages or empty/skipped jobs as substitutes for required validation.

Include a small workflow improvement with the first implementation PR: cancel
superseded runs only for the same PR, using a workflow/PR concurrency key and
`cancel-in-progress` conditioned on the pull-request event. Give non-PR runs a
unique run-ID key so merge/release validation is not accidentally canceled.
[GitHub documents concurrency behavior](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency).

Use frozen-lockfile installs. Consider sharing a built workspace artifact across
jobs only after measuring runner time and proving its complete build inputs and
same-revision integrity; bundling and platform tests must still run in their
correct environments. Do not redesign all eight checks in the first feature PR.
Path-filtering a required workflow can leave checks pending, so preserve the
existing required-check contract rather than adding blanket PR skips.
[GitHub workflow filtering semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).

Report both CI cycle count and consumed job time. Eight parallel jobs remain
eight jobs even if their wall time is short. The planning phase consumes zero
GitHub runner jobs.

## Completion and rollback

The first milestone is complete only when the operator-to-agent-to-human-to-agent
workflow runs through the packaged service, an expired grant cannot act or read
private evidence, partial plans report the executed prefix, and real effects are
verified independently. A state machine with no usable human/harness consumer is
not completion.

New controlled mode remains opt-in while qualified. Rollback disables new
controlled-session creation and closes those sessions; it must never reinterpret
a controlled session as an unrestricted legacy session. Engine profiles are
explicitly selected; an unsupported or failed profile does not fall back silently.

Keep broader renderer replacement, transparent session migration, hosted
containment, and durable recovery outside these milestones. Revisit them from
measured failures in the supported task corpus.
