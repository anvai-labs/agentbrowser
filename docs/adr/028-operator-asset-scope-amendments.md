# ADR-028: Operator-approved live asset scope amendments

Status: Accepted for T10 B4 implementation (2026-10-30); merge requires independent review.
Related: [ADR-006](006-network-egress-policy-ssrf.md),
[ADR-026](026-policy-reload-without-restart.md),
[ADR-027](027-evidence-pass-state-transfer.md),
[T10 operator workflow](../spec/design/t10-bounty-operator-workflow.md).

## Decision

An authenticated human operator may append **asset-class** hosts to a running
scoped session through a separate operator route. Ordinary tenant/API/agent
credentials cannot commit an amendment. The request names exact additions and
the expected scope revision, and is bound to the owning tenant and current
session/context generation. Concurrent requests serialize; stale revisions refuse.

The proposal's literal `allowedHosts` append is not the implementation: the
program target list is immutable. Increasing an allowlist does increase egress
relative to the previous scope. This ADR explicitly permits that limited change
for approved static assets; append-only data structures are not a claim of
globally monotone permission. Restrict-only **composition** is preserved: the
original base/tenant/session-host/metadata policies always run. This operation
does not reload server policy or discard any restriction in ADR-026's chain.

Assets are disjoint from program hosts and never become finding targets or state
transfer origins. They permit GET/HEAD static resources only (script, stylesheet,
image, font, media, manifest, texttrack), attributed by the engine to a program
document. Unknown attribution, Worker/SharedWorker creation, navigation/iframes, fetch/XHR and other
methods refuse. Program method/scheme/port/exclusion/expiry/budget rules still
apply; program path allow rules do not authorize assets. All redirect hops are
reclassified. Program identity headers are suppressed even for marker definitions
without hostSuffix. Empty Cookie and stripped authorization headers prevent
browser/API cookie-jar reattachment and credential forwarding on asset requests.

No amendment may replace/remove program targets, exclusions, identities, headers,
methods, expiry, limits or the base policy. Budgets, pacing counters and denial
counts are retained. A stopped, expired, closing or unrecordable session cannot
gain hosts. Unsupported engines refuse before any grant. Denied ledger traffic
is a suggestion, never independent authorization; the human operator must select
and approve hosts. Site bundles are optional support-host suggestions, not program
policy or evidence that a third party authorizes security testing.

## Audit and atomicity

The existing engagement ledger is mandatory. It must durably acknowledge an
authorization entry containing the expected/new revisions, selected asset hosts,
prior/next configuration hashes and pinned server-policy identity before the
in-memory grant changes. After the wait the context/revision/expiry/stop state is
checked again, then the append commits synchronously. A completion record follows.
If persistence fails, the scope stops closed. An authorization without completion
is intent, not proof the new revision ran; final close seals the ledger normally.
No credentials, marker values or browser storage values appear in amendment records.

Offline `scope adopt-assets` previews candidates, then requires explicit host
selection. It preserves a private hash-chained sidecar and records authorization
before atomically replacing the scope file. It never edits a running session.
Local chain verification detects edits without re-hashing, not a writer capable
of rewriting the whole chain; there is no external signature or anchor.

## Validation

Test API/agent and cross-tenant refusals, unknown fields, stale/concurrent requests,
source-generation/close races, ledger full/write/sync failures and unchanged limits.
Real Chromium must retain page state while newly approved static hosts load,
strip markers/cookies at the receiver, refuse active request lanes, and continue
to honor base and metadata denials. Existing header, redirect and worker gates
remain mandatory.

## Worker provenance qualification

Playwright can attribute dedicated-worker script requests to their owner's frame;
`frame()` is not proof of a document initiator. Every scoped Playwright context
therefore receives an additional enforced `worker-src 'none'` CSP from creation,
including contexts with no initial asset entries that may later be amended. The
policy is appended to every delivered response, synthetic redirect stub and native
body-response commit; existing enforced and report-only CSPs remain intact. A native
response whose policy headers cannot be installed is failed and recorded as failed.
This intentionally disables Worker/SharedWorker creation in scoped contexts;
service workers remain refused separately. It can prevent worker-dependent UI
features from rendering. The operator browser remains the exploration window.

Worklets use script directives rather than `worker-src` and remain outside the
qualified browser containment claim. Static script classification is not a proof
that all off-main-thread module graphs are disabled. No expanded worker/worklet
network-containment guarantee is made. Real receivers cover classic/module/blob
Worker and SharedWorker refusal, GET redirect delivery and POST redirect terminals.

Chromium may ignore response-header overrides when a response-stage fulfillment
omits the body ([upstream issue](https://github.com/microsoft/playwright/issues/34826)).
Scoped native responses therefore use bounded CDP stream reads and explicit decoded
response bytes: at most 8 MiB within 15 seconds, with late streams closed and
oversize/stalled reads refused. Upload request bytes remain native. Gzip response
qualification verifies decoded bytes and adjusted encoding/length headers. Existing
duplicate headers such as Set-Cookie are retained; enforced CSPs are combined as
independent policies. This additional scoped-response limit can stop large or
streaming responses; it grants no network permission.
