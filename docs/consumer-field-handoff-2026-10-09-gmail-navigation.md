# Field handoff: Gmail navigation fails in a headed signed-in session (2026-10-09)

**Consumer:** Sandesha inbound mail smoke. **Installed CLI and live service:**
AgentBrowser 1.15.2, headed Chromium 154, macOS. **Status:** reproducible;
root cause unproven. No mail was sent through AgentBrowser and no cookie/password value is included
here. The original cookie export remains only at `~/.gmail_cookies.txt`.

**Subsequent control test:** the operator sent one synthetic message manually
from their regular Gmail window. Google connected to the Sandesha VPS on
port 25; Postfix queue `119573D4A6` received `250 2.0.0 Message queued`
from the local mail engine at 2026-10-09T05:13:32Z. The engine was healthy
and Postfix queue empty afterward. This proves a browser-independent inbound
SMTP path, but does not resolve AgentBrowser's Gmail navigation failure or
independently prove inbox rendering.

## Observed sequence

1. Created a dedicated headed session with `--cookies-file
   ~/.gmail_cookies.txt --cookies-format chrome-devtools-tsv
   --allow-service-workers --idle-timeout 3600000 --ttl 7200000`.
   Session create succeeded. `https://www.google.com/` loaded and its semantic
   snapshot showed a signed-in Google Account indicator, so the cookies were
   recognized by at least Google's account surface. No account address is
   needed to reproduce this failure.
2. Direct page creation/navigation to
   `https://mail.google.com/mail/u/0/#inbox` returned
   `TRANSPORT_ERROR: Response unavailable; reconcile the operation before
   retrying`; the page stayed `about:blank` or disappeared from the session.
3. On the successful Google home page, clicking the observed `Gmail` link
   (`e2_3` from a fresh snapshot) hung until `ACTION_TIMEOUT`. Server log at
   2026-10-09T05:08:30.149Z records that code for session
   `ses_1791522357232_83bfo8ecb`, page `pg_5_page-1`.
4. A single `https://gmail.com/` page-create attempt timed out. It briefly
   appeared as `about:blank` in page list, then disappeared. A later page
   list for the session returned `[]`; no action should assume that page still
   exists. A snapshot of the Google page also timed out after the Gmail
   attempt. The AgentBrowser health endpoint remained healthy throughout.
5. Independent `curl -I -L https://mail.google.com/mail/u/0/` from the host
   reached Google and got normal login redirects without cookies. A first
   sandboxed curl could not resolve the hostname; an unsandboxed curl did.
   That is shell sandbox behavior, not yet evidence of the browser's cause.
6. At the operator's request, closed only the failed Gmail session and
   created a **fresh** headed session `ses_1791522646930_onnb87p9c` with
   the same cookie file. Its first page creation targeted
   `https://gmail.com` directly. After about 30 seconds the CLI returned
   `NAVIGATION_TIMEOUT: Navigation failed: engine_error`; `page list` then
   returned `[]`. This confirms the failure does not depend on first opening
   Google home. The OVH Manager session was left untouched.

The service's normal log shows successful Google navigation and then an
`ACTION_TIMEOUT`, but no explanatory browser/process or network diagnostic for
the Gmail failure. We cannot tell from these observations whether Gmail's
navigation, AgentBrowser's egress policy, Chrome page lifecycle, session
transport, or another issue caused it. Do not label this a bot challenge or
cookie problem without evidence.

## Requested investigation and acceptance

- Reproduce with a synthetic/nonpersonal Google account and a dedicated
  headed session. Preserve the exact failing URL and compare Google home,
  `gmail.com`, and `mail.google.com` navigation in the same session.
- On `TRANSPORT_ERROR`, `ACTION_TIMEOUT`, or a vanished page, emit a bounded
  structured cause with correlation ID and page/process lifecycle state.
  Scrub cookies, tokens, personal mailbox content, and full redirected login
  URLs from diagnostics.
- Distinguish browser target crash/close, navigation timeout, policy denial,
  DNS/TLS failure, and service-client transport failure. Ensure page list and
  session operation reconciliation describe the final state consistently.
- Add regression tests for timeout/crash during navigation and click-driven
  navigation; a failed attempt must not silently discard unrelated pages in
  the same session. Verify the live headed smoke before release.

**Operational note:** Do not restart the current service until the unrelated
active OVH Manager session has been closed or its operator agrees; the browser
service has active sessions. Its stderr currently warns that it has no API
keys and `AGENTBROWSER_ALLOW_LOOPBACK` enabled. Those are separate local
security-configuration findings; do not conflate them with the Gmail failure.

## Handoff prompt for the AgentBrowser session

> Investigate the 2026-10-09 headed Gmail navigation failure in
> `docs/consumer-field-handoff-2026-10-09-gmail-navigation.md`. Reproduce with
> nonpersonal fixtures, identify the actual failing layer, add redacted
> diagnostics and regression tests, then validate with a live headed smoke.
> Preserve active sessions until the operator clears them. Do not assume the
> cookies are invalid or that a send occurred.
