# T10 flow continuity P1: functional resource hosts and auth lifecycle

Status: accepted for the approved P1-5/P1-6(+A4) increment (2026-11-03); independent
review before merge. Implements the resource-class extension of
[ADR-028](../../adr/028-operator-asset-scope-amendments.md) and activates the
seed-from-cdp utility and live-reseed gates designed in
[ADR-033](../../adr/033-cookie-seed-provenance-and-reseed.md). Rotation detection
stays advisory exactly as ADR-033 bounds it.

Source: the 2026-10-30 handoff's P1-5/P1-6 acceptance — a Vinted-shaped scope must
complete signup+verification without manual scope edits (blocking `dd.vinted.lt`
or `cdn.cookielaw.org` broke flows in ways that looked like app bugs), and a
rotation death must be diagnosable and recoverable without destroying the session.

## P1-5 — the `resource` host class

The carrier stays `assetHosts` (the non-program host list); its `class` gains a
second literal, `resource`, alongside `asset`. Semantics, restrict-only and
disjoint from program hosts exactly as ADR-028:

| | `class: 'asset'` (unchanged) | `class: 'resource'` (new) |
| --- | --- | --- |
| Purpose | static delivery (scripts, styles, media) | functional dependency the target's own flow calls |
| Methods | GET/HEAD only | GET/HEAD/OPTIONS/POST |
| Engine lane | attributed static subresources | the same attribution **plus** page-initiated fetch/XHR to the host |
| Never | navigation/iframe destination, finding target, credential carrier | the same |
| Budget | counts (pacing is protective) | counts |

POST is what the functional vendors actually do (DataDome telemetry, captcha
challenge delivery, consent receipts). A resource host is operator-chosen and
disjoint from program targets, so the exfiltration surface it adds is the
operator's explicit selection — the page could always exfiltrate to program
hosts. PUT/PATCH/DELETE stay refused: no functional dependency needs them.
Response caps, the base policy, empty-Cookie and stripped-authorization hygiene,
and program method/scheme/port/exclusion/expiry/budget rules all still apply;
program path rules never authorize resource hosts. Redirects reclassify per hop
as today. Findings never bind to non-program hosts (existing scope binding), so
"not testing targets" holds by construction.

Starter lists: the scope-import support-host bundles gain per-host class labels —
the POSTing endpoints (`geo.captcha-delivery.com`, `api.hcaptcha.com`, DataDome
collector hosts) become `resource`; static CDNs stay `asset`. Bundles remain
suggestions, never authorization.

**Transport note (resolved in this increment):** during qualification a
pre-existing engine bug surfaced: a page-initiated CROSS-ORIGIN BODY-BEARING
fetch died with `net::ERR_FAILED` under the choke point — reproduced with plain
program hosts, no transforms, and even a bare immediate `route.continue()`
(same-origin bodies and cross-origin GETs were unaffected; raw Playwright
passes, so the trigger is the engine's interception composition). Fix:
cross-origin bodies now ride the inspected lane (Node-side `route.fetch`
re-issue with the original `postDataBuffer` forwarded explicitly, redirect
walk, response caps) — strictly better than the guaranteed failure, with the
S3-style byte-fidelity caveat applying to this lane as documented. A related
hardening also landed: the transform's explicit empty Cookie (a route.fetch-ism)
is no longer injected on the guard's native continues, where it independently
poisons the browser's CORS credentials check.

## P1-6a — rotation detection (advisory)

A scope may carry `authRotation: { refreshUrlPattern, identityUrlPattern }` —
both required bounded patterns, operator-configured, never inferred (a pattern
that cannot compile is refused at session creation, never a silently-never-
matching detection config). When the choke-point records show a navigation
matching the refresh pattern followed (within the same page, bounded window of
20 requests) by a 401/403 response on the identity pattern, exactly one
advisory ledger event (`auth.rotation-suspected`, origin+path only) is appended
and the scope status carries the sticky `authRotation.suspected` hint (the
reseed-needed signal; it sticks until the session ends). Same-page correlation
uses a stable per-page key the engine adds to request records (never part of
the ledger allowlist); unattributed records — redirect-walker hops, probes —
are ignored rather than guessed at. Advisory only: no DOM identity inference,
no automatic login, no scope change, no auto-reseed, and detection never gates
traffic. Without the scope field there is no detection (no guessing). The
pattern syntax is the product's one URL-pattern convention (glob or
`/regex/flags`), shared with the wait `urlPattern` so the spellings cannot
drift.

## P1-6c — `seed-from-cdp` (operator-side utility)

CLI-only, per ADR-033's bounded design: read an already-open operator Chrome over
loopback CDP, select default or an explicitly identified incognito context, read
tab-context `Network.getCookies` for the selected domains (never browser-wide
`Storage.getCookies`), domain-filter, classify, and write the versioned seed file
mode 0600. It never starts a browser, reads profile storage, or touches a
service. Multiple candidate incognito contexts require explicit selection.

## P1-6b — live reseed (the ADR-033 activation gates)

An operator-authenticated route (`POST /v1/operator/sessions/:id/reseed`, operator
key only; CLI `session reseed`), bound to tenant + live context + seed digest.
Sequence: durably ledger the authorization (expected scope revision, seed digest)
→ exclude new browser input → establish network quiescence (no in-flight
requests; bounded wait, refuse otherwise) → bump the auth generation (prepared
actions, approval tokens and input leases die even on an unchanged document) →
engine cookie replacement (clear + add under quiescence) → register new secrets
for redaction → ledger completion. Old scope accounting (budget spent, pacing
history, expiry, exclusions, ledger limits) is preserved verbatim — renewal is
never a fresh grant. Unknown/partial outcomes leave the session unable to write
under old authority; no auto-replay. A documented clone fallback is out of scope
for this increment (refuse instead).

## Qualification

Local fixtures only (a functional-resource receiver exercising static+XHR POST
lanes and their refusals; a rotation-bounce fixture; a reseed round trip with
quiescence, generation invalidation and ledger records). Live Vinted/Wolt
acceptance remains pending operator verification.
