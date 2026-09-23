# U0 operator application binding

Merged as #261 at `5421d07`, preserving head `811c9d2` and reviewed tree
`d89ad776`. Independent exact-head review returned SHIP. PR run `35755516728`
and post-merge run `35756180259` each passed all eight checks without reruns.
Normal commit and push hooks each passed 3,344 tests with 24 existing skips. The
[design](../design/t4-operator-application-binding.md) extends only the existing
operator document and its api/handle/refresh owners. ApplicationAuthority, public
binding/discovery routes, credentials, schema ownership and consent are unchanged.
No dependency, backend endpoint, CI job or default harness payload is added.

## Qualification

The initial browser regression failed because no application binding display existed.
Independent review then identified old binding details remaining visible while attaching
a slow session. A new test reproduced that failure before shared action handling was
corrected to render synchronous invalidations immediately.

Eight new real-Chromium panel cases cover binding/discovery/unbinding, required fresh
review and application-mode delegation, unknown/foreign targets, revoked discovery,
foreign sessions, delayed discovery after attach, Forget during a dispatched bind,
stale control polls, superseded create chains and finalizers, immediate stale display
clearing, keyboard activation, and text-safe rendering. They use the existing draft
fixture and real server/authority; the backend browser port is FakeEngine. Busy UI
and malicious display values are explicit response-injection negative controls, not
claims of malformed server output. Existing application authority/race tests cover
server refusal; existing real-browser coexistence covers actual page effects.

The focused existing operator/coexistence/application/race suite passed before the
last display correction (25 pass, 2 conditional Victor skips); the eight new browser
cases passed after it. Full hook and CI delivery results are recorded at merge.

## Limits and remaining work

This qualifies synthetic operator binding UI, not a production adapter or account.
Control/discovery bracketing is best-effort: same-epoch changes remain possible and
server admission is authoritative. Discarding stale output cannot undo an already
sent request. Forgotten session creation may leave a session until its configured
expiry; no automatic cleanup mutation runs under new credentials.

Receipt reconciliation UX remains U1; actual production source and independent UI/API
qualification remain P0c/P1. T4 is active, not complete. Release 1.9.1 is unchanged.
