# Firefox guarded-service promotion gate

Status: **public page interception failed the promotion gate**. Native local
Firefox remains available; policy-bearing service sessions refuse creation.
The failure is preserved in regression tests, not waived by engine registration.

## Decision-changing hypothesis

Can the pinned Puppeteer/native Firefox BiDi combination enforce request denial
before a destination is contacted, across redirects, frames, worker fetches,
popup-first navigation and WebSockets, while preserving ordinary navigation?
Can it inspect actual response bytes before delivering an oversized body?

The first candidate is the public Puppeteer interception API installed before
navigation. A popup hook installed after creation is included deliberately to
test the startup boundary, not assumed to be an enforcement mechanism.
Fixtures use only owned loopback listeners and temporary browser profiles.

Every denied channel needs an allowed positive control with destination-side
evidence. A handler callback is not proof of denial. Unknown or absent evidence
fails the gate; zero traffic without a successful control is inconclusive.
The report must retain which candidate and browser versions were tested.

Stop condition: any denied destination hit, unproven target startup boundary or
unavailable pre-delivery body limit blocks guarded-service promotion. Do not
strip policies, silently disable unsupported paths, replay mutations through a
Node fetch, introduce an undocumented TLS interception proxy, or claim an opaque
CONNECT tunnel can inspect response bodies. Passing these probes alone would
still not prove DNS pinning or OS containment.

## Implementation sequence

1. Define an engine-independent evidence verifier with failing tests for missing
   controls, bypass traffic, mismatched versions and incomplete coverage.
2. Run bounded native Firefox fixtures against independent HTTP/upgrade counters.
3. Preserve observed limitations as executable qualification evidence; a changed
   browser result requires review rather than automatically enabling a service.
4. Exercise the guarded REST/MCP refusal path so registration cannot waive policy.
5. Record the result and select the next mechanism only from the measured gap.

This engineering gate does not authorize host firewall changes, CA installation,
production deployment or a new GitHub runner job. Run locally first; reuse the
existing pinned Firefox Test job for regression qualification.

## Measured result

The [raw local report](evidence/firefox-egress-155.0.1.json) records Puppeteer-core
25.11.0 with native Firefox 155.0.1 on macOS arm64. Each of the nine channels
passed its allowed positive control and contacted the independent destination
once. Probe setup and interception errors were empty.

| Denied channel | Destination hits | Denial callbacks | Result |
| --- | --- | --- | --- |
| Navigation | 0 | 1 | Blocked in fixture |
| Redirect chain | 0 | 1 | Blocked in fixture |
| Frame | 0 | 1 | Inconclusive: completion timed out |
| Page fetch | 0 | 1 | Blocked in fixture |
| Dedicated-worker fetch | 0 | 1 | Blocked in fixture |
| Shared-worker fetch | 1 | 0 | Bypassed page interception |
| Service-worker fetch | 1 | 0 | Bypassed page interception |
| Popup first navigation | 0 | 1 | Inconclusive: completion timed out |
| Page WebSocket | 0 | 1 | Blocked in fixture |

The response probe read content successfully, after 65,536 body characters had
already reached the document. The response was chunked without Content-Length.
This corrects the earlier response-content availability assumption; it does not
prove an actual-byte cap before delivery. The public
[response.content API](https://pptr.dev/api/puppeteer.httpresponse.content)
also warns that returned content may be re-encoded. DNS connection binding,
target startup ordering and forced egress remain unverified by this probe.

The popup hook enumerates canonical top-level pages. Firefox exposes frame
targets with `type() === 'page'` too; manufacturing a page facade for each such
target produced invalid interception setup and was corrected before recording
this report. Zero denied frame/popup traffic is retained as inconclusive rather
than credited as proof of startup enforcement.

Linux CI also observed a denied popup request before interception was enabled
([run 34980561505](https://github.com/anvai-labs/agentbrowser/actions/runs/34980561505)).
The report retains `Denied request was not paused: /target/popup` as an error,
and the verifier rejects it with `probe-errors`. The native regression permits
only this specific known race in its error list; other errors still fail the
test. Deterministic tests require rejection whether the destination counter is
zero or one, and an actual hit adds `popup:destination-reached`. The earlier
macOS report remains a historical observation, not a guarantee of popup denial.

## Regression and reproduction

- `pnpm test:egress-evidence` checks missing coverage, malformed counts, failed
  controls, destination bypasses, version mismatches and unverified boundaries.
  The suite first failed on the absent verifier, then passed its four tests.
- `pnpm firefox:install` followed by `pnpm test:firefox` includes the native
  egress regression using the pinned browser. Ordinary developer test runs skip
  native Firefox only when its executable is not configured; CI configures it.
- `pnpm probe:firefox-egress` prints a fresh JSON report and deliberately exits
  **1** for this rejected candidate. Do not use its exit status as a green
  regression expectation: the native test asserts the measured limitations.
- `pnpm test:coexistence` includes REST, SDK and MCP refusal with a launch spy,
  a default-engine fallback spy and a session-leak check.

Upstream changes that eliminate a bypass require requalification and an evidence
update. The offline verifier is a consistency check for trusted probe reports;
it neither authenticates reports nor enables a runtime capability. These are
bounded fixtures, not comprehensive containment proof or Linux qualification.

## Next mechanism

The [session-wide BiDi follow-up](firefox-session-bidi-gate.md) has now tested
one direct protocol owner against the same independent destinations. It also
measured shared-worker and service-worker bypasses. Retain trusted local Firefox
and stop driver expansion under the page-scope hypothesis. A supported upstream
fix or materially different mechanism must justify reopening promotion; do not
attach a competing network owner to the current adapter.

The accepted authenticated gateway and DNS-pinned connection authority remain
complementary work: they can constrain destination connections but an opaque
CONNECT tunnel cannot supply browser response-body enforcement. Service
promotion still requires all accepted transport guarantees. This change adds
no dependencies, CI jobs, host networking changes or GitHub workflow runs.

References: [accepted transport design](egress-transport-design.md),
[Firefox/application scope](firefox-and-application-seams.md),
[Puppeteer BiDi support](https://pptr.dev/webdriver-bidi), and
[Firefox remote-agent security](https://firefox-source-docs.mozilla.org/remote/Security.html).
