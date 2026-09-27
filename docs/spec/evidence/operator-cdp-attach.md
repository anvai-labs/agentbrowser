# Operator CDP attachment qualification

Date: 2026-09-25. Candidate source based on develop `26a863d`; unreleased.
The package version remains 1.11.0 until a release checkpoint. This evidence describes
built candidate code, not the installed Homebrew binary or the existing service.

## Failing-first tests

- API admission: 15 failures / 1 control pass before implementation. The selector was
  ignored, producing ordinary sessions. The resulting matrix covers missing config,
  missing acknowledgement, hosted/multiple tenants, remote peer/listener, incompatible
  options, unsupported adapters, and forwarding the existing policy.
- CLI selector: 1 failure / 127 controls pass before implementation.
- MCP selector: missing advertised/forwarded field failed before implementation.
- Independent review found unauthenticated loopback profile access unsafe: two additional
  tests failed before requiring configured bearer keys. Authenticated single-trust-domain
  creation now also proves missing credentials fail on later session/page requests.
- MCP page-provisioning failure leaked the newly created session: failing cleanup test,
  then common create-path cleanup preserving the original failure.
- Engine ownership tests cover reservation, setup failures, last-owner cleanup, late pages,
  popup lineage, close failure, repeated shutdown, cookie export and explicit navigation
  preflight. Real defaults are preserved with `noDefaults: true`; an exact call regression
  failed before that option was added to the operator connection.

Focused final results: 21 attachment tests + 29 existing ownership tests, 13 diagnostics
checks, 28 API startup/admission tests, 128 CLI tests, and 78 MCP create/runtime tests pass.
Workspace build, type-check and lint passed; the full normal commit hook passed.
A final embedding-config regression rejects truthy string acknowledgements and invalid
deployment modes. The Playwright dependency minimum now matches the already-locked
1.62.1 because preserving default-context settings requires the `noDefaults` option;
no resolved dependency version changed.
The doc-link checker passed 886 relative links before this evidence page was added.

## Headed real-browser smoke

Executed after building the candidate, using a separate Chrome process and disposable
profile, independent observer connection, ephemeral authenticated service and local
HTTP fixture:

```bash
node scripts/cdp-attach-smoke.mjs --live
```

Final observed output:

```json
{"live":"Yahoo AAPL","status":"success","title":"Apple Inc. (AAPL) Stock Price, News, Quote & History - Yahoo Finance"}
{"qualification":"PASS","productVersion":"1.11.0","browserVersion":"154.0.8037.57","endpointClass":"loopback_http","profileSharing":true,"unownedTabsPreserved":true,"ownedPopupAdopted":true,"detachPreservedBrowser":true,"disabledRefusal":"CDP_ATTACH_DISABLED"}
```

The fixture proved profile sharing with a non-sensitive cookie marker, without exporting
cookies. CLI creates/navigates; SDK inspects create/get/list facts, inventory and refusal;
MCP creates an attached session/page; REST proves the missing-config refusal. Existing
operator tabs and unowned popups stayed out of inventory. The owned popup was adopted.
Closing the session left the operator tab and debugging endpoint alive. Only the smoke's
own profile/process was removed afterward. The logged-in background service was not
restarted or altered.

Both product and observer connections use the locked Playwright 1.62.1's `noDefaults`
option, avoiding a qualification client that itself changes operator context settings.

## Limits

Yahoo success is an observation, not a future bot-wall guarantee or proof of device
trust. Network containment is deliberately unavailable for attached-profile traffic;
only initial explicit navigation URL checks are claimed. The separate lifecycle work
must report disconnection honestly; this lane does not infer a manual close or crash.
Browser-owned downloads remain outside service enforcement and collection. Browser
profile sharing has no tenant isolation, so hosted/delegated/multi-tenant use refuses.

See [design](../design/operator-cdp-attach.md) and
[operations](../../operations.md#attach-to-a-dedicated-operator-chrome-profile).
