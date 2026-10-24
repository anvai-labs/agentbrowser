# Sandesha capture timeouts: investigation and bounded-deadline handoff

Status: observed production browser-tool failure; root cause not isolated. This
handoff requests investigation and implementation in the AgentBrowser session.
No service restart, timeout-policy change or AgentBrowser source edit was made by
Sandesha. Preserve the active headed session until it is closed or disposable.

## Reproduction and evidence

On October 12, AgentBrowser CLI/service 1.16.1 drove headed Chromium 154 on macOS
against the approved owner-only https://mail.sandesha.app preview. Source reviewed
at `15cbfdbb2a7244a660fa93e02366412317ec87da`, branch `chore/backsync-main-3`.
A matching package version alone does not prove the running service uses these
exact source bytes: check installed binary provenance before attributing a fix.

Session `ses_1791844558354_v34ax4dkw`, page `pg_16_page-0` was active at capture.
These IDs are ephemeral; do not rely on them surviving this handoff. The owner
completed real passkey/OIDC and agreement acceptance; do not copy session cookies,
private mail or credentials into fixtures, logs or a public issue.

Observed sequence (CLI output, not inferred application outcomes):

1. Calendar navigation succeeded. A default `observe` subsequently returned
   `TIMEOUT: Request timeout; outcome may be unknown` (default CLI request budget).
2. A later bounded observation with `--timeout 15000`, `--max-elements 70`,
   `--max-bytes 10000`, role filters and `--limit 20` succeeded, reporting the
   calendar controls. Larger filtering limits later also succeeded.
3. `screenshot --format jpeg --quality 70 --mask-sensitive --out <private file>`
   with `--timeout 15000` timed out. No successful screenshot was claimed.
4. After opening a synthetic received message, an attachment-name observation
   with the default budget timed out. A later `--timeout 10000` observation with
   bounded output succeeded. The attachment control then worked.
5. Independent redacted network events showed the synthetic attachment download
   through `/api/mail/jmap/download/...`: HTTP 200, 91 bytes. The same session had
   no request to public `api.sandesha.app`. Calendar create/reload/delete and mail
   send/receive worked. At the calendar timeout, VPS web/engine were active and
   idle (one sampled CPU value 0%; roughly 62/100 MiB). This is corroboration, not
   proof that the application or timing never contributes.

Commands, using a freshly authorized synthetic test session:

```sh
agentbrowser --json observe SESSION PAGE
agentbrowser --json --timeout 15000 observe SESSION PAGE \
  --max-elements 70 --max-bytes 10000 --roles heading --roles alert \
  --roles button --limit 20
agentbrowser --json --timeout 15000 screenshot SESSION PAGE \
  --format jpeg --quality 70 --mask-sensitive --out /private/tmp/synthetic-capture.jpg
```

Do not infer that role/byte projection fixed the slow stage. `service.observe()`
currently calls `observeInternal()` before pagination/projection; those flags are
output bounds, not demonstrably reduced engine work. Hydration, stale queued
capture work, a frame/font wait or another transient may explain the difference.
Likewise no exact wall-time or screenshot bytes are asserted from a timed-out CLI.

## Existing controls: reuse rather than duplicate

- `packages/cli/src/cli.ts:309`: global `--timeout`, default 30000; wired to SDK
  HTTP timeout. This is a client transport deadline, not a server cancellation
  guarantee. Its integer validation and help text deserve explicit tests.
- Same file around 545: session `--snapshot-timeout`, documented range 1..30000,
  default 5000. Session idle expiry is separate (10 minutes by default).
- `packages/engine-playwright/src/snapshot-evidence.ts`: `snapshotTimeout()`,
  `AGENTBROWSER_SNAPSHOT_TIMEOUT_MS`, `SnapshotBudget` and frame-budget slicing.
  Playwright zero means unlimited: expired budgets must never be passed as zero.
- `packages/engine-playwright/src/index.ts:2727`: `observe()` uses that snapshot
  budget. Around 3134 there is already a comment/fix for per-element enrichment
  latency. Measure its actual installed behavior; do not blindly implement it twice.
- `packages/api/src/service.ts:2875,2905`: full engine capture precedes projection;
  optional readiness waiting is a different stage. Around 3612 readiness defaults
  to 5000; capture/wait schemas allow an explicit wait up to 300000.
- `packages/engine-playwright/src/index.ts:4509`: screenshot invokes Playwright
  without an explicit timeout in the inspected call. Check inherited defaults,
  font waits, redaction lifecycle and service wrapper before assigning causality.
- `packages/sdk-typescript/src/client.ts:275,350`: AbortController bounds the HTTP
  client; timeout currently gives generic uncertainty even for a safe capture.
- API observe/screenshot routes in `packages/api/src/server.ts` are marked
  `safe: true`. Preserve operation reconciliation for writes; a client disconnect
  does not prove an action did not happen.

## Proposed design, subject to measurement

1. Add or expose ONE server-enforced overall capture budget, covering queue wait,
   optional readiness, frame capture, binding/enrichment, masking, rendering,
   normalization and artifact publication. Reuse existing primitives. An additive
   `budgetMs` / `--capture-timeout` could distinguish it from transport timeout and
   readiness timeout; choose names consistently across REST, MCP, SDK and CLI.
2. Server/operator policy owns a validated default and hard maximum. Suggested
   starting experiment: overall capture default 20s, maximum 60s; snapshot slice
   remains 5s unless explicitly configured and can never exceed remaining total.
   These are proposed experiment values, not existing settings or a final tuning
   decision. Resolve compatibility with existing 300s explicit readiness waits:
   reject impossible combinations clearly or document total-budget precedence.
3. Per-request/session overrides may request a smaller/larger budget only within
   server policy. Clients cannot enlarge an operator cap. Validate finite integer
   bounds, NaN/Infinity/negative/zero/overflow consistently. Report the effective
   budget and whether policy clamped it, or reject oversize requests explicitly.
4. Advertise capability/default/max in server discovery/health and CLI `describe`.
   SDK/CLI transport should normally allow server deadline plus a small bounded
   response grace (e.g. 5s). An explicitly shorter transport deadline stays a
   client choice with a clear uncertainty warning; it must not imply cancellation.
5. Carry one monotonic deadline and cancellation signal through the work. Queue
   time counts. On disconnect/deadline, cancel/settle subordinate operations and
   clean transient masks/handles/artifacts. A bare Promise.race is insufficient if
   the losing work still runs, mutates revision or publishes an artifact later.
   If Playwright cannot cancel safely, return/retain a bounded in-progress state
   and quarantine only the affected capture/page; never kill unrelated sessions.
6. Emit compact, secret-redacted timeout facts: request/operation ID, stage,
   elapsed/effective budget, queue delay, cancelled versus unresolved, and safe
   retry/reconciliation guidance. Omit form values, page text, cookies, tokens,
   raw private URLs and screenshot bytes. Safe capture timeout messaging should
   distinguish missing read evidence from an uncertain write without weakening
   the existing mutation journal and no-blind-retry contract.
7. On exhausted semantic capture, return explicit degraded/partial coverage only
   where existing rules permit it; never silently label incomplete coverage as a
   complete observation. Redaction failure/deadline must not publish an unmasked
   screenshot. Screenshot failure must not produce an empty successful artifact.
8. Check for wasted engine work after CLI timeout and per-page queue congestion.
   Consider bounded parallel enrichment and frame budgets before raising defaults.
   Do not move role filtering before ref/coverage computation without proving
   stable refs, frame isolation, complete-scope semantics and redaction parity.

## Acceptance tests and engineering evidence

Use local synthetic pages: calendar-like grids, changing mail panes, large forms,
iframes, slow fonts, loading placeholders and a deliberately stalled renderer.
Do not benchmark on private mailbox contents.

- REST/MCP/SDK/CLI parity for default, boundary, override, cap and malformed input.
- Stage timers show where budget was spent; output is bounded and secret-free.
- Timeout during each stage and client disconnect: no orphan task, handle,
  temporary mask, unowned screenshot artifact, session leak or stale ref publish.
- Queued request deadline and later independent read succeed without restarting
  the shared server. Other active sessions remain undisturbed.
- Injected write timeout still returns uncertain outcome and reconciles exactly
  once. A read retry never accidentally becomes action replay.
- Deliberate password/secret canaries remain redacted in every timeout/error,
  degraded response, screenshot and artifact metadata path.
- Compare current versus candidate capture p50/p95/p99, timeout rate, CPU, RSS,
  completed/abandoned task counts and response bytes; record Node/Chromium,
  fixture size, concurrency and installed digest. Keep output/coverage identical
  where claiming a performance gain.
- Existing snapshot evidence, frame coverage, stale-ref, real Chromium capture,
  wait, timeout diagnostics and publication/cancellation suites remain green.

First determine whether a later release already fixes this. Reproduce on the
installed release and candidate before making another change. Follow repository
CI/review/release policy. Do not restart the Brew service under a live Sandesha
session; coordinate the eventual upgrade and then rerun synthetic plus headed
Sandesha acceptance checks.

## Companion prompt

Read `docs/agent-handoffs/SANDESHA_CAPTURE_TIMEOUT_HANDOFF_2026-10-12.md`.
Investigate the observed observe/screenshot timeouts against the installed build.
Reuse current timeout controls; implement a server-owned bounded end-to-end
capture deadline with explicit defaults/caps, per-request overrides, cancellation
and compact diagnostics only where missing. Preserve secret redaction, stable
refs and uncertain-write reconciliation. Start with failing synthetic tests,
measure current/candidate behavior, drive CI/fresh review, and hand back exact
release/configuration guidance. Preserve active Sandesha browser sessions.
