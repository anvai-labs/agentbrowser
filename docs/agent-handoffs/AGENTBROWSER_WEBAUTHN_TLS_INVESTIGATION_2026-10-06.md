# WebAuthn TLS investigation — 2026-10-06

Incident (from `AGENTBROWSER_PASSWORD_OBSERVATION_HANDOFF_2026-10-06.md`): in a headed
identity session on the deployed service, a native WebAuthn `navigator.credentials.create()`
was rejected with `NotAllowedError: WebAuthn is not supported on sites with TLS certificate
errors.` on `https://id.anvaiops.com`, a public origin that passes curl trust validation.
No TLS bypass was knowingly enabled. All diagnostics below are synthetic (no cookies, no
credentials, no attestation submitted; CDP virtual authenticator, random challenge/user).

## What was ruled out (with evidence)

1. **Simple fetch/fulfill interception** — the responder's own diagnostics (fresh context,
   virtual authenticator, with and without a bare `route.fetch`/`route.fulfill` handler)
   succeeded; repeated with installed Chrome 154 (issuer YE1, HTTPS 200, securityDetails
   present). Confirmed by reading `/private/tmp/ab-webauthn-tls-diagnostic.cjs` and
   `/private/tmp/ab-webauthn-tls-chrome-diagnostic.cjs`; their teardown amendment
   (`unrouteAll({behavior:'wait'})` before close) is present — the earlier favicon teardown
   exception is addressed.
2. **Current HEAD engine + full production egress path** (`/private/tmp/ab-webauthn-engine-repro.cjs`):
   the real `PlaywrightChromiumEngine` with a default `NetworkPolicy` — i.e. verdict-gated
   `route.fetch`, Node-side redirect walk, synthetic-302 re-commit, body-buffered fulfill,
   `serviceWorkers:'block'`, WS deny — **WebAuthn succeeded** headless AND headed (branded
   Chrome), HTTPS 200 / TLS 1.3 / issuer YE1.
3. **Deployed-binary drift**: the installed brew 1.15.1 engine
   (`/opt/homebrew/Cellar/agentbrowser/1.15.1/.../engine-playwright`) contains the same
   egress design (POST/PUT/PATCH `route.continue` passthrough, redirect walk, synthetic
   302, body-buffered fulfill). No `ignoreHTTPSErrors` anywhere in engine git history.
4. **The exact deployed configuration** (`/private/tmp/ab-webauthn-deployed-151.cjs`,
   `/private/tmp/ab-webauthn-post-commit.cjs`): the installed 1.15.1 engine driven with
   the 5709 service's own environment (`PLAYWRIGHT_BROWSERS_PATH=/opt/homebrew/var/agentbrowser/browsers`,
   `AGENTBROWSER_ALLOWED_CIDRS=192.168.1.89/32`, `AGENTBROWSER_MAX_RESPONSE_BYTES=33554432`):
   - GET document commit (fulfill): **succeeds**, headless and headed.
   - Redirect-chain commit (`/` → `/ui/login` through the walker + synthetic 302):
     **succeeds**, headless and headed.
   - POST-passthrough commit (synthetic empty form POST → `route.continue`): **succeeds**
     (headless; the headed repetition landed on `chrome-error://` because the IdP rejects
     the garbage POST — a harness artifact, not the incident shape, where the page loaded).
5. **Deployment launch flags**: the running 5709 service (PID at investigation time) has no
   `AGENTBROWSER_CHROMIUM_ARGS`, no proxy variables, no TLS-related environment. Nothing
   that bypasses or intercepts certificate validation.

## Residual hypotheses (not reproducible from here)

- **Time/network-state-dependent origin condition during the incident window**: a
  transient state of the origin's certificate chain as Chrome's Root Store / CRLite saw it
  (renewal rollover, CT or revocation data lag), or the operator's network path at that
  hour. Current-state tests cannot observe this; everything validates cleanly now, through
  the whole engine stack, in every commit mode.
- **A step in the operator's actual logged-in navigation sequence** that synthetic flows do
  not mirror (e.g. an intermediate navigation committed while a certificate error state was
  cached). Testing that would require the incident session's identity flow, which is out of
  bounds for this session by handoff instruction.

## Recommendations

1. **Retry passkey enrollment now** through the service: the current origin state validates
   cleanly through the deployed engine in every tested commit mode. Device enrollment was
   reported incomplete; keep the existing credential until a replacement plus recovery path
   exist (per handoff).
2. If the rejection recurs, capture at that moment, synthetically:
   `agentbrowser session events --type request.finished` (the CLI envelope bug that blocked
   this is fixed in this release), the landing URL, and a rerun of
   `/private/tmp/ab-webauthn-deployed-151.cjs` — its per-scenario output distinguishes a
   page-level TLS state from an authenticator-level cause.
3. Do not enable any TLS bypass as a workaround (none was found configured, and any such
   flag would itself produce this exact WebAuthn refusal).
