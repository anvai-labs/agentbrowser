# Security handoff: password value exposed by observation

Sandesha production qualification observed a real password in the JSON response to
`agentbrowser observe` after a successful password fill. Do not reproduce or copy
the actual credential into an issue, test, screenshot, log or fixture. Treat this as
a confidentiality bug. A correct masked visual input is not sufficient redaction.

Observed client: CLI 1.15.1, headed Chromium, login at the operator's identity
provider. The returned element had role textbox, name Password, and a plaintext
`value`. The fill used a stdin plan; the leak occurred in the later observation.
The operator was notified; credential rotation remains a Sandesha closeout item.
No claim is made that the current repository HEAD is the deployed service binary.
Source examined here: 1318cae (clean checkout at examination time).

## Likely paths to review

`packages/engine-playwright/src/index.ts`:

- `parseAriaSnapshot` accepts both inline values and `/value:` annotations without
  knowing the DOM input type.
- `captureFormEvidence` excludes password/hidden values, but the observer only
  adds its value when defined; this does not remove a value already parsed from
  the ARIA snapshot. A source guard on one path cannot sanitize a prior source.
- The observation then records `element.value` in refStore and returns elements.
- Existing fill-mismatch redaction protects a different path and does not fix this.

These are source-review findings, not a synthetic reproduction on HEAD. Confirm
which path produced the value before declaring root cause or release fixed.

## Required fix and qualification

At the final trusted DOM-binding boundary, remove password/hidden/sensitive values
before persistence, diffing, snapshot/report serialization or response emission.
For elements whose type cannot be safely established, do not expose potentially
sensitive cached values. Review unbound/stale/frame fallback paths as well. Honor
explicit sensitive fills when a password widget toggles to visible text.

Use only generated synthetic canaries. Test both ARIA value syntaxes, default
observe and formControls, password visibility toggles, same-origin frames, stale
bindings, repeated observations/refStore/diffs, CLI/MCP/API envelopes and action
failures. Preserve ordinary non-sensitive form values required by bulk autofill.
Do not label all form observations safe after fixing only the native-form helper.

Sandesha workaround currently captures JSON in memory, removes ALL value fields
and URL query/fragment data before displaying selected roles/names. This is only a
consumer-side output mitigation: it does not prove the server did not retain data.
Review service logs/artifacts for any password persistence without displaying it.

Hand back the exact source/release, synthetic regression evidence, server restart
requirements and retention/remediation findings. Never include the real password.

## Owner-authorized parallel-session implementation handoff

Owner explicitly requested that the AgentBrowser session drive this defect while
Sandesha continues identity MFA/passkey enrollment. Treat credential-output safety
as a release blocker for real-secret browser automation. Do not use real customer
passwords, cookies, TOTP seeds, recovery codes or vault data as test fixtures.

### Source findings reconfirmed

At local HEAD 1318cae, `packages/engine-playwright/src/index.ts`:

- `parseAriaSnapshot` around 3046 accepts `/value:` and inline values without
  sensitivity context (assignments near 3072 and 3110).
- `captureFormEvidence` near 453/535 excludes native password/hidden values.
- Observation near 2889 assigns the helper value only when present; it never
  deletes a previously parsed sensitive value. This helper is also conditional
  on `include: formControls`, so ordinary observations need independent protection.
- Ref-store publication near 2944 retains the parsed value.
- Fill mismatch protection near 3770–3793 recognizes password/sensitive inputs,
  but that protection is local to mismatch errors. Do not describe `sensitive`
  as an end-to-end observation or artifact guarantee.

These are verified source gaps consistent with a real observed leak, not a completed
synthetic root-cause reproduction or proof that this exact source built the service.
CLI remains 1.15.1. Capture deployed server/engine identity separately.

### Required design and implementation

1. Introduce one trusted sensitivity classification/redaction boundary before
   refStore, diff state, serializer, telemetry and external tool results. A native
   password field is always sensitive. Explicit sensitive-fill classification must
   persist for the element lifetime across show-password toggles, revisions and
   frame-bound observation. Include autocomplete current/new-password and OTP
   handling under documented policy; labels alone cannot establish safety.
2. Do not retain unvalidated ARIA values as fallback when DOM binding/type lookup
   fails. Mark evidence incomplete and omit unsafe values. Avoid indiscriminately
   breaking non-secret form evidence used by the bulk-fill contracts.
3. Redact action payloads, expected/actual mismatch values, cached observations,
   error causes and relevant artifact/export paths. Never echo a secret into a
   locator/name or a value-derived ref/identifier. Audit elementFingerprint and
   similar value-derived identifiers as well as the obvious `value` property.
4. Define honest boundaries for HTML/text extraction, screenshots, PDFs, downloads,
   console/network ledgers and arbitrary page JavaScript. An intentionally unsafe
   raw-HTML surface must not silently bypass a session's secret-protection policy.
   Mask or refuse unsafe capture where necessary. Never promise that arbitrary
   malicious pages cannot exfiltrate credentials legitimately supplied to them.
5. Longer-term integration: accept an opaque, narrowly authorized vault-secret
   reference, resolve it inside a trusted local broker, fill only the bound HTTPS
   origin and freshly identified field, and return a redacted success/mismatch
   receipt. No secret in model context, argv, environment, ordinary logs or files.
   Preserve SentinelPass master-password step-up for grant creation/mutations;
   automatic retrieval grants remain exact-entry/read-only. This is a separate
   integration milestone, not a prerequisite to fixing observation redaction.

### Acceptance matrix (synthetic only)

Cover both ARIA value syntaxes; observe default/formControls; repeated observe,
refStore and diff reuse; native password and show/hide transitions; explicit
sensitive text fills; frames and detached/stale/unbound elements; verification
success/mismatch/timeout; CLI/MCP/REST/plan envelopes; traces and logs/artifact paths.
Search canaries in returned structures AND persistent/cache outputs. Include a
positive ordinary-text-field test to preserve legitimate autofill verification.
Measure observation overhead on identical bounded fixtures before/after; report
raw values and do not waive a security failure for speed. Keep resources bounded.

### Release and hand-back

Work on an isolated branch from current develop; preserve this untracked handoff
and other work. Reproduce first, implement, run focused + required CI, review, then
promote/release using repository policy and owner authorization. Do not restart a
shared service while another session is actively using it without coordination.
Hand back source SHA, release/version, deployed engine identity, regression evidence,
performance delta, retention/remediation findings and exact restart instructions.
A consumer filter alone is not completion. Do not delete incident evidence blindly;
report locations/categories of potentially affected records without their values.

Sandesha status: exposed sign-in credential is stored in SentinelPass entry 53,
flagged rotation required. Existing identity policy requires MFA; passkey enrollment
is proceeding with user presence. No replacement password/TOTP seed will be driven
through the affected browser service before the fix is qualified. Do not access or
mutate the Sandesha identity session from the AgentBrowser parallel session.

## Additional blocker: real passkey ceremony rejected as TLS-invalid

Same headed identity session, 2026-10-07 01:59–02:00 UTC: native WebAuthn create
rejected with `NotAllowedError: WebAuthn is not supported on sites with TLS
certificate errors.` Public `https://id.anvaiops.com` passes normal curl trust
validation. No TLS bypass was enabled as a workaround. Device enrollment is NOT
complete; no new credential was saved. Do not remove the current credential until
a real replacement and recovery path are established.

Controlled diagnostic evidence: a fresh cookie-free Playwright context with a
synthetic CDP virtual authenticator succeeded on the public origin both without
interception and with a simple route.fetch/route.fulfill. Repeating with installed
Chrome 154 also succeeded in both cases (issuer YE1, HTTPS 200, securityDetails
present). That repeat had an unrelated in-flight favicon teardown exception after
both results; fix the harness teardown before treating it as a clean test run.
Thus a blanket claim that fetch/fulfill alone causes the failure is NOT supported.
Compare the deployed engine's full egress/redirect flow, existing-context navigation
history, actual document TLS state, and native vs virtual-authenticator behavior.
Do not treat virtual-authenticator success as a real-device enrollment acceptance.

Local synthetic diagnostic scripts (no cookies/real credentials):
`/private/tmp/ab-webauthn-tls-diagnostic.cjs` and
`/private/tmp/ab-webauthn-tls-chrome-diagnostic.cjs`. They never submit attestation
to the IdP. Teardown was amended to await unrouteAll, not yet rerun at this point.

CLI diagnostic gap: `agentbrowser session events ...` formatted output failed with
`undefined is not an object (evaluating 'envelope.events.map')`, while global
`--json` returned a top-level array. The requested console.log type returned mixed
lifecycle/error/debug/log entries. Reconcile deployed API/CLI envelope and type
semantics; output must not encourage agents to dump raw credential-bearing logs.

Sandesha will keep the identity account and vault mutation coordination here.
Do not close/restart active browser sessions without coordinating with the owner.
