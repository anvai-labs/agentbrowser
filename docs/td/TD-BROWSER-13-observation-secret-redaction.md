# TD-BROWSER-13: Observation secret redaction

**Status:** Implemented (2026-10-06)
**Severity:** Release blocker for real-secret browser automation
**Incident:** `docs/AGENTBROWSER_PASSWORD_OBSERVATION_HANDOFF_2026-10-06.md` (operator
credential observed in plaintext in an `observe` response; synthetic-only reproduction here —
the real credential never appears in this repository, its tests, or its logs)

## Root cause (synthetic reproduction on HEAD 1318cae)

Playwright 1.62.1's `ariaSnapshot()` emits **plaintext values for password inputs**. A
`<input type="password">` snapshots as role `textbox` with an inline value:

```
- textbox "Password": <the password>
```

Both ARIA value syntaxes the parser accepts (`textbox "Name": value` inline and the
`/value:` child annotation) carry the secret with **no input-type information**, so nothing
downstream could tell a password from a search box. Reproduced through the full engine path
(`fill` → `observe`): the canary appeared in the observation response, the refStore-published
element, and — a second channel — `canonicalFingerprint`'s `value_<raw>` segment, which core
places in `ActionEffect.targetFingerprint` and in STALE_TARGET mismatch messages. A third
channel: `captureNativeFormEvidence` inventoried `input[type=password]` values verbatim into
operator-reviewable form evidence.

`captureFormEvidence` already excluded password/hidden values, but (a) it only *adds* evidence
(it never removed an ARIA-parsed value), and (b) it is conditional on
`include:["formControls"]`, so default observations had no protection at all. The existing
fill-mismatch redaction (`sensitive` flag / password probe) protected only VALUE_MISMATCH
details — a different path.

## The trusted boundary

One classification boundary at the point where an element is bound to a live DOM node — the
only place the engine can know an input's type. Everything upstream of it treats snapshot
values as **untrusted**:

1. **Policy installation** — `context.addInitScript(sensitivityPolicyInit)` installs a
   per-context, per-frame-document policy (`__agentbrowserSensitivePolicy`) at session
   creation (launched contexts and best-effort on CDP-adopted operator contexts). The init
   function is fully self-contained: Playwright serializes page functions, so module-scope
   references would be `undefined` in the page.
2. **Untrusted carrier** — `parseAriaSnapshot` writes values to `untrustedValue`, never
   `value`. Promotion to the published `value` happens only after classification says the
   bound node is not sensitive.
3. **Classification** (in the element's own frame context, so frame-hosted controls classify
   against their own document):
   - native `input[type=password]` / `input[type=hidden]` — always sensitive;
   - `autocomplete` tokens `current-password`, `new-password`, `one-time-code` —
     policy-sensitive (labels can never establish safety; these tokens are explicit
     credential semantics);
   - a node **marked** by an explicit sensitive fill (`action.sensitive`) or by any fill/type
     into a policy-sensitive input — the mark is a page-context `WeakSet` keyed by node
     identity, so it survives show-password type toggles and ref revisions, and dies with
     the node (the element lifetime the guarantee covers).
4. **Fail closed** — a dead frame context, a missing policy (a document predating a CDP
   attach), or any probe error classifies as sensitive: the value is withheld and
   `valueRedacted: true` is set. An unbound element (type never established) never promotes
   its carrier — unvalidated ARIA values are dropped, not carried as fallback.
5. **Publication** — sensitive elements are published with `valueRedacted: true` and no
   `value`, in observations, the refStore (so fingerprints cannot embed the secret), native
   form evidence (`value: ''`, `valueRedacted: true`), and every downstream projection
   (core normalization, API envelopes, MCP tools, extraction, CLI rendering).

Ordinary (non-sensitive) values are preserved everywhere — bulk-autofill verification depends
on them; the positive-control tests pin this.

### Documented exception: hidden inputs in native form evidence

`captureFormEvidence` (observations) excludes hidden inputs, as before. Native form evidence
(used by the application-witness tamper comparison) **keeps hidden values** with
`valueRedacted: false`: its hidden-drift check needs those page-generated tokens, and hidden
inputs are not a user-typeable channel, so credentials do not flow through them by fill. This
is the one deliberate divergence between the two surfaces.

## Honest boundaries — what this does NOT protect

Stated plainly so no consumer reads `valueRedacted` as a promise it is not:

- **Screenshots / PDFs** of a page showing a toggled-to-text password show the secret
  visually. Inherent to visual capture; not fixable by value redaction.
- **Raw HTML export / `browser_html`** reflects the DOM's *attributes*; filled values live in
  properties and do not serialize, but a page that itself writes secrets into attributes (or
  moves a filled secret anywhere in its DOM) will have them captured by any raw-content
  surface.
- **Console/network ledgers** contain whatever the *page* logs or transmits, including a
  credential legitimately supplied to it. Arbitrary page JavaScript can always exfiltrate a
  secret it was given.
- **Show-password toggles**: the value is withheld in observations for the node's lifetime,
  but the page's own DOM still holds it; anything reading the DOM directly (HTML export) sees
  the toggled plaintext.
- The default deployment's `SecretManager` registers no secrets, so every
  `secretManager.redact(...)` call downstream of the engine is an identity function. That is
  why the engine boundary — structural classification, not registered-secret matching — is
  the effective control for this class.

## Qualification (synthetic canaries only)

`packages/engine-playwright/src/observation-redaction.test.ts` (7 tests) covers: native
password under default and `formControls` observation; autocomplete current/new-password and
one-time-code; explicit sensitive fills across show-password toggles and back; same-origin
frame hosting; repeated observation (refStore/revision reuse); action results, mismatch
details and `resolve()` fingerprints; and the ordinary-field positive control (verification
with expected/actual intact). API-level: `plan-real-chromium` asserts the post-fill
observation is canary-free; `evidence-boundaries` covers the merged events envelope.

Observation overhead on a bounded 120-element fixture (100 text + 10 password + 10 buttons,
10 observes after warmup, same machine): before mean 1027.1 ms / p50 1086.8 ms; after mean
980.6 ms / p50 1028.6 ms — no regression (the probe is role-gated and runs in the existing
parallel pass).

## Consumer-visible changes

- `PageElement.valueRedacted` (protocol, engine `RawElement`, normalized observations,
  OpenAPI): absent `value` + `valueRedacted:true` means "withheld", not "empty".
- `NativeFormControlEvidence.valueRedacted` (always present; parser-enforced).
- Autofill receipts for sensitive controls: `status:"unverified"` +
  `verificationWithheld:true` — never a false mismatch (a false "failed" would invite a
  credential double-write).
- `fill`/`typeText` mark their target for the node lifetime; VALUE_MISMATCH details withhold
  expected/actual for policy-classified inputs even without `sensitive:true`.
- Approval-gate action fingerprints are per-instance-keyed HMACs instead of bare SHA-256
  (they cover full action JSON including fill values; an unkeyed digest of a low-entropy
  secret was brute-forceable offline).
- SDK `sessions.events` object selectors always resolve to the `{events, nextCursor}`
  envelope (limit-only used to return a bare array, crashing formatted CLI output); an
  unfiltered object selector returns the merged console+request view instead of an
  always-empty envelope; the CLI uses one envelope code path for all flag combinations.

## Deployment

Values are classified in the engine at observation time — the fix requires **restarting the
service binary** (brew/systemd/container as deployed); no schema migration, no client update
required (all new fields are optional). Sessions created before the restart keep the old
behavior for their lifetime.
