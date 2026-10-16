# T5 B-dur: browser-operation durability, the settled choices

Status: ACCEPTED by the owner on 2026-10-15 (B1–B4), with two follow-up decisions the
[design review](#what-the-review-found) surfaced, also accepted as recommended: B5 (a reserved
`browser` identity) and B6 (an asynchronous recheck, its window disclosed). Refines D6 of the
[accepted recovery design](t5-recovery-design.md#browser-operation-durability-d6), which settled
**what** (journal `act`, `plan` and `autofill` for classification only, never recovered) but not
**how**.

## What the code forces

- **One operation, many dispatches.** A journaled scope writes ONE dispatch marker (rev 1 → 2),
  and later dispatches already await that same marker (`session-authority.ts`), so the store
  needs no change for B2. But every effect call is a dispatch: the page guard routes `act`,
  `navigate` and `close` through the dispatch boundary, and `plan` (one `act` per step), the
  `act` batch (`steps`) and `autofill` (many clicks and keystrokes per field) each dispatch many
  times. Reads (`observe`, `resolve`) are not dispatches.
- **A journaled scope refuses any dispatch without a qualification**, and the only qualification
  type today is application-only; the page guard passes none.
- **Records are application-shaped.** A journal intent requires an `application` identity, the
  record parsers are strict (unknown keys refused), the fingerprint domains are
  `application-operation:*`, and the lookup projection requires `application`.
- **Capacity is shared and small.** A namespace holds `AGENTBROWSER_JOURNAL_MAX_RECORDS` records
  over its lifetime (default 10,000) across ALL tenants; full means refused, never evicted.
- **The checks B3 names are asynchronous today.** Ref identity needs a fresh `resolve`; the
  approval check observes the page and then consumes the single-use token before the engine
  call; autofill's pin recheck is a fresh observation. The service's page revision moves only on
  service-visible events, so a DOM change the page makes by itself is invisible to a purely
  synchronous check.
- **Only controlled sessions have an operation scope.** Uncontrolled sessions bypass the
  operation authority entirely: no operation ID, no scope, no journal.

## B1: when is a browser operation journaled?

**Accepted: opt-in per request, `executionRequirement: 'durable'` on `act`, `plan` and
`autofill`**, the field application execute already has (C4b), with REST, SDK, CLI and MCP
parity:
- omitted or `'ephemeral'` is today's behaviour, and `'ephemeral'` is normalized away before the
  operation identity is computed, so explicit and omitted requests share one identity (today the
  HTTP wrapper fingerprints the raw body; B-dur-2 normalizes first);
- `'durable'` requires a **controlled session** (an operation scope and an operation ID); on an
  uncontrolled session, or with no open journal, it is refused with `CONTROL_REQUIRED` before
  anything runs;
- `'durable'` is part of the operation identity.

## B2: what does one record cover?

**Accepted: one record per operation, the marker at the FIRST dispatch.** The intent is written
before the operation starts. At the first page dispatch the marker is committed and fsynced, and
only THEN does B6's recheck run, immediately before the effect — the same order the application
path uses (its qualification guard runs after the marker is acknowledged). Every later dispatch of
the same operation awaits that marker and writes nothing new.
- **Later dispatches need a qualification.** B-dur-2 adds a browser dispatch qualification the
  operation captures once and the page guard presents on every dispatch of that operation (the
  guard has no per-call context today; the qualification rides the operation's scope).
- **Terminal mapping** (the existing journaled-scope rules would otherwise lose reports):
  - the operation returns with no dispatch at all (an approval round trip, nothing to do) →
    `failed_before_dispatch`, and the caller still gets its normal response;
  - it returns after dispatching, fully successful → `completed`;
  - it returns after dispatching with a KNOWN failure in its own report (a plan step or an
    autofill field failed, an engine `STALE_TARGET` after the marker) → terminal `failed`, and
    **the report is returned as today** — never replaced by `JOURNAL_UNAVAILABLE`;
  - only an unknown outcome (the effect's result is lost: process loss, a thrown error after
    dispatch) stays `in_doubt` / `outcome_unknown`.
- A known browser failure after the marker is `failed` (dispatched), not
  `failed_before_dispatch`. **Conservative by construction:** `dispatched: true` means the marker
  was crossed, not that an effect is proven. A recheck that fails after the marker, a token that
  turned stale between the marker and its consumption, or a crash between the marker and the
  effect all leave `dispatched: true` with no effect run — classified `failed` (known) or
  `in_doubt` (crash), never claimed as completed.

## B3 and B6: what is revalidated after the storage wait, and how

**Accepted (B3): owner-level checks before the first effect; (B6) they run asynchronously, and
the remaining window is disclosed.** After the marker's fsync and immediately before the first
effect, the operation re-runs its owner's existing checks:
- `act` / `plan` (first step) / `act` batch (first step): re-resolve the target ref (revision and
  identity — the engine's own `STALE_TARGET` check), and the approval's **currency without
  consuming it** (`ApprovalGate.validateApprovalToken` for a plain token; `validateReviewedApproval`, the
  non-consuming twin of `consumeReviewedApproval`, for an `act.reviewed` approval). The approval is consumed only AFTER the marker and the recheck, so
  a refused or failed marker never burns it. The wire `act` has no navigation, so there is no navigation egress check
  on `act`; a plan's `navigate` step keeps its existing egress preflight before its own dispatch.
- `autofill` with a scope: the scoped preflight's pinned identities (URL, node and block
  identities, strategy readiness), re-observed. `autofill` **without** a scope has no pins; for
  it the recheck is the target fields' resolution only, and the evidence says so.
- Later steps and fields are checked exactly as today, before their own dispatch.

A recheck failure ends the operation with no effect; since the marker is already written it is
classified `failed` with `dispatched: true` (see B2's conservative note). **Residual (B6):** a page
change after the recheck and before the effect is still possible. That is the same window the
non-durable path has today: both storage waits (intent and marker) happen BEFORE the recheck, so
durability adds nothing inside this window.

## B4: capacity

**Accepted: browser records share the namespace's `MAX_RECORDS`.** Disclosed plainly:
- the opt-in belongs to the **caller** (the agent), not the operator; there is no operator switch
  to disable durable browser requests in this slice;
- one namespace serves every tenant, so one tenant's durable browser traffic can exhaust the
  capacity every tenant's durable **application** writes also need;
- each `APPROVAL_REQUIRED` round trip costs one record (`failed_before_dispatch`), and the retry
  needs a new operation ID.

*Alternative recorded:* a separate browser budget, or an operator switch; deferred (a budget is a
store-format change).

## B5: how a record says it is a browser operation

**Accepted: a reserved `browser` application identity.** A browser record uses the existing
application slot: adapter `browser`, resource `act`, `plan` or `autofill`, and the page's
identity as the binding generation. No store-format change, so older binaries still read the
store, and lookup shows the kind through the existing projection. The adapter id `browser`
becomes **reserved** (a real application adapter registering it is refused), so `reconcile`
always refuses browser records — which D6 wants. **Upgrade note:** a deployment that already
configures an application adapter with id `browser` is refused at startup after upgrading and
must rename it; and an OLDER binary (which does not reserve the id) reading the same store with a
real `browser` adapter could route reconcile of a browser record to it — run one binary version
per store. Browser fingerprints get their own domain
(`browser-operation:v1-durable`), so they can never collide with application identities.

*Alternative recorded:* an explicit record-kind field (a new store formatVersion; older binaries
could no longer read the store).

## What recovery can do with a browser record

Lookup shows it (adapter `browser`, its kind and classification). A record left `undispatched`
by a crash before the marker can be **closed** (D2); one left `in_doubt` can only be
**settled** (D3); reconcile always refuses it. Nothing is replayed or continued. Receipt contents
(form values) are never journaled. R08's browser portion is narrowed to classification, not
closed.

## What the review found

The design review of this page (on the code) confirmed the single-marker and capacity facts and
found that a literal reading would have been unimplementable or would have lost reports: records
could not express a browser operation (now B5); the rechecks are asynchronous and the approval
token was consumed before the marker (now B6, consumption after the marker); ordinary step and
field failures would have become `JOURNAL_UNAVAILABLE` (now the terminal mapping in B2); later
dispatches need a browser qualification through the page guard (B2); durable needs a controlled
session (B1); and the capacity, close and `ephemeral`-identity statements were incomplete (B4,
recovery, B1).

## Implementation notes (from the final design review)

- **The browser qualification guard must be able to await.** Today's guard is synchronous (the
  application qualification refuses any non-`undefined` result, so a promise fails); B6's
  re-resolve, re-observe and approval reads need their own async-capable guard path in the
  dispatch boundary, running after the marker.
- **The first approval decision stays before the marker.** Only the approval's currency
  re-validation and its consumption move after it; the initial `APPROVAL_REQUIRED` refusal (no
  token) still happens before any marker, which is what makes an approval round trip
  `failed_before_dispatch`. B-dur-1 tests this.

## Sequencing

1. **B-dur-1:** the reserved `browser` identity (refused for real adapters) and the owner-level
   rechecks with token consumption moved after the marker, each refusing on an injected page
   change during the wait. **Delivered 2026-10-15**
   ([evidence](../evidence/t5-journal-runtime.md#b-dur-1-the-revalidation-primitives-2026-10-15)):
   the primitives exist and are pinned; B-dur-2 wires them into the dispatch boundary.
2. **B-dur-2:** the protocol field with parity and `ephemeral` normalization, the browser dispatch
   qualification through the page guard, the terminal mapping, a real-store crash row per owner
   (before the marker, after the marker), and the capacity note in the operations guide.
