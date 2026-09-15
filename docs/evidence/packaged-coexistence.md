# Extracted-package coexistence acceptance

The release acceptance harness now exercises delegated control against extracted
server modules and the compiled MCP executable. This closes the gap between the
[source/Victor scenario](victor-chromium-coexistence.md) and package acceptance.
The compiled CLI still runs the existing live snapshot/action checks in the same
acceptance invocation.

## Contract and outcome evidence

The operator attaches, prepares review, delegates and takes over using the real
`/operator` page. The diagnostic child uses native browser input to simulate a
human edit only after takeover completes. Those driver hooks remain confined to
the acceptance child; production control continues through REST.

The compiled MCP process must expose exactly the eleven delegated tools, with
creation, closure and cookie administration absent. Acceptance checks typed fill
mismatch, value-free verification success, a completed operation receipt,
duplicate suppression and overlapping receipt/session queries. After takeover,
the old process cannot read or write. A new grant starts a second process while
the old process remains connected and revoked. Old element references fail;
fresh observations include the human edit.
The delegated subprocess receives only its grant; the owner's server key map is
removed from its environment.

A separate HTTP fixture records actual browser click effects. It must receive
exactly `[{trusted:true,value:""},{trusted:true,value:"human edit"}]`, including a
final assertion after session closure. MCP success payloads alone cannot pass
this check. Native pages, both MCP processes, API children and fixture listeners
must close successfully. Each fixture workflow closes before the next begins,
so diagnostic page lookup cannot confuse driver IDs reused across sessions.

## Local evidence and reproduction

On macOS arm64 with Node 24.11.1, Bun 1.4.0 and qpdf 12.3.1, all seven packaged
acceptance groups passed against the clean `b11eca692a5a1510820563d9b37529d7497c835a`
server archive and clients compiled from that snapshot. The extracted dependency
closure contained 96 packages and 132 dependency edges; API, engine, policy and
Playwright resolved inside the extraction. Stock network/download refusal checks
passed separately from the instrumented loopback fixture.

The new catalog tests first failed on the valid bound catalog and an unknown
catalog selector. The operation-header test first failed because the HTTP helper
dropped caller IDs. After the harness fixes, all 36 packaging, HTTP/process and
MCP smoke regression tests passed. No production behavior was changed.
Including PDF artifact validation, the local script suites passed 41 tests.
Required workspace typecheck, lint and build passed, followed by 1,485 passing
tests and 14 existing platform skips with native Firefox and Victor enabled.

From a clean, built checkout, compile both clients and package the server using
the existing scripts. Use unused output directories outside the checkout to keep
the package's version/commit stamp clean. Extract the archive, then run:

```sh
PLAYWRIGHT_BROWSERS_PATH=/absolute/existing-browser-cache \
node scripts/package-acceptance.mjs \
  --server-root /absolute/extracted/server \
  --expected-version 1.8.13 --expected-commit FULL_COMMIT_SHA \
  --cli /absolute/compiled/agentbrowser \
  --mcp /absolute/compiled/agentbrowser-mcp \
  --report /absolute/unused-report.json
```

Existing CI and release packaging jobs already invoke this entrypoint, so they
automatically enforce the added scenario. There are no new jobs, dependencies,
provider calls or cross-repository checkouts. Local debugging used no GitHub
runners. The baseline profile retains its explicit unsupported results.

This is native local artifact acceptance, not evidence of publication, a live
human/model task, or a guarded Firefox service. Victor's public MCP client has
separate source/native evidence; this package gate exercises the compiled MCP
transport without requiring the companion repository in CI.
