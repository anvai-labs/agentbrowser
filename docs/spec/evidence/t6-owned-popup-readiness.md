# T6 owned-popup and readiness qualification

Base: develop `1d7f37becee9fd24c024e0c4ac35998321823983` after Q0a #236.
Scope: [owned-popup design](../design/t6-owned-popup-readiness.md).
This is a bounded T6 increment; reusable mapping, arbitrary ATS/library qualification,
rollback, production job submission and durable recovery are not completed here.
The current public release remains 1.9.1; this slice follows the develop PR gate.

## Reused owners and behavior

Both named widget strategies now use one shared typeahead helper in the existing
Autofill service loop. It opens/types once into the stable, uniquely matched focused
control, then requires one visible/enabled exact option in its proven owned popup.
Comparison trims surrounding whitespace and otherwise preserves case. Page-wide,
first-match, prefix and case-folded selection are removed. The strategy-specific
immediate/final commitment predicates, field receipts, policy and authority guards
remain shared with the existing orchestrator.

The Playwright adapter extends its existing WeakMap identity capture with one ownership
index per observation and refreshes it before custom dispatch. Unique ARIA relationships
supply opaque popup/control tokens. Option evidence includes the owner's existing
identity context, focus, visibility and enabled state, so owner/fieldset or relationship
changes invalidate even an unchanged option node. Native actions do not rebuild this
index. No new dependency, engine, executor, endpoint, transport or CI job was added.

Pending readiness is distinct from missing engine capability. No current relation or one
unmounted target may be pending: one open/type is allowed on the independently resolved
control, but no option click occurs without proof. Invalid/missing engine popup-state
metadata refuses before opening. Ambiguity, focus loss or identity drift stops; pending
absence permits one immediate read plus at most maxReobserve extra reads separated by
settleMs. The same overall cooperative deadline applies. A partially affected field is
uncertain and stops the suffix even with onAmbiguous=skip. Writes are never replayed.

## Falsifying evidence

Local execution used Node 24.21.0 and synthetic data. Initial red tests ran before their
respective repairs; actual-browser tests used isolated Chromium instances/local servers.

| Probe | Evidence |
| --- | --- |
| Initial API ownership/readiness probes | 16 failed / 21 passed against the old selector |
| Initial engine ownership/dispatch probes | 9 failed / 3 passed before ownership evidence |
| Additional adversarial engine probes | 6 failed / 12 passed before global incomplete-index and owner-context guards |
| Final `autofill.test.ts` | 46 passed, including zero/limited read budgets, late and never-declared ownership |
| Final engine `autofill-evidence.test.ts` | 19 passed, including a portal positive and no-effect drift/ambiguity controls |
| Actual `autofill-real-chromium.test.ts` | CLI and stdio both passed; same five-field payload and negative controls |
| Combined engine/API suites | Passed with two existing API skips; mandatory hooks repeat full workspace gates before publication |
| Documentation and context checks | Relative links and all 82 manifest selections passed |

The actual-surface fixture places an identical foreign option earlier in document order,
refuses duplicate owned options, checks commitment/membership failures and duplicate
operation refusal, and records selections independently at the fixture server. No
submit occurs. CLI executes the compiled command via the existing runAgentCli helper,
supplies JSON on stdin and keeps the delegated token out of argv. The CLI case opens no
MCP bridge. Source CLI qualification is not installed/Bun release qualification.

Fixed 2s/2.5s/1.5s sleeps per widget were replaced with immediate observations and
policy-controlled waits only for pending readiness. In one combined local run the full
expanded CLI fixture took 9.3s and stdio 6.0s (including negative cases and setup). These
are scoped fixture observations, not a live-site SLA or a portable speedup claim.

Independent adversarial review challenged ownership completeness, owner-scope drift and
the pending contract; final working-tree review is clean. The PR records the final SHA,
required CI and merge result; this file does not preclaim publication or integration.

## Limits and next slice

The ownership index accepts at most 10,000 indexed DOM nodes, 1,024 total ARIA-reference
characters per control and 32 distinct references. Incomplete indexing invalidates all
custom ownership evidence rather than proving uniqueness from a partial set. DOM query
allocation, renderer calls and deadlines are cooperative, not hard resource isolation.
DOM observation and click are not atomic against hostile scripts. Shadow DOM, frames,
virtualized/offscreen and keyboard-only widgets need separate qualification.

Follow with the versioned mapping/private-profile join and the existing
[job-workflow checkpoint](../design/t6-job-application-checkpoint.md), using the same
CLI/REST/SDK autofill and verification seams. Qualify the concrete widget shapes before
live use; keep private resume values and authenticated account state outside fixtures,
shared specification context and repository history.
