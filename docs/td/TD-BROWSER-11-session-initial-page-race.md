# TD-BROWSER-11: Sessions Are Page-Less by Default (Initial-Page Contract Gap)

**Status:** Corrected 2026-09-08 — original "first-launch race" framing was
wrong; see [Correction](#correction-2026-09-08). The underlying client-facing
problem is real and unresolved: nothing tells a client a fresh session has no
pages.
**Context:** 2026-09-08, brew-installed 1.8.6 and develop tip (identical
runtime code), macOS
**Related:** [TD-BROWSER-10](TD-BROWSER-10-session-extension-loading.md)
(same headed-session testbed),
[human handoff](../human-handoff.md)

## Correction {#correction-2026-09-08}

The original version of this TD hypothesized a first-launch-after-update
race in which the engine's initial page failed to register. Further testing
against the develop tip — headless and headed, wrapper-free, four consecutive
creates, pages polled at +5s/+15s/+30s/+45s — reproduced the empty page list
every time, and reading the code settled it:

- The Playwright engine creates a browser and a context in `launchBrowser()`
  but **no page**. Pages come into existence only via `newPage()`, which the
  service calls only in `createPage` (the `POST /v1/sessions/{id}/pages`
  route), plus popup adoption.
- There is no eager initial page anywhere in the service or engine, no
  timeout, no retry — because there is no bootstrap at all.

The "worked earlier the same day" observation that motivated the race theory
was an earlier session whose page had been created explicitly by the driving
client — indistinguishable from auto-registration after the fact. The Chrome
auto-update (152.0.7977.82 → .83) was coincidence.

What survives from the original TD is the actual defect: **the contract is
invisible**. `POST /v1/sessions` returns `ready` with no `pageId`, no hint
that the next step is `POST /pages`, and `GET /pages` returns `[]` — a
client that assumes a fresh session comes with a page (as every flow in the
handoff docs implicitly does) stalls with no error to act on.

## The gap, precisely

1. A fresh session is `ready` and page-less. `GET /pages` → `[]` is the only
   signal, and empty-list-reads-as-broken is a natural misreading.
2. `POST /v1/sessions/{id}/pages` is the supported creation path and works
   immediately — but its `url` request field is **ignored** (the page lands
   on `about:blank`); the client must navigate separately.
3. No documentation surface states either fact.

## Resolution options

- **Document the contract** (cheapest): create → `POST /pages` → navigate is
  the flow; empty `GET /pages` is normal for a fresh session. Update the
  handoff docs' step 1 accordingly.
- **Restore an eager initial page**: engine creates one page in
  `launchBrowser()` and the service registers it before returning the
  session. Matches client intuition (and the old default-browser mental
  model), costs one tab per session. Decide whether `GET /pages` on a fresh
  session returning `[]` is ever desirable.
- **Echo the contract at create**: even without an eager page, the create
  response could carry `pages: []` + a link/hint, making the empty list
  legible.

Until one lands, clients should treat an empty page list as "create one
explicitly", not as an error — that workaround is verified end to end.

## Original observations (kept, reinterpreted)

- `POST /v1/sessions` → 201, `status: "ready"`, healthy Chrome process tree.
- `GET /pages` → `{"pages":[]}` across 45+ seconds, six+ sessions, headed
  (branded Chrome via wrapper) and headless (bundled), brew and develop tip.
- `GET /events/replay` → `{"events":[]}` (no page lifecycle, because no page).
- Navigations addressed at an assumed initial page 404 (`NOT_FOUND`).
- Explicit `POST /pages` → 201 immediately; created page fully operable.
