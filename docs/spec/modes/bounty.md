# Mode: researcher-directed bug-bounty assistance

Status: T10 B1–B6 operator workflow, layered on appsec.

## Two windows, two contracts

Use the dedicated persistent **operator Chrome browser** for identity, policy
vetting, signup and exploration. Attach with `cdpAttach` only after configuring
the explicit unenforced-egress acknowledgment. This window has navigation
preflight checks, **no network containment and no enforced rate limit**; the
researcher follows the current program policy and published traffic cap manually.
Diagnostics label it unenforced. Headed contexts can still be fingerprinted.

Use a separate **scoped evidence session** for a short, authorized reproduction.
It enforces program hosts, paths, methods, exclusions, expiry, request budget and
pacing at covered network hops, injects configured research markers, and records
an engagement ledger. Cookies and localStorage may be transferred once, by the authenticated human
operator, into this fresh context. No profile files or other browser stores move.
See [ADR-027](../../adr/027-evidence-pass-state-transfer.md).

## Three-command workflow

Prerequisites: a configured local service with its dedicated operator Chrome,
CDP acknowledgment, private engagement store and human-operator key file; current
server policy explicitly permits `cookie.seed` and `cookie.handoff` for the
selected program domains. Review the brief, exclusions and testing permission.
Import is assistance, not authorization. Add required public research headers to
the resulting scope before reproduction; never put credentials in marker values.

```bash
agentbrowser scope import brief.json --from h1 --pages-planned 3 --rate-limit 5/1 --out scope.json
agentbrowser session create --tenant research --mode bounty --cdp-attach
agentbrowser --operator-key-file /private/path/operator-keys.json session create --tenant research --evidence --from SOURCE_ID --origins https://app.example.com --scope-file scope.json
```

Use the second command's session id as `SOURCE_ID`. Between commands two and
three, browse and log in manually in the attached Chrome window, on authorized
program targets. Select the exact origins whose state may transfer. The sample
5/s is appropriate only when the program permits it; use its published cap.
The final command creates a fresh headed, scoped, ledgered session and returns
its id. Transfer failures close the unpublished target; API keys cannot approve transfer.

The three commands reach an evidence session; reproduction and sealing remain
explicit: CLI creation returns `pages: 0`, so use `page create EVIDENCE_ID --url URL`,
reproduce, then `session close EVIDENCE_ID` and `engagement export ENGAGEMENT_ID
--out ledger.jsonl`. Verify the sealed ledger with `engagement verify ledger.jsonl`
before checking findings and exporting SARIF. MCP's ordinary session creation
includes an initial page. Transferred credentials keep the existing export refusal
and action-review floors; transfer does not grant an action lease.

## Defaults and rendering support

Bounty mode selects headed creation, idle 1h, TTL 4h and 5/s contained pacing.
Explicit session settings win; service timeout defaults precede the preset.
Existing scope caps stay fixed; CDP remains unenforced. Budget roughly 120
subrequests/redirect hops per JS-heavy page, at least 150 for one page, within
program policy. See [operations](../../operations.md#engagements-authorized-testing)
for overrides, support-host bundles, denial summaries and asset adoption commands.

Assets are classified static GET/HEAD subresources from program pages, never
interactive SSO/captcha, documents or fetch/XHR. Scoped Playwright contexts enforce
`worker-src 'none'` from creation; Worker/SharedWorker UI may be unavailable.
Worklets remain outside qualified containment. They receive no program
markers or credentials. A human operator can append asset hosts with a matching
revision and durable ledger, retaining page state/counters; program targets and
other constraints remain fixed ([ADR-028](../../adr/028-operator-asset-scope-amendments.md)).

## Limits

Distinguish suspected and confirmed findings; track duplicates. Ledger marker events prove
dispatch intent, not remote receipt. Neither transfer nor asset access expands the
documented browser/worker containment boundary. Reports remain drafts; submission is manual.
