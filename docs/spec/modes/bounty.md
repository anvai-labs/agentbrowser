# Mode: researcher-directed bug-bounty assistance

Status: T10 B1–B6, layered on appsec.

## Two windows, two contracts

Use dedicated persistent **operator Chrome** for identity, policy vetting, signup
and exploration. CDP attachment requires the explicit unenforced-egress
acknowledgment. This window has navigation preflight, **no network containment
or enforced pacing**: follow current program targets and traffic caps manually.
Diagnostics label it unenforced.

Use a fresh **scoped evidence session** for a short authorized reproduction.
Covered hops enforce hosts, paths, methods, exclusions, expiry, budget and pacing,
inject configured markers and record a ledger. The authenticated human operator
can transfer selected program-origin cookies/localStorage once; profile files and
other stores never move. See [ADR-027](../../adr/027-evidence-pass-state-transfer.md).

## Three-command workflow

Configure private ledger storage, an operator key file and `cookie.seed`/
`cookie.handoff` grants for selected domains. Vet program authorization, exclusions
and required public research headers; import is not permission. Never put
credentials in marker values.

```bash
agentbrowser scope import brief.json --from h1 --pages-planned 3 --rate-limit 5/1 --out scope.json
agentbrowser session create --tenant research --mode bounty --cdp-attach
agentbrowser --operator-key-file /private/path/operator-keys.json session create --tenant research --evidence --from SOURCE_ID --origins https://app.example.com --scope-file scope.json
```

Use command two's id as `SOURCE_ID`; browse and log in manually between commands
two and three. Select exact origins. Use 5/s only if the program permits it.
Command three creates a headed, scoped, ledgered context. Failed initialization
closes the unpublished target. API keys cannot authorize transfer.

Reproduction/sealing are explicit subsequent steps. CLI creation returns `pages: 0`:
use `page create EVIDENCE_ID --url URL`, reproduce, then `session close EVIDENCE_ID`
and `engagement export ENGAGEMENT_ID --out ledger.jsonl`. Run `engagement verify
ledger.jsonl` before checking findings/SARIF. Transferred credentials retain export refusal and action-review floors; no action
lease is granted by transfer.

## Defaults and rendering support

Bounty mode defaults to headed, idle 1h, TTL 4h and contained pacing 5/s. Explicit settings/service timeout defaults override the preset; existing caps
stay fixed and CDP stays unenforced. Budget roughly 120 subrequests/hops
per JS-heavy page, at least 150 for one page, within program policy.

Assets permit classified static GET/HEAD subresources from program pages, without
program markers or credentials; documents, fetch/XHR and interactive SSO/captcha
do not qualify. Human operators can append assets with a matching revision and
durable ledger, retaining page state/counters; program targets and other constraints
stay fixed ([ADR-028](../../adr/028-operator-asset-scope-amendments.md)). Scoped
Playwright contexts enforce `worker-src 'none'`; Worker/SharedWorker UI may be
unavailable. Worklets remain outside qualified containment.

See [operations](../../operations.md#engagements-authorized-testing) for support-host
bundles, denial summaries, adoption commands and response-delivery bounds. Marker
events prove dispatch intent, not receipt. Distinguish suspected/confirmed findings;
reports are drafts and submission is manual. No expanded containment claim is made.
