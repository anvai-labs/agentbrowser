# T5 B-dur: browser-operation durability, the open choices

Status: PROPOSED (design only; awaits owner sign-off). Refines D6 of the
[accepted recovery design](t5-recovery-design.md#browser-operation-durability-d6), which settled
**what** (journal `act`, `plan` and `autofill` for classification only, never recovered) but not
**how**. Implementing D6 as written meets four facts in the code that the accepted text does not
resolve. This page states them, with one recommendation each (B1–B4).

## What the code forces

- **One operation, many dispatches.** The journal models an operation as intent → ONE dispatch
  marker → terminal, and a journaled scope refuses any dispatch without a captured
  qualification (`session-authority.ts`, `trackInScope`). An application write dispatches once.
  A browser `plan` calls `act` once per step, and one `autofill` clicks and types many times
  (`autofill.ts`). So "the same intent, marker and terminal records" needs a rule for the second
  and later dispatches.
- **Capacity is shared and small.** A namespace holds `AGENTBROWSER_JOURNAL_MAX_RECORDS` records over
  its lifetime (default 10,000), and full means refused, never evicted. Browser operations are
  far more frequent than application writes; journaling them implicitly would exhaust a
  namespace and then refuse durable **application** writes too.
- **Each record costs a storage wait.** The intent is fsynced before the first effect; the page
  can change during that wait, which is why D6 requires revalidation first.
- **No owner exposes a synchronous "still current" check today** for staleness, egress and
  approval currency on the browser path; the application path has `assertDispatch`.

## B1: when is a browser operation journaled?

**Recommended: opt-in per request, `executionRequirement: 'durable'` on `act`, `plan` and
`autofill`**, the same field and semantics application execute already has (C4b): omitted or
`ephemeral` is today's behaviour, byte for byte; `durable` is refused (`CONTROL_REQUIRED`) unless
the journal is open, is part of the operation identity, and requires an operation ID. REST,
SDK, CLI and MCP parity.

*Alternative:* journal every operation-ID-bearing browser write whenever a journal is configured.
Rejected by recommendation: it silently adds an fsync to every controlled-session action and
exhausts capacity (see above) without anyone asking for durability.

## B2: what does one record cover?

**Recommended: one record per operation, marker at the FIRST dispatch.** The intent is written
before the operation starts; the first page dispatch commits the marker (rev 2) after its
revalidation (B3); later dispatches of the same operation run under that marker without new
records; the terminal (`completed` / `failed`) is committed when the operation returns. A
failure before the first dispatch is `failed_before_dispatch`; a crash after it leaves the record
`in_doubt`, which D6 says is classified, never recovered — the operator settles it (D3).

*Alternative:* one record per dispatch (per plan step / per autofill field). Rejected: it
multiplies capacity use by the step count and still could not recover anything.

## B3: what is revalidated after the storage wait?

**Recommended: before the first dispatch, synchronously, by the owner that already checks it:**
- `act`: the target ref's revision and identity (the existing `STALE_TARGET` check), the egress
  policy for a navigation target, and the approval token's currency for a gated action;
- `plan`: the first step's checks, exactly as `act` (later steps are checked as today, before
  their own dispatch);
- `autofill`: the scoped preflight's pinned identities (URL, node and block identities,
  strategy readiness) — the same set it already rechecks before every write.

Any failure is `failed_before_dispatch` and nothing is dispatched. This PR adds the hook for each
owner first (its own PR, with tests that the page changing during an injected wait is refused),
then the journaling.

## B4: capacity

**Recommended: browser records share the namespace and its `MAX_RECORDS`**, documented as such
(opt-in per request keeps them rare); no second namespace or quota in this slice. Operators who
want headroom raise `MAX_RECORDS` on the next rotation.

*Alternative:* a separate browser budget inside the namespace. Deferred: it is a store-format
change (a new formatVersion) for a problem B1 already makes rare.

## What stays out

Receipt contents (form values) are never journaled; nothing is replayed, continued or
reconciled for browser operations; R08's browser portion is narrowed to classification, not
closed. History, lookup and recovery (J3) apply unchanged: a browser record classifies like any
other and can only be settled.

## Sequencing, once signed off

1. **B-dur-1:** per-owner revalidation hooks (B3), each refusing on an injected page change.
2. **B-dur-2:** the protocol field and opt-in journaling (B1, B2, B4) with parity, a real-store
   crash row per owner (before marker, after marker), and the capacity note.
