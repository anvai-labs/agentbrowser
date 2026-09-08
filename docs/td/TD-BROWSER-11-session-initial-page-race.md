# TD-BROWSER-11: Initial Page Not Registered at Session Create (First-Launch Race)

**Status:** Observed live — root cause not yet isolated; workaround documented
**Context:** 2026-09-08, brew-installed 1.8.6 against real branded Chrome
**Related:** [TD-BROWSER-10](TD-BROWSER-10-session-extension-loading.md)
(same headed-session testbed),
[human handoff](../human-handoff.md)

## Observation (reproduced twice, same conditions)

A headed session create on macOS returned a healthy-looking session whose
page list stayed empty indefinitely:

- `POST /v1/sessions` → 201, `status: "ready"`, engine `playwright-chromium`.
- The engine's Chrome process tree was fully up — main process plus GPU and
  utility helpers, launched with the wrapper's `--load-extension` args
  (the TD-BROWSER-10 `AGENTBROWSER_CHROME_PATH` path).
- `GET /v1/sessions/{id}/pages` → `{"pages":[]}` at +8s, +23s, +56s.
- `GET /v1/sessions/{id}/events/replay` → `{"events":[]}` — the page never
  even emitted lifecycle events.
- Client navigations addressed at the assumed initial page 404'd
  (`NOT_FOUND`, empty `pageId`).
- A second create under identical conditions behaved identically.

The trigger condition is believed to be Chrome's first launch after an
in-place browser update (152.0.7977.82 → 152.0.7977.83 had landed between the
last good create and these). Earlier the same day, the same binary path and
wrapper auto-registered `pg_N_page-0` about 3 seconds after create. Not
reproduced on demand yet — the update only lands once.

## Why this matters

- Anything that assumes `pages[0]` exists after a `201` create — which
  includes every flow in the handoff docs that observes "the" page — has no
  page to act on, with no error surfaced: the session just looks empty.
- The failure is silent by construction: engine construction resolved (the
  session is `ready`), so the bootstrap's stall lives downstream of the
  readiness signal. There is no timeout, retry, or diagnostic around the
  initial-page registration.

## Workaround (verified live)

`POST /v1/sessions/{id}/pages` creates a page explicitly and returned 201
immediately on the very session that was stuck; the created page is fully
operable (navigate/observe/act). Two quirks worth keeping in any first-class
fix or doc:

- The route's `url` field is **ignored** — the page comes up on
  `about:blank`; navigate separately.
- `GET /pages` before the explicit create kept returning `[]`, so
  "list, then act if non-empty" is a sound guard: treat an empty list as
  "create one explicitly", not as an error.

## Open questions for a first-class fix

1. Where exactly does the bootstrap stall — engine `newPage()` on a
   first-launch-after-update Chrome, or the service's registration of the
   page it returns? The empty event stream suggests the page object never
   reached the engine's ledger.
2. Should the service ensure the initial page with a bounded retry (the
   SnapshotBudget pattern), or is create-then-explicit-create the supported
   contract that belongs in the docs? The current state is the worst of
   both: an implicit page that is neither guaranteed nor documented.
3. Does the headless pool share the bootstrap path? All observations here
   are headed/wrapper launches; headless creates have not shown the stall.
4. Reproduction harness: launch a build of Chrome marked "updated"
   (fresh-user-dir first run) under the engine and instrument
   `newPage()` timing; alternatively simulate a slow CDP attach in the
   testkit to exercise the service side.

## Non-goals

- Changing the session `ready` semantics (readiness ≠ page-exists is a
  separate, arguably correct, contract — but it must be documented either
  way).
- Auto-retrying inside `POST /sessions` beyond a bounded initial-page
  bootstrap.
