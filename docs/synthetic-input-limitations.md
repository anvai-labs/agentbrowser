# Browser input trust and outcome verification

**Corrected 2026-09-14.** The former claim that all Playwright input and WebDriver
Actions produce `isTrusted: false` was incorrect. It must not drive an engine or
transport replacement.

## What the browser actually reports

Normal Playwright pointer and keyboard operations use browser input mechanisms.
The local Chromium adapter fixture produced trusted click, ordinary text-input,
and keydown events. Explicit JavaScript `dispatchEvent()` produced an untrusted
control event. Playwright documents these as different interaction paths in its
[input guide](https://playwright.dev/docs/input). The
[WebDriver Actions specification](https://w3c.github.io/webdriver/#actions) also
specifies trusted events for browser-generated actions.

The Safari adapter's individual JavaScript-based operations must be assessed
separately. Firefox and WebKit capability declarations do not establish an input
trust result for every operation. Programmatic value setters and special input
types also need their own fixtures.

`isTrusted` is neither proof of a human operator nor application authorization.
A trusted event may still do nothing because the target is wrong, hydration is
incomplete, validation failed, the control is occluded, or the application rejected
the request. Successful browser command completion is not verified task success.
The earlier live form failures did not establish `isTrusted` as their cause.

## Diagnose the interaction and its outcome

1. Observe the current page and use a fresh semantic reference. Check enabled
   state, focus, overlays, document/frame identity, and application validation.
2. Use the intended UI control when testing that UI. Direct navigation to a link's
   captured `href` can be useful automation, but does not test its click handler.
3. Verify a consequential effect independently: a destination receipt, persisted
   record, downloaded bytes, or a specific visible postcondition. A revision bump
   alone does not prove a transaction succeeded.
4. Use `upload` for file attachment and verify application acceptance. Do not infer
   success solely from setting the file list.
5. Use [human handoff](human-handoff.md) for steps that require the person. In
   [delegated sessions](delegated-sessions.md), request takeover and wait for
   `HUMAN_ACTIVE` before interacting; an already dispatched action may still finish.

No additional raw CDP input path is required to correct this premise. Keep the
engine-neutral interface and qualify alternate adapters with the same behavioral
fixtures. Never retry a consequential action merely because its response was lost.
