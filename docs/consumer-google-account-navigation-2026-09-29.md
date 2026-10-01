# Headed Google account navigation stalls — 2026-09-29

Status: observed; root cause unresolved. This is not evidence that new tabs
are generally broken. No application password was created during these probes.

## Environment and observations

- macOS, agentbrowser CLI and running REST service 1.13.0; headed Chrome.
- Gmail operated successfully using an explicitly authorized cookie import.
- Opening Google App Passwords in a second page reached fresh Google sign-in.
  Later observations stalled around Google account/session redirect endpoints;
  snapshots also timed out or returned internal errors. Authentication completion
  was not established.
- Creating a separate headed session, importing the current authorized cookies,
  explicitly creating a blank page, and navigating to Google App Passwords also
  returned a CLI timeout with an unknown outcome. A later page inspection reported
  the page active but still blank.
- Navigating that same fresh page to https://example.com/ with
  `--wait-until domcontentloaded` returned success immediately. Page creation and
  basic navigation therefore work in this new session.
- A subsequent Google App Passwords navigation using `domcontentloaded` did not
  return promptly either. Switching the readiness condition alone is not a
  verified workaround.
- The REST health endpoint remained healthy throughout these probes. Service
  health does not establish that a particular browser page is responsive.
- Earlier combined `page create --url` attempts timed out; separate page creation
  and navigation made the remaining page easier to inspect. This does not establish
  whether Google redirects, cookie state, browser state, or service orchestration
  caused the original timeout.

## Consumer guidance

1. CLI sessions are deliberately page-less. Explicitly create a page before
   navigating. Do not conflate this contract with a broken initial tab.
2. After a timed-out navigation, reconcile page state before further actions.
   Never retry a send, credential creation, or revocation solely because its
   response timed out.
3. When a tab appears stalled, try one separate headed session and a harmless
   public navigation as a control. Preserve the original authenticated session.
4. Imported Gmail cookies do not prove Google account security settings are
   authorized. Fresh password/passkey/MFA may still be required from the user.
5. Do not log raw authentication redirect URLs or page titles: Google session
   redirect titles may contain URLs with session credentials. Report host/path
   only, excluding query, fragment, title, cookies, and generated app passwords.

## Follow-up engineering investigation

- Reproduce with deterministic fixtures: second-page navigation, a separate
  headed session, cross-origin redirect chains, and intentionally stalled loads.
- Inspect cancellation and page-ledger reconciliation when the CLI request
  times out while the underlying browser operation continues.
- Ensure diagnostics distinguish navigation timeout, observation timeout,
  service transport failure, and successful page creation.
- Test redaction of authentication data in URL/title diagnostics, rather than
  relying only on screenshot field masking.
- Do not label Google bot protection, passkey UI, or a tab-handling regression as
  the cause without supporting evidence.

Related: [initial-page contract history](td/TD-BROWSER-11-session-initial-page-race.md).
The older document describes a different version and must not be read as proof
that the current CLI ignores `page create --url`.
