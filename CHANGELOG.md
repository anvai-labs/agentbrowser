# Changelog

All notable changes to **AgentBrowser** are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are tagged `vX.Y.Z` and
built by `.github/workflows/release.yml` (binaries + server tarballs on GitHub Releases;
`@anvailabs/agentbrowser-mcp` on npm from 1.7.0 — [ADR-014](docs/adr/014-npm-distribution.md)).

## [Unreleased]

### Added — CedarAuthorizer, policy export, bundled engine (TD-BROWSER-15 phase 3b)

- **`CedarAuthorizer`** decides through the real Cedar engine, gated by the phase-2 differential
  oracle: it passes every generated configuration the oracle throws at it, `allowed` and
  `ruleMatched` both. Loads are strict (zero validation errors, `@rule` annotations
  cross-checked, reserved id namespaces refused), every decision runs against pre-parsed
  artifacts with request validation, and any trap — a rejected request, a refused source, an
  evaluation error — denies with `engine.error` and stays failed closed until restart. Strict
  validation statically rejects policies that would error, so a bad document never runs at all.
- **`agentbrowser-server policy export`** writes the policy document for today's environment
  configuration (loopback, CIDRs, approval policy), parsed exactly as the service parses it —
  operators migrate by generating, not hand-writing. Invalid configuration fails with the
  startup messages.
- **Hardened after review** (every claim held: the oracle at fresh seeds and 1000 runs, the
  packaging gates, a real pruned deploy): `policy export` refuses approval values the server
  refuses at startup instead of emitting a document for an unbootable configuration; every
  deciding forbid id is reported (a filter could erase one from hand-written documents); and
  `rulesMatched` lists each deciding id once.
- **The engine ships bounded:** `@cedar-policy/cedar-wasm` 4.13 becomes a runtime dependency,
  pruned to its Node build (~4.35 MB) in the server tarball, the Docker image and the Windows
  bundle; the pruner enforces a version + SHA-256 pin (`scripts/cedar-wasm.json`), the
  shipped-path gate accepts exactly that one pinned wasm and nothing else, the install-size
  gates gain the measured delta, and the Windows bundle smoke loads a document and decides one
  request through the bundled node.

### Added — Cedar schema, policy document, generator (TD-BROWSER-15 phase 3a)

- **The Cedar contract lives in the protocol** (`CEDAR_SCHEMA`, `agentbrowser-cedar/v1`): the
  `Authorizer` actions as Cedar actions, one optional normalized `ip` on `request.private`, and
  the act matchers (`effect`, `matchedRule`, `hostname`, `action`, `role`, `name`).
- **A policy document type** (`agentbrowser-policy/v1`): the policy set plus the configuration it
  was derived from, with structural parsing that rejects duplicate keys. This is what
  `policy export` will write and phase 4 will load.
- **A generator** turns today's environment configuration into a Cedar policy set that decides
  exactly as `LegacyAuthorizer` does, deterministically in text:
  - mapped-space operator CIDRs expand to their IPv4 equivalents, and a prefix up to 96 grants
    either all of IPv4 or nothing — Node `BlockList`'s cross-family behaviour, which a property
    test referees directly against `BlockList` (3000 single-rule runs, 1500 unions, the verified
    matrix);
  - every deny branch is an explicit `forbid` carrying its `env.*` id as a `@rule` annotation,
    so a denial still reports which rule decided it; a `required` outcome is a permit/forbid pair;
  - the generated set validates against the schema in strict mode with zero errors, and a fixed
    decision matrix matches `LegacyAuthorizer` under the real wasm build.
- `cedar-wasm` 4.13 is a dev-only dependency of `policy-engine`; it never enters the prod
  deploy trees the tarball, image and Windows bundle are built from.
- **Hardened after review** (every equivalence claim held under 100k+ referee checks): the
  generator validates its rules with the validator `ActionRiskPolicy` uses — now one shared
  exported validator in core — so an id the system would reject at startup can never reach the
  Cedar text, and `unknownRisk` is validated the same way; and
  `normalizeSourceForCedar` refuses family-mismatched (address, type) pairs, which `BlockList`
  answers false for.
- `PolicyDecision` gains `rulesMatched` (every deciding id; `ruleMatched` stays the first).

### Added — differential oracle (TD-BROWSER-15 phase 2)

- **A property-based harness checks any `Authorizer` against today's decisions.** It covers egress
  (contexts from the real `NetworkPolicy` path), approvals (from `ActionRiskPolicy.classify()`) and
  every capability, over generated configurations: loopback, CIDRs, `unknownRisk` and approval
  rules.
  - It holds for `LegacyAuthorizer` and runs a deterministic table of every approval combination.
  - It probes the first, last and one-past addresses of every CIDR, and contexts with several
    private sources.
  - 27 plausible-but-wrong subjects from review must each be caught on every seed, and a correct
    subject that resolves rules by id must pass.
  - Phase 3 runs it against Cedar.
  - It is test-only, with `fast-check` as a dev dependency, and it is not in the build.

### Changed — policy engine seam (TD-BROWSER-15 phase 1)

- **The floor refusals live in one module** (`packages/api/src/floor.ts`). That covers CDP-attach
  admission, attach options, delegated sessions, operator-only routes and the metadata wrap. Codes,
  messages and `floor.*` rule ids are unchanged.
- **Capability grants go through the `Authorizer`.**
  - When a session will get operator CDP attachment, downloads, service workers, cookie seeding or
    a headed browser, the service asks its authorizer. An always-headed engine (Safari) counts as
    headed unless headless is demanded. Cookie export asks for `cookie.export`.
  - Existing refusals keep their precedence: shutdown, an unknown engine and an unknown session
    still come first.
  - The default `LegacyAuthorizer` grants all of them (`env.capability.default`), so behaviour is
    unchanged.
  - A denial would be `POLICY_DENIED` with `details.rule` and `details.policyDecision`.
  - The service accepts an injectable `authorizer` (`ServiceDependencies.authorizer`), which is
    where phase 4 plugs in Cedar.
- **The loopback and private-network exceptions go through the `Authorizer` too.**
  - `NetworkPolicy` asks an `EgressExceptions` hook at its four existing decision points (hostname
    and resolved address, loopback and private). The default hook is today's rules.
  - The server answers it through `LegacyAuthorizer`'s `request.loopback` and `request.private`,
    built from `AGENTBROWSER_ALLOW_LOOPBACK` and `AGENTBROWSER_ALLOWED_CIDRS`.
  - Behaviour is unchanged: a differential test compares both hooks across mapped, NAT64, 6to4,
    SIIT and link-local addresses, hostnames and CIDR sets.
  - Snapshots keep their own copy of the default rules, so they stay immutable.
  - The hook fails closed: anything but `true` (a Promise, a string) counts as "not allowed".
  - Once a hook owns the exceptions, `updateConfig` refuses changes to `blockLoopback`,
    `blockPrivateIPs` and `allowedPrivateCIDRs`, so the reported flags and the enforced decisions
    cannot drift apart. No production code calls `updateConfig`.
- **Approval decisions go through an `Authorizer`.** A new internal package,
  `@agentbrowser/policy-engine`, carries the `Authorizer` interface and `LegacyAuthorizer`, today's
  rules unchanged. Each decision answers ADR-024 §5's two questions, `act` and `act.unattended`,
  and names its rule (`env.approval.<rule id>`, `env.approval.unknown-risk`,
  `env.approval.high-risk`, `env.approval.default`). Behaviour is unchanged, as the oracle tests
  show.
- **Approval rules accept an optional `id`** (`AGENTBROWSER_APPROVAL_POLICY` and
  `ServerOptions.approvalPolicy`): lowercase letters, digits, `.`, `_` and `-`, up to 64
  characters, unique, and not `none` or `rule-<n>`. A rule without one is identified as
  `rule-<index>`. **Tightening:** an `id` key was previously ignored; an invalid one now stops
  startup, with an error naming the rule and the reason.

### Changed — egress safety floor (TD-BROWSER-15 phase 0)

- **More cloud metadata endpoints are refused.** In addition to `169.254.169.254` and the GCP
  metadata names, these are now blocked:
  - the whole IPv4 link-local range `169.254.0.0/16`, which includes ECS task metadata and EKS Pod
    Identity;
  - `100.100.100.200` (Alibaba Cloud) and `168.63.129.16` (Azure wire server);
  - `fd00:ec2::/64` (AWS over IPv6) and `fe80::/10` (IPv6 link-local);
  - `fd20:ce::254` (GCP, IPv6-only instances) and `fd00:c1::a9fe:a9fe` (OCI over IPv6).

  Like all metadata, they are refused even under an `AGENTBROWSER_ALLOWED_CIDRS` exception.
  **Tightening:** link-local devices previously reached through a CIDR exception are now refused.
- **IPv4 embedded in IPv6 is decoded.** These forms now carry the classes of the IPv4 they embed;
  before, they classified as public:
  - NAT64 `64:ff9b::/96`;
  - the local-use `64:ff9b:1::/48`, under every RFC 6052 layout. It is also private as a whole,
    since it is never globally routable. Decoding every layout reads almost any address in this
    prefix as loopback (`0.0.0.0`), so local-use NAT64 is **effectively refused**, which fails
    closed. Use the well-known `64:ff9b::/96` prefix with agentbrowser;
  - 6to4 `2002::/16`;
  - SIIT `::ffff:0:0:0/96`;
  - IPv4-compatible `::/96`.

  So `64:ff9b::7f00:1` is loopback and `64:ff9b::a9fe:a9fe` is metadata. Decoding only adds
  classes, and `::1` stays loopback. Teredo and ISATAP are not decoded.
- **`AGENTBROWSER_ALLOWED_CIDRS` matches the IPv4 inside these forms.** An IPv4 exception such as
  `192.168.1.0/24` also admits that address behind NAT64, 6to4 or SIIT, as it already did for
  IPv4-mapped. An IPv6 wrapper exception such as `64:ff9b::/96` never grants the private IPv4
  inside it.
- **The metadata floor holds over any injected policy.** Every session's request policy is now
  wrapped in `MetadataFloorPolicy`, so cloud metadata endpoints stay refused (`rule:
  "floor.metadata"`) even when an embedder passes `ServerOptions.networkPolicy` with metadata
  blocking off (`new NetworkPolicy({})`). The refusal covers request hosts, DNS answers, redirect
  hops and navigation preflight. Optional gates pass through only where the underlying policy has
  them, so a weaker policy is never made to look strict to the download path.
- **Metadata names are normalised.** Case and trailing dots are ignored
  (`metadata.google.internal.`). This matters on the CDP-attach lane, which has no DNS answer to
  check.
- **Tightening: `metadata`, `instance-data` and `instance-data.ec2.internal` are now refused.**
  These are the GCP and AWS search-domain names. An intranet host literally named one of them is
  refused even under an `AGENTBROWSER_ALLOWED_CIDRS` exception.
- **Floor refusals name their rule.** Each refusal that no policy can grant now carries
  `details.rule`:
  - CDP attachment: `floor.cdp.hosted`, `floor.cdp.multi_tenant`, `floor.cdp.local_only`,
    `floor.cdp.egress`, `floor.cdp.disabled`, `floor.cdp.auth_required`, `floor.cdp.options`,
    `floor.cdp.profile_options` and `floor.cdp.cookie_export`;
  - `floor.delegated.operator` on controlled-session creation without operator credentials, and on
    the operator-only control, approval and review checks. A caller without credentials on a
    keyless local service sees this rule. Delegated agent credentials are always refused earlier on
    these routes by their mode profile's capability gate, which is an operator choice and so carries
    no floor rule.

  Existing `details.reason` codes are unchanged.

### Fixed

- **`AGENTBROWSER_LOG_LEVEL` accepts `warn` and `error`**, the structured logger's other two
  levels, as well as `debug` and `info`. Matching is case-insensitive. Before, any value other
  than `debug` silently meant `info`; an unknown value now prints a warning and uses `info`.
- **The TypeScript SDK's managed subprocess sets the variable the service reads.** It used to set
  `AGENTBROWSER_LOG=error`, which nothing read. It now sets `AGENTBROWSER_LOG_LEVEL` explicitly:
  the caller's own non-blank value when set, otherwise `error`. Custom `SubprocessLauncher`s receive
  it too. At `error`, failed operations (including policy denials) are no longer logged; the
  `errors_total` metric still counts them.

### Docs — design records

- **ADR-024 (Proposed): server policy engine.** An opt-in, versioned policy document evaluated by
  embedded Cedar replaces policy that is spread across environment variables today. Policy becomes
  per authenticated tenant, and agents can query it (`GET /v1/policy`, `POST /v1/policy/check`, an
  MCP `policy` tool). A fixed safety floor stays outside policy: metadata endpoints (a wider set),
  loopback and private addresses blocked by default, and the CDP-attach refusals. Engine errors
  fail closed. Implementation plan: TD-BROWSER-15. Also adds ADR-022, which was missing, to the
  docs index.
- **ADR-025 (Proposed): operator login browser and cookie handoff.** AgentBrowser launches an
  operator-only, headed login browser on a persistent profile over a private pipe, with no
  debugging port that a local process could read. The operator signs in there once, then approves
  one-time copies of selected domains' cookies into contained sessions, using a separate operator
  credential the agent never holds. In those sessions, high-risk and unknown-effect actions need the
  operator's review, or an operator-granted lease. Implementation plan: TD-BROWSER-16.

## [1.17.1] — 2026-10-13

### Changed — dependencies (#426)

- **Playwright 1.62.1 → 1.64.0.** Engines pick up a newer Chromium build, which is downloaded
  again on first use: the Homebrew bootstrap, the Windows launcher and `playwright install`. The
  Docker base image moves with it, to `mcr.microsoft.com/playwright:v1.64.0-noble`.
- **CLI: `commander` 12 → 15.** The CLI now **rejects surplus positional arguments** that it used to
  ignore silently, e.g. `agentbrowser observe <s> <p> extra` fails with "too many arguments".
  Building the workspace from source now needs Node 22.12 or newer (root `engines`). Compiled CLI
  binaries are unaffected, and the server tarball still runs on Node 22 or newer.
- `@fastify/cors` 10 → 11 (major; the API sets `methods` explicitly, so its CORS behaviour is
  unchanged), `@fastify/websocket` 11.3.4, `ws` 8.22.0, `axe-core` 4.14.0, `jsdom` 30.1.2. Biome 2
  replaces Biome 1.9 for lint (#424), with every 1.9 rule still enforced.
- Dependabot holds back updates that need deliberate migration. It ignores puppeteer (the Firefox
  egress qualification is pinned to an exact driver) and the Playwright Docker image (it moves only
  with npm `playwright`) entirely, and ignores **major** versions of `@types/node`, `typescript`,
  `pixelmatch` (its colour metric changes baseline semantics) and the Docker `node` image.

### Docs — design records

- ADR-022 and TD-BROWSER-14 (#430) propose compact session and page identifiers and explicit,
  generated CLI contexts for 1.18.0. These are design records only; nothing changes in this release.

### Docs — Windows install, ADR-023, environment-variable reference

- **Windows install docs.** README, the docs home page and the operations guide gain a Windows
  section: winget or the zip, first-start Chromium, `--install-browser`, `AGENTBROWSER_HOME`,
  `AGENTBROWSER_SKIP_BROWSER_INSTALL`, no Windows-service registration, and unsigned executables.
  The operations guide also gains Windows troubleshooting: proxies, partial upgrades,
  `winget upgrade` with files in use, long paths, antivirus, and owner-only credential files
  under Constrained Language Mode.
- **ADR-023** records why the Windows server ships as a bundled-Node zip, not a single-file
  executable.
- **Environment-variable reference.** The configuration table now covers every operator-facing
  `AGENTBROWSER_*` variable, including several that appeared only in code and others documented
  only in package READMEs or prose. Test-harness and internal variables are listed as such.
  `AGENTBROWSER_LOG`, which the SDK sets, is noted as unread by the service.
- **Correction:** the stale "Windows server exe is Bun-compiled" paragraph is replaced.

### Changed — extracted-package acceptance runs on Windows

- **Graceful stop works on Windows.** `scripts/package-acceptance.mjs` stops managed children
  with SIGTERM on POSIX, as service managers do. On Windows, SIGTERM is `TerminateProcess`, so
  the harness instead uses the server's stdin lifeline (`AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF`) or
  closes the injected child's IPC channel.
- **A child counts as finished** once it has exited and both its output streams have closed,
  which still captures late output. Node never emits `close` after the parent disconnects IPC,
  so waiting for `close` would hang on Windows.
- **Running the server.** The server under test is the POSIX launcher in the tree, or on Windows
  the server entry on Node. A new `--server-command` option runs a given executable instead,
  such as the Windows bundle's launcher. With `AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF=1`, the
  launcher now also stops gracefully on EOF on its own stdin.
- **Windows environment fixes.** The harness prepends to the platform's real `Path` key, using
  `;` as the separator. It used to write a second `PATH` key that hid System32, so `openssl` and
  `qpdf` were never found. A command that can't be spawned now fails at once with its spawn
  error, instead of waiting out the shutdown deadline.

### Security — owner-only credential files on Windows

- **The problem:** the CLI's cookie export (`cookies export --output`) and private observation
  capture (`observe --output`) created files with mode `0600`. Windows ignores POSIX modes, so the
  files inherited their folder's ACL. In a shared folder such as `C:\Users\Public`, that grants
  Modify to every interactive user, so exported session cookies were readable by other local
  users.
- **The fix:** on Windows the file is now created **atomically with its security descriptor**.
  - A fixed Windows PowerShell script calls .NET `FileStream(CreateNew, FileShare.None,
    FileSecurity)`. The DACL is protected and holds exactly one ACE: the current user,
    FullControl. At no moment does the file exist with any other ACL.
  - The secret goes over stdin, never in argv or the environment.
  - An existing name, a link included, is refused.
  - POSIX keeps `O_EXCL | O_NOFOLLOW`, mode `0600`, and a failed `close` now counts as a failed
    write.
- **Why atomic creation:** an earlier approach set the ACL after creating the file. Review showed
  that leaves a race: another user can swap the file for a decoy, or keep an early read handle.
  Re-running that attack against the new code, the rename fails (the file is held with
  `FileShare.None`), and every file carries the owner-only DACL from birth.
- **Acceptance:** the extracted-package acceptance requires the SDDL DACL to be exactly
  `D:P(A;;FA;;;<current user SID>)`.

### Fixed — Windows service: shipped as the bundled-Node zip

- **The single-file `agentbrowser-server-windows-x64.exe` is retired.** v1.17.0's copy failed on
  every machine but CI with `Cannot find module 'D:\a\agentbrowser\…'`, because Bun froze
  playwright-core's `__dirname` lookups to the build checkout, and Playwright cannot be
  single-file bundled.
- **The release's new `windows-bundle` job** builds `agentbrowser-windows-x64.zip` on a hosted
  Windows runner and clean-room smoke-tests it before anything publishes. It contains:
  - the launcher;
  - the same CLI and MCP executables as the standalone assets;
  - Node 24.21.0;
  - the lockfile-pinned server tree.

  npm publishing and the GitHub release both wait for that job.
- **winget** installs the zip as one package. Its nested `agentbrowser-server.exe`,
  `agentbrowser-cli.exe` and `agentbrowser-mcp.exe` keep their command aliases. The package
  description now says what is installed: a bundled Node.js runtime, with Chromium downloaded on
  first start. It no longer claims "no Node.js runtime is required".
- `scripts/release-workflow.test.mjs` guards that structure, so the single-file server exe
  can't come back.

### Added — Windows bundle assembly and clean-room smoke

- `scripts/assemble-windows-bundle.mjs` builds `agentbrowser-windows-x64.zip`, a flat zip
  containing:
  - the launcher `agentbrowser-server.exe`, `agentbrowser-cli.exe` and `agentbrowser-mcp.exe`;
  - `node\` (official Node 24.21.0);
  - the `server\` tree.

  It refuses a server tree of another version, any link, any shipped file embedding a
  build-machine path, and any path over the MAX_PATH budget.
- `scripts/windows-node.json` pins the bundled Node to nodejs.org's SHA-256 values for both the
  archive and `node.exe`, matching `.tool-versions`. `scripts/fetch-windows-node.mjs` downloads
  only from `https://nodejs.org`, verifies both hashes, and installs only `node.exe` and
  `LICENSE`.
- `scripts/check-shipped-paths.mjs` fails on runner paths and the checkout path in shipped files.
  It matches raw and JS-escaped (`D:\\a\\`) forms, in UTF-8 and UTF-16LE. v1.17.0's server exe
  held the escaped form, and the scan fails on it.
- `scripts/windows-bundle-smoke.mjs` extracts the bundle into a clean room outside any checkout
  and drives the shipped executables:
  - `--help`/`--version`;
  - the first-start Chromium bootstrap;
  - a real session through the CLI;
  - the MCP end-to-end test through the MCP executable;
  - killing the launcher outright, which must leave no server or Chromium process;
  - a no-op reinstall;
  - invocation through a symlink, as winget's Links directory does.

  Windows CI assembles and smokes the bundle on every PR. The previously non-blocking MCP
  end-to-end step now runs, blocking, inside the smoke.

### Added — Windows server launcher

- New `packages/api/src/launcher/`, compiled by `packages/api/scripts/compile-launcher.mjs` into the
  `agentbrowser-server.exe` of the Windows bundle. The bundle places it next to a bundled
  `node\` runtime and the `server\` tree. The launcher imports only `node:` builtins and never
  derives a location from `__dirname` or `import.meta`; a test enforces both. v1.17.0's single-file
  server exe failed on every machine but CI because Bun froze Playwright's `__dirname` lookups to the
  build checkout.
- **Install root:** `AGENTBROWSER_HOME` when set, and then only it (an incomplete one fails
  loudly); else the real executable's directory, following winget's Links symlink; else the
  invoked path. An incomplete bundle is refused, and so is a server tree whose `VERSION.json`
  doesn't match the launcher.
- **Chromium:** downloaded on first start into `%LOCALAPPDATA%\agentbrowser\browsers`, unless
  `PLAYWRIGHT_BROWSERS_PATH` is set. Missing builds are detected the way Playwright detects them
  (`browsers.json` revision plus the `INSTALLATION_COMPLETE` marker). `--install-browser`
  pre-provisions; `AGENTBROWSER_SKIP_BROWSER_INSTALL=1` opts out; a failed download fails closed with
  next steps.
- **Supervision:** the launcher runs the server with the stdin lifeline. If the launcher is killed
  outright, the server and its Chromium still shut down (verified on Windows 11 with a live session).
  The first stop signal closes the lifeline; a second kills the server.

### Fixed — server artifacts ship only built output

- The server's workspace packages (`api`, `core`, `engine`, `engine-playwright`, `engine-safari`,
  `extraction`, `policy`, `protocol`) now declare `"files": ["dist"]`, as `control` already did.
  `pnpm deploy` had been copying whole package directories into the server tarballs: `src/`,
  `tsconfig*`, `vitest.config.ts`, and on a machine that had run tests, `coverage/` reports
  embedding the build checkout's absolute paths. The Docker image already deleted `src/` and
  coverage itself, but still carried the TypeScript and Vitest configs.
- The Dockerfile no longer deletes every directory named `src` under the deploy. That pruning is
  redundant now, and it also stripped third-party runtime code: `real-require`, which pino uses to
  load log transports, has its entry point at `src/index.js`.
- A new test walks the API's workspace dependency closure (dependencies, optional and peer) and
  requires an exact `files` allowlist.

### Added — Windows server tree (packaging)

- `scripts/package-server.mjs` gains a `win32-x64` target. Windows `tar` cannot extract the POSIX
  tarballs' pnpm symlinks without Developer Mode, so the Windows tree must contain no links. It starts
  from the **same lockfile-faithful isolated deploy** as every other target. The new
  `scripts/materialize-hoisted.mjs` then rewrites that deploy into a link-free hoisted layout.
  - It reads the dependency graph with Node's own lookup.
  - It places each package at the highest ancestor that doesn't shadow an existing resolution.
  - It re-verifies every dependency edge against the written files.
  - So Windows ships exactly the versions in `pnpm-lock.yaml`. pnpm 9's own hoisted `deploy` was
    rejected: it ignores the lockfile and re-resolves from the registry.
- The target removes `node_modules/.bin` and type/source-map files. It fails if any link remains, if
  a package can't run on win32-x64, or if a path exceeds the MAX_PATH budget under winget's install
  root (files and directories are gated separately). It produces `agentbrowser-server-win32-x64.zip`.
- On Windows hosts the packager runs pnpm through `npm_execpath`, or else through `cmd.exe` with
  checked arguments. It stages on the checkout's drive, because pnpm deploy fails across drive
  letters. Build-tool failures now include the tool's output.
- `scripts/check-win32-server-tree.mjs` extracts that zip outside the checkout and checks it:
  - no links;
  - the extracted-package dependency audit;
  - the server reaches `/health`;
  - with `--session`, a real Chromium session.

  It runs in Windows CI.

### Fixed — server command line

- `agentbrowser-server --help` and `--version` now answer without starting the service or
  loading the browser engine (previously every argument was ignored and the server started). The
  entrypoint parses arguments first and loads the server lazily, so help works even when
  Playwright cannot load. Unknown arguments exit 2; configuration stays environment-only.
- The server also shuts down cleanly on `SIGHUP` and, on Windows, `SIGBREAK`. A second signal
  force-exits a hung shutdown. A new opt-in `AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF=1` stops it when stdin closes,
  which gives the Windows launcher a lifeline: if the launcher dies, the server still exits and
  closes Chromium.

### Fixed — winget package

- The winget manifests were not valid: three portable `x64` installers in one package are rejected
  as duplicate installer entries, and the version manifest lacked `DefaultLocale`. Releases now
  also publish `agentbrowser-windows-x64.zip` with the three Windows commands, and the manifest
  declares it as one zip installer with nested portable files, so
  `winget install AnvaiLabs.AgentBrowser` provides `agentbrowser-mcp`, `agentbrowser-cli` and
  `agentbrowser-server`. Regression tests in `scripts/winget-manifests.test.mjs` run with
  `pnpm test:release`.

## [1.17.0] — 2026-10-12

> **Known issue (Windows, v1.15.2 through v1.17.0):** `agentbrowser-server-windows-x64.exe` fails
> at startup on every machine except the build runner, with
> `Cannot find module 'D:\a\agentbrowser\…'`. Bun froze playwright-core's `__dirname` lookups
> to the CI checkout. An `agentbrowser-windows-x64.zip` attached to v1.17.0 after release wrapped
> the same executable and has since been removed from that release; each affected release now
> carries a known-issue banner. A winget submission for 1.17.0
> (microsoft/winget-pkgs#451310) was closed unmerged for this reason. Fixed in 1.17.1,
> which ships the Windows service as a bundled-Node `agentbrowser-windows-x64.zip`
> ([ADR-023](docs/adr/023-windows-server-bundled-node.md)). The Windows CLI and MCP executables
> are unaffected.

### Security — browser request guard, CORS off by default, dependency advisories

- **Drive-by control of the local service closed.** The no-keys local service sent
  `Access-Control-Allow-Origin: *` and checked neither `Host` nor `Origin`, so any web page
  the operator visited could create sessions and drive them — including `upload`, which reads
  local paths — directly or through DNS rebinding. A root `onRequest` guard
  (`packages/api/src/request-origin-guard.ts`) now answers `403 FORBIDDEN` to a `Host` that is
  not a trusted name (loopback or `AGENTBROWSER_ALLOWED_HOSTS`) on loopback binds and on **every
  bind without API keys**, to foreign or `null` browser origins, and to browser fetch metadata
  other than a typed navigation unless the origin is allowed or same-origin on a trusted name.
  CLI/SDK/MCP clients and the same-origin operator panel are unaffected when they use a trusted
  name. Residuals are documented in docs/threat-model.md.
- **Breaking for no-keys wide binds** (`HOST=0.0.0.0`, the Docker image's default): clients that
  reach the service by a container, service or LAN name now get 403 — list those names in
  `AGENTBROWSER_ALLOWED_HOSTS` or set `AGENTBROWSER_API_KEYS` (logged at startup). `localhost` /
  `127.0.0.1` (port publishing, the healthcheck) keep working; keyed deployments are unchanged.
- **CORS is disabled unless configured.** New startup-only `AGENTBROWSER_CORS_ORIGINS` (exact
  origins, merged with `ServerOptions.corsOrigin`) and `AGENTBROWSER_ALLOWED_HOSTS`. **Breaking
  for browser apps on other origins** that called the API: list their origins in
  `AGENTBROWSER_CORS_ORIGINS`. See docs/operations.md#browser-request-guard.
- **Dependencies:** fastify 5.12.1 → 5.12.5 plus lockfile refresh of `fast-uri` and
  `source-map-js`; `pnpm audit --prod` goes from 13 advisories (9 high) to none.
- **Dependabot version updates** (`.github/dependabot.yml`): npm, GitHub Actions, Docker and
  the docs pip toolchain, targeting `develop`.

### Docs — Anvai family brand

- The docs site adopts the shared Anvai family brand (v1.3), the same as the AnvaiOps, genmedia,
  InferFlux, ProximaDB, Sandhi and Victor docs. It includes the ink brand bar, teal accent and
  self-hosted Inter, which removes the Google Fonts request. `scripts/check_brand_tokens.py`
  pins the shared files and runs before the docs build (#400).

## [1.16.1] — 2026-10-10

### Added — formControls row/section context (G1)

- Custom controls with generic, duplicated accessible names (GitHub's permission editor
  renders 40+ "Access: No access" Primer menus) now carry `PageElement.context`: the nearest
  enclosing row label plus the section heading (`Contents — Repository permissions`), minted
  by the formControls enrichment and rendered by the CLI as `(context)`. Field evidence and
  the full gap packet (forms-extract parity, lazy-section probes, autofill context matching,
  scroll ergonomics, private-file downloads):
  docs/agent-handoffs/AGENTBROWSER_UI_GAPS_2026-10-10.md.

### Added — Windows CI + winget channel, App-based submission

- **Windows CI gates** (`windows-ci.yml`): windows-latest build + W1–W6 gotcha gates
  (stdio handshake, .cmd shim relay, spaced/UNC paths, PowerShell interop, browser
  discovery — each encoding a real win32 failure) + a full-stack headless MCP e2e
  through the real binary. The G2 shim gate caught its first real bug on first run:
  a never-executed-on-Windows argv-slice mismatch.
- **winget release channel**: manifests for all three portable commands
  (`agentbrowser-mcp`, `agentbrowser-cli`, `agentbrowser-server`) generated from the
  windows release exes; `winget install AnvaiLabs.AgentBrowser` provisions all three
  with no Node runtime. Manifests always upload as a workflow artifact.
  *Correction (2026-10-12):* these manifests were invalid (three portable installers for one
  architecture, and no `DefaultLocale`), so no winget package was published from 1.16.1. The
  1.16.1 server executable they would have installed also did not start outside CI. See the
  1.17.0 known issue above and the 1.17.1 Windows entries.
- **App-based submission (no user credential)**: a GitHub App installed on
  `anvai-labs/winget-pkgs` pushes the manifests branch per release (per-run
  installation tokens via `WINGET_APP_ID`/`WINGET_APP_PRIVATE_KEY`); the PR into
  `microsoft/winget-pkgs` is attempted and — because GitHub Apps cannot create PRs in
  repos they are not installed on — degrades to a one-click compare link in the run
  summary. `WINGET_FORK_TOKEN` (user PAT) remains the zero-click override.
- Also in this train: waitFor 6s budget fix for four real-Chromium panel waits under
  pre-commit parallel load, and honest `t.skip` (no bare passes) in G4/G5 when
  preconditions are unavailable.


## [1.16.0] — 2026-10-10

### Changed — MCP surface refresh (owner-approved breaking rename)

- **MCP tool names dropped the `browser_` prefix** (`browser_observe` → `observe`, `browser_act` →
  `act`, …; 17 tools + the delegated `operation`). Owner decision: consumers are few and adapt now
  rather than after wider adoption. Registered MCP clients must update tool names once.
- **Tool descriptions slimmed ~24%** (11.6K → 8.8K chars; `act` −54%) in telegraphic style with the
  repo's anchor-pinning tests as the deterioration boundary (they rejected two over-compressions:
  the egress-1014 "not a bot wall" cue and the reloading-recovery verb). Operator configuration
  essays moved out of agent-facing descriptions; `observe`'s description now teaches the compact
  projection.
- **Structured results everywhere it matters:** `act`/`navigate`/`extract` advertise outcome
  output schemas (`urn:agentbrowser:act-outcome:v1`, `urn:agentbrowser:extract-outcome:v1`, inline
  NavigationStatus) so their results arrive as `structuredContent` — previously `act` results were
  pretty-printed text only. The text fallback is now minified (−29% on that copy of every result).
- **Machine-readable structured errors:** tool failures keep the actionable remediation text and
  add `structuredContent {error: {code, message, operationId?}}` — with allowlisted details only
  (a raw `details` passthrough would have leaked `privateReason` from terminal close facts).
- **CLI `observe --output FILE`:** full observation to a new exclusive 0600 file (cookie-export
  discipline), stdout carries an identity receipt with the projection echo — the artifact escape
  hatch for evidence capture.
- **Agent skill shipped:** `docs/skills/agentbrowser-cli/SKILL.md` — the compact loop, ref
  discipline, and invariants as a copy-in skill for any harness.
- **Defaults raised 25% (owner direction):** default session TTL 3.5 h → **4.375 h**
  (15,750,000 ms; per-request `ttlMs` and the operator `AGENTBROWSER_DEFAULT_TTL_MS` override
  unchanged in precedence), and the per-page diffable revision history 8 → **10**
  (`sinceRevision` window). The application-authority TTL cap (3.5 h on control-plane
  application sessions, a separate subsystem) is unchanged.

### Added — compact observation output (CLI-first agent token reduction)

Design review and prior art: `docs/agent-handoffs/AGENTBROWSER_COMPACT_OUTPUT_REVIEW_2026-10-09.md`.
Measured on the OVH-Manager-shaped benchmark fixture (373 elements) against real Chromium:
full observe 27,462 B vs role+name projection 986 B and dialog scope 1,305 B — **96% reduction**
with the dialog's checkboxes found even where the default 300-element window truncated them away.

- **`observe` compact projection (opt-in)**: `roles` (exact), `name` (case-insensitive
  substring on names only, never values), `scopeRef` (subtree slice within the scope
  element's snapshot block), `limit`, and `includeFields` (`href`/`attributes`/`required`;
  the protected core — `ref`, `role`, `name`, `value`, `valueRedacted`, `checked`, `risk`,
  `focused`, non-default `visible`/`enabled`, `depth`/`block` — is never droppable).
  Responses carry a `projection` echo (`matched`/`total`) so a subset can never read as
  the whole page. Projection runs after secret redaction and before the byte budget;
  refs keep being minted over the full page, so filtered-out elements stay actionable.
- **Scope refs obey ADR-004**: an older-revision scope fails `STALE_TARGET`, a removed
  element fails `TARGET_NOT_FOUND` — never a silent empty result. Names cap at 200 chars
  (`nameTruncated`, mirroring `hrefTruncated`). Under `sinceRevision`, `changes` are
  filtered by the same predicate.
- **Element `depth`/`block` metadata** (engine a11y parse, stamped only when non-zero):
  block-local nesting and merged-frame block identity — the basis for scope slicing;
  flat top-level output is byte-identical.
- **Element-list cursors address page ordinals** under projection (`remaining` counts
  matches only); `budgetObservation` gained an `ordinals` mode whose identity case
  reproduces the previous index arithmetic exactly.
- **CLI**: `--roles/--name/--scope-ref/--limit/--include-fields` on `observe`;
  `--json` is minified by default with a new `--pretty` flag; the default text render
  now prints the continuation cursor (`--continue-from N (K elements remain)`),
  `[redacted]` markers and the focused element, plus the projection echo. An older
  server's rejection of projection options maps to an actionable error.
- MCP `browser_observe` and the REST API pick the projection fields up from the shared
  protocol schema (no adapter changes); OpenAPI and the MCP catalog digest regenerated.
- Benchmarks: `/ovh` fixture and `runCompactProjectionBenchmark` A/B (success parity is
  part of the `benchmarks run real` gate). The act result's existing lean keep-list is
  pinned by a regression test (`act-response-shape.test.ts`).

## [1.15.2] — 2026-10-06

### Security — TD-BROWSER-13: observation secret redaction (release blocker)

- **Password values no longer leak through observations.** Playwright's aria snapshot
  carries password inputs as plaintext `textbox` values; a trusted sensitivity boundary at
  the DOM-binding point now withholds them from observations, the ref store, semantic
  fingerprints, diff caches and every downstream envelope. Policy: native password/hidden
  inputs, `autocomplete` `current-password`/`new-password`/`one-time-code`/`cc-number`/
  `cc-csc`/`cc-exp`, and explicit `sensitive` fills (the classification persists for the
  element's lifetime across show-password toggles and revisions). Elements whose type
  cannot be established fail closed — values are dropped, never carried as fallback.
  Ordinary form values are preserved for bulk-autofill verification.
- New `PageElement.valueRedacted` (and `NativeFormControlEvidence.valueRedacted`) marks
  withheld values: absent `value` + `valueRedacted:true` means "withheld", not "empty".
  Native form evidence keeps hidden-input values (documented exception: the application
  witness's hidden-drift tamper check needs page-generated tokens; hidden inputs are not a
  user-typeable channel). The Safari and Firefox engines enforce the same policy at their
  describe boundaries (Safari via its observe/fill scripts, Firefox extending its existing
  password gate to hidden, credential autocomplete, and explicitly marked fields), so the
  withholding is engine-neutral, not Playwright-only.
- Autofill receipts for sensitive controls report `unverified` + `verificationWithheld`
  instead of a false value mismatch.
- Approval-gate action fingerprints use a per-instance keyed HMAC (they cover full action
  JSON including fill values; unkeyed digests of low-entropy secrets were brute-forceable).
- **CLI/SDK/API fix**: `sessions.events` object selectors always resolve to the
  `{events, nextCursor}` envelope — `--limit` without `--since` used to return a bare array
  and crash the CLI's formatted output (`envelope.events.map`); an unfiltered selector now
  returns the merged console+request ledger instead of an always-empty envelope.
  *Behavior change*: a type-only object selector (e.g. `events(id, {type})`) previously
  returned a bare array at runtime despite the declared envelope type — callers that
  relied on the runtime array must read `.events` now; the undefined/string selector
  keeps its legacy array shape.
  Design + honest boundaries (screenshots, raw HTML, page-side exfiltration):
  `docs/td/TD-BROWSER-13-observation-secret-redaction.md`.

### Added — task T7 (audit/security), slices 2a/1/3

- **Engagement scope enforcement** (`policy.scope` on session create; MCP `browser_create`
  `scope`; CLI `session create --scope-file`): hosts/paths/methods/identity-bindings/
  expiry/request-budget enforced per request and per redirect hop by `EngagementScopePolicy`
  as the outermost restrict-only layer of the session's policy chain
  (`SCOPE_*` typed denials). Design: `docs/spec/design/t7-scope-enforcement.md`.
- **Audit adapters** (`@agentbrowser/audit`, outside the default dependency closures):
  visual (pixelmatch-wrapped, versioned baselines with explicit saves) and
  accessibility (axe-core in a Node DOM over captured HTML — page scripts never
  executed; layout-dependent rules recorded as incomplete, never passing). Design:
  `docs/spec/design/t7-audit-adapter.md`.
- **Scanner-regression adapter**: bounded OWASP ZAP API client with scope
  enforcement, poll budget, and acknowledged-baseline comparison over
  `(pluginId, url, parameter)` signatures; the real-ZAP recorded run executed
  against ZAP 2.17.0 (seeded reflected-XSS confirmed high). Design:
  `docs/spec/design/t7-scanner-regression.md`; evidence:
  `docs/spec/evidence/t7-scanner-regression.md`.
- **Shared finding-baseline store** (`FindingBaselineStore`): the
  versioned persistence half for the finding adapters — explicit
  versioned saves (never overwrite; temp+rename manifest), latest-on-
  load, retained history, strict filename-component labels, typed
  errors for corrupt/unsupported manifests.

### Added — C4b execution requirement

- **`executionRequirement: 'ephemeral' | 'durable'`** optional field on
  application execute (C4b: missing normalizes to `ephemeral`; `durable`
  requires a qualified durable journal store and refuses typed when the
  runtime cannot satisfy it — the refusal does not reserve an identity
  or consume approval). Discovery surfaces `writeExecution` with the
  supported requirements. Trusted deployment configuration
  (`durableJournalAvailable`) — never settable from session or request
  input. Design: `docs/spec/design/t5-journal-control-views.md` (C4b).

### Added — records and procedures

- N2: the OS-enforced egress pairing documented as the T7 prerequisite
  (`docs/spec/design/t7-os-egress-pairing.md`; enforcement NOT SHIPPED).
- T5: the operator quarantine/reconciliation procedure for journal stores
  (`docs/spec/design/t5-operator-reconciliation.md`); the read-only-filesystem
  and disk-full qualification lanes (deterministic max-page mechanism);
  the C4b precondition audit (all five delivery gates pass; the F3
  authorization is the remaining gate).

### Qualified — installed harness

- T1: cursor consumption/retirement choreography through the Codex provider
  path (all seven cursor fields delivered; takeover revocation, fresh-grant
  recovery, old-epoch refusal).
- T8: provider-path resilience (service down / restored / blackhole timeout —
  uncertainty discipline surfaced honestly); slice-2 acceptance dimensions
  (union, enum, nested-object/array inputs, typed evidence) and the full
  cursor choreography through the same path.

## [1.15.1] - 2026-10-03

### Fixed

- Large site JavaScript responses can now be admitted using the operator-owned
  `AGENTBROWSER_MAX_RESPONSE_BYTES` startup setting. The default remains 10 MiB;
  a validated override accepts 1 byte through 64 MiB (for example, 33554432 for
  32 MiB). Session requests cannot raise the cap. Malformed settings fail startup,
  and SSRF and host restrictions remain intact. This does not change download or
  extraction budgets and is not a peak-memory guarantee for buffered adapters.
- Server and CLI usage documentation explains response-size policy failures and
  configuring a separate service without disrupting active browser sessions.

This maintenance release backports only the response-cap fix from develop onto
v1.15.0; unreleased engagement-scope and other develop features are not included.

## [1.15.0] - 2026-10-01

### Added

- Child-frame observation and ref binding (T6): `observe` walks child
  frames (depth-capped, per-frame snapshot slices) and merges their
  content into one deterministic ref list; bindings are frame-scoped
  with per-frame ordinals, so embedded-application content is visible
  and actionable — duplicate labels across frames bind independently.
- Frame coverage surfacing: uninspectable frames (`timeout`,
  `unavailable`, `depth_exceeded`, `budget_exceeded`) surface a bounded
  `frameCoverage` block through the observation schema instead of
  silently partial content; iframe nodes are no longer bindable refs.
- Frame-scoped form identity: form-identity evidence for frame-owned
  controls evaluates against a per-frame identity state (the main-frame
  limitation is lifted); act-time re-verification routes through the
  owning frame.
- Per-frame snapshot slices: frame captures draw an even split of the
  remaining snapshot envelope, so one slow frame cannot starve the rest;
  a spent envelope reads as `budget_exceeded` coverage per frame.
- Session event replay outside REST (N1): `browser_events_replay` MCP
  tool, `session events --since/--limit` CLI paging, and the SDK paged
  overload over the bounded event ledgers; uncaught page exceptions are
  captured as redacted `page.error` events.
- Operator loopback opt-in (`AGENTBROWSER_ALLOW_LOOPBACK`): disables the
  loopback egress block for all sessions on the server (local-machine
  testing against 127.0.0.1 dev servers). Startup-only; metadata
  blocking and session host restrictions still apply; visited pages can
  reach loopback services including the server's own API — see the
  operations table and threat model.

### Changed

- All-hop egress enforcement: redirect chains are walked in the routing
  choke point with per-hop policy checks, a redirect cap, and loop
  detection — the later-redirect policy bypass (R4) is closed; a denied
  terminal is never fetched.
- Journal horizons are monotonic across wall-clock rollback: admission
  and retention use max(now, persisted high-water); a reopen below the
  persisted high-water refuses as configuration.
- T8: the installed 1.14.0 MCP tool-call path and cursor
  consumption/retirement lifecycle are qualified on the record machine;
  explicit footprint gates (peak RSS on the shipped binaries) run in CI.

### Fixed

- The storage manager's dispose drain is bounded; a navigated child
  frame can no longer leave form evidence dead; journal manager
  hostile-frame and late/duplicate-reply hardening; footprint and
  per-frame snapshot-slice gates enforce the recorded budgets.

### Docs

- The tooling comparison (AgentBrowser vs Chrome debug mode,
  chrome-devtools-mcp, assistant-vendor browser integrations), the
  frame-observation and N1 designs, the installed-harness
  qualification records, and the foundation-first plan refinements.

## [1.14.0] - 2026-09-30

### Added

- T5 journal foundation, storage-neutral and internal (no public durability
  yet): a bounded journal manager with a dedicated storage child process and
  an adapter factory over the SQLite owner/anchor primitive; runtime
  selection, concrete store enablement and recovery remain gated behind the
  remaining resource and packaging acceptances.
- J2b.3 qualification gates: the full process-loss matrix (before-intent,
  after-commit, after-anchor barriers and the caller-timeout rule), the
  adversarial and bounded-resource matrix, and a packaging gate proving the
  extracted candidate resolves the storage child in a clean install. The
  journal gates run as a blocking CI job (promoted from a canary after the
  wedge root-cause and gate repairs).
- The journal manager's dispose drain is bounded (#319): shutdown can no
  longer wait indefinitely on a wedged storage child.

### Docs

- T8 installed-harness records: named-version availability (CLI-path
  delegated flows, Codex listing fidelity, two Victor infrastructure
  blockers with unblock paths) and footprint measurements for the installed
  harnesses.

## [1.13.0] - 2026-09-27

### Added

- `AGENTBROWSER_CHROMIUM_ARGS` operator escape hatch: extra Chromium launch flags,
  space-separated, applied to **headed chromium launches** only. Motivated by Chrome's
  Local Network Access enforcement against LAN-hosted consoles. The headless pool keeps
  stock launch defaults, firefox/webkit launches never receive the flags, and both CDP
  attach paths (`cdpEndpoint`, operator attachment) cannot apply launch flags at all —
  the engine logs a one-time warning at construction when the variable is set there.

### Changed

- Biome warnings cleared across the repo: every `warn`-level finding in production
  sources is fixed individually, `noExplicitAny`/`noNonNullAssertion` are promoted from
  `warn` to `error` in source, and both rules are scoped off for `**/*.test.ts` and
  `**/test-support/**` (test assertions rely on `!` throwing and test doubles need
  `any`; biome's autofix for nonNull is semantics-changing). All 16 workspace packages
  now declare a `lint` script, so `pnpm -r lint` actually checks the previously
  unlinted core/engine/protocol/testkit packages.

## [1.12.0] - 2026-09-25

### Added

- Observed browser/context disconnection ends the exact affected session, revokes
  delegated authority, and reports `engine_disconnected` through the existing
  REST/SDK/CLI/MCP terminal projection. Intentional teardown and page-only close
  remain distinct; no operator intent, crash diagnosis, reconnect or replay is inferred.

- Opt-in local operator Chrome attachment via `session create --cdp-attach`, REST/SDK
  `cdpAttach`, and MCP `browser_create.cdpAttach`. Requires a dedicated profile,
  bearer authentication, a loopback endpoint and an explicit startup acknowledgement of limited network checks.
  Shared diagnostics identify attachment and policy limitations; detach preserves
  operator tabs and the browser. Hosted, multi-tenant and delegated use refuse.

- Navigation failures carry bounded reasons across REST, SDK, CLI and MCP, distinguishing
  egress denial, unresolved names, resolver timeout/refusal, destination connection
  refusal, TLS refusal and browser error documents. CLI returns exit 1 and MCP sets
  `isError` for blocked/timeout results. Unknown causes remain `engine_error`.

- Sampled active-session lease deadlines on REST/SDK create/get/list, CLI and MCP
  inspection. A shared coordinator clock reports absolute TTL and idle deadlines;
  reading session status does not renew idle lifetime. Closing/failed sessions and
  older servers may omit the lease. No terminal history or recovery is implied.

- Bounded, tenant-authorized close facts for recently ended sessions. The coordinator
  distinguishes TTL, idle, explicit and policy termination, retains only detached
  allowlisted facts, and derives remaining lease from the authoritative sample. CLI
  and MCP share the strict terminal-error projector; observed engine disconnection
  uses the same projection.

### Fixed

- Navigation diagnostics come from the trusted routed request, not origin-supplied
  headers. Failed dispatched navigation invalidates old refs, connection errors
  cannot impersonate a browser crash through URL text, and bounded failure output
  retains valid operation IDs for reconciliation without raw transport topology.

- Session initialization rolls back its captured allocation on lifetime-inspection
  failure. Expiry shares teardown ownership, avoids a concurrent second close and
  preserves the existing retry after a settled close failure. A delayed old close
  cannot remove a replacement session.

- Session ID allocation refuses bounded collisions, and late abnormal-teardown
  callbacks use captured context identity before touching a replacement allocation.

### Internal qualification

- Journal intent/dispatch and terminal acknowledgments share authority, replay and
  control-view projections. Application execution revalidates authorization, consent
  and binding pins after storage waits. The SQLite child owner and external commit
  witness have process-loss tests; the raw adapter, runtime selection, bounded manager
  and restart recovery remain gated. This release exposes no durable execution promise.
- Packaged acceptance records bounded phase timings through child cleanup and names
  the active phase on deadline failure. Existing deadlines and behavioral gates stay
  unchanged. Falsy/non-Error callback rejections fail acceptance after owned cleanup.
  Consumer smoke scripts can qualify extracted services with actual Bun
  CLI/MCP binaries through the existing package resolver and workflows.
- The EDGAR research recipe documents JSON submissions, filing discovery, throttling
  etiquette and complete persisted-output inspection.

## [1.11.0] - 2026-09-24

### Added

- Shared launch diagnostics on REST/SDK session create/get/list, CLI JSON and human
  inspection, and MCP `browser_session`. Facts describe actual browser allocation,
  executable selection, viewport policy and init-script registration without paths,
  launch arguments or endpoint credentials. Unsupported adapters omit diagnostics.
- MCP `browser_session` also works without a bound session, using an explicit session
  ID. Inspection requires both `session.control` and `page.observe`; bound inspection
  retains its control and page fields and adds session metadata.

- MCP `browser_page_create` and `browser_pages` reuse the existing SDK/service page
  lifecycle. Pages share their session's cookies and policy; callers use returned IDs.
  Controlled-session creation carries caller-selected operation IDs. Ordinary sessions
  do not gain deduplication, and inventory does not correlate an uncertain create result.

### Fixed

- Release publication refuses duplicate asset names instead of replacing bytes
  under an existing tag, preserving checksums pinned by package managers.

- Session views retain the selected adapter's immutable name/version, including
  auxiliary engines, instead of reading the primary engine on later inspections.
  Capability lookup failures occur before browser allocation and cannot leave an
  unreachable registered session.
- TypeScript SDK `SessionResponse` now reuses the canonical HTTP session view.
  This corrects its previous compile-time claim that `engine.capabilities` was
  returned by these endpoints; that field was never present on the HTTP wire.

- Concurrent Playwright headless/CDP sessions share one pending browser initialization.
  Closing a remote session releases only its context, preserving sibling sessions.
  Failed setup cleans up owned resources; engine shutdown drains pending setup and
  refuses further creates on that engine instance. Service shutdown releases every
  distinct registered engine, including auxiliary pools and connections.

- A resolved Playwright navigation to an internal browser error document now fails
  instead of reporting success. Its diagnostic reason is `browser_error_document`;
  it does not infer a bot wall, disclose the error URL or retry automatically.

- Application discovery, execution (including replay), receipts and operation status
  keep their captured publication authority through HTTP delivery. Late permission
  changes, disconnects and output deadlines suppress unsent responses without
  rewriting committed operation facts. Browser responses and captured operator reviews
  use the same publisher after execution drains and finalizes. Prepare-resume delivery
  failure preserves review state; collection cleanup cannot take over a replacement owner.

- CLI extraction prints complete data instead of silently cutting at 4,000 characters.
  `extract --max-bytes` forwards a UTF-8 response budget through SDK/REST; optional MCP
  exposes the same field. The server enforces one ceiling across all formats (default
  1 MiB, configured at startup with `AGENTBROWSER_EXTRACT_MAX_BYTES`). Oversized results
  fail explicitly without returning partial JSON or evidence.

### Internal foundations

- Storage-neutral operation journal contract with immutable metadata, keyed fingerprints,
  bounded acknowledgment validation and shared adapter conformance tests. Unknown writes
  quarantine further mutations; late acknowledgments cannot restore authority. No concrete
  store, runtime durability setting or restart recovery is enabled.

- Captured operator review views reuse shared page, application and evidence owners
  during their original publication phase. Disclosure checks cannot collect new
  evidence, consume consent or dispatch effects. Durable recovery remains unimplemented.

## [1.10.1] - 2026-09-23

### Added

- SPA-capture robustness. `observe()` now flags an empty-but-successful
  accessibility snapshot over a content-rich DOM (the common
  JS-SPA-not-mounted-yet case) with `degradedReason: "empty-snapshot-nonempty-dom"`,
  distinct from the timeout case, so callers can wait/retry or read via
  `browser_html` instead of mistaking it for an empty page.
- Optional readiness `wait` on `browser_observe`/`browser_screenshot` (and the
  `observe`/`screenshot` CLI commands via `--wait-until/--wait-timeout/`
  `--wait-selector/--wait-pattern/--wait-count`), reusing the `browser_act` wait
  vocabulary. Applied before the snapshot/capture so slow-mounting SPAs do not
  observe empty or screenshot blank.
- Display diagnostics originate on the browser host and pass through REST,
  SDK, CLI, and MCP session responses. Linux checks display environment hints;
  a macOS launchd label alone no longer implies a missing GUI session. Operators
  may declare availability with `AGENTBROWSER_ASSUME_DISPLAY=1` or absence with `0`.

### Changed

- The degraded DOM fallback (`getContentElements`) now covers more ARIA-role
  widgets (`combobox`, `menuitem`, `tab`, `checkbox`, `option`, `contenteditable`)
  and captures a best-effort accessible name, so a timed-out observation stays
  addressable. Empty-DOM thresholds are tunable via
  `AGENTBROWSER_EMPTY_DOM_MIN_TEXT` / `AGENTBROWSER_EMPTY_DOM_MIN_NODES`.

- Capture requests share protocol schemas and runtime validation across REST,
  SDK, CLI, and MCP, including condition-specific wait fields and bounded numeric
  options. Invalid and unsupported options now fail instead of being ignored.
- Screenshot readiness waits reach the HTTP service. MCP also exposes screenshot
  `quality`/`maskSensitive` and observation `sinceRevision`. CLI `describe --schema`
  and MCP output schemas expose the capture contracts; CLI human output reports
  degraded observations. Artifact schemas describe both inline and URL delivery.
- DOM fallback refs bind to the discovered node rather than a guessed accessible
  name, preventing a ref from selecting a different node with a matching name.

## [1.10.0] - 2026-09-23

### Added

- First-class CLI `form prepare` compiles reusable form mappings into bounded,
  block-scoped autofill requests. Scoped stage checks and owned widget popups
  prevent repeated-label and unrelated-option selection (#237–#238).
- Byte-verified uploads accept expected SHA-256 and MIME type. Shared native-form
  evidence and application-owned draft adapters qualify attachment and field
  state across controlled UI/API fixtures (#239, #243–#246, #249).
- Explicit operator-reviewed approvals, application submission reviews and
  payload-bound consent across REST, SDK and CLI. The operator panel supports
  application binding and read-only operation/receipt reconciliation
  (#240–#242, #247–#248, #254, #257, #259, #261–#262).
- Operator-only `AGENTBROWSER_ALLOWED_CIDRS` permits selected private destinations
  at both hostname and DNS-address gates. Defaults remain blocked; loopback,
  metadata and per-session host restrictions still apply. Invalid CIDRs abort
  startup and `/0` emits a warning. Use `/32` for one IPv4 host (#275).
- Offline job-eligibility and listing-review examples use explicit evidence and
  compensation criteria; these are reusable examples, not live job-portal or
  application-submission qualification (#260, #264).

### Fixed

- Application authorization, callback ownership, scoped reads and drain handling
  now reject stale or reentrant owners. Stored application review reads/decisions
  recheck the application authority before evidence-provider invocation and pin
  the original action; provider permission cannot replace application permission.
- Explicitly empty, malformed or conflicting `AGENTBROWSER_API_KEYS` configuration
  now aborts startup instead of selecting anonymous mode. Embedded credential maps
  are copied so caller mutation cannot disable authentication. Unset the variable
  for intentional trusted-local operation; valid `key:tenant` configuration is
  unchanged.
- Engine and HTTP error surfaces use bounded, detached and redacted diagnostics;
  framework logger failures cannot reveal private callback details (#252–#253,
  #255–#256). Document extraction uses the shared stable-read boundary (#263).

### Internal foundations and limits

- Shared dispatch/finalization and bounded publication helpers cover execution,
  lookup, replay and review owners without duplicating authority or operation
  stores (#267, #269–#274). HTTP publication integration, durable journal/recovery
  and restart guarantees remain unfinished; these helpers do not close T5.
- T4/T6 remain partial. No production evidence source is enabled by default; full
  live ATS/job applications, broader widgets and installed external-harness
  qualification remain open. Inbound client CIDRs, OIDC and Basic authentication
  are follow-up designs and are not included in this release.
- CLI and optional MCP executables remain Bun-compiled. The service ships compiled
  JavaScript with production dependencies, qualified on Node 24.21.0. Existing
  browser-egress and platform limits remain as documented in the
  [threat model](docs/threat-model.md) and [release tracker](docs/release-milestones.md).

## [1.9.1] - 2026-09-20

### Added

- CLI cookie-file handoff: `session create --cookies-file <path>` accepts canonical
  JSON, Netscape cookie files or explicitly selected Chrome DevTools TSV. Local
  normalization reuses the session cookie contract and bounded input reader.
  `session cookies <id> --output <path>` creates a private, exclusive JSON export
  and prints only a count/path receipt. Inline `--cookies` remains compatible.
- Completed the bounded T3 regression vertical: shared report contracts, navigation
  reset, CLI `test evaluate`, Node test integration, JUnit/HTML reports, artifact
  links and packaged live qualification (#212, #214, #223, #225–#227, #229–#231).

### Fixed

- Bulk-form verification now checks committed widget state and revalidates the
  original node and block before acting; transient display text cannot stand in
  for a committed value (#232).
- Foundation alignment removes duplicated command/route declarations and pins
  OpenAPI, SDK/CLI/MCP contracts, mode catalogs and verifier composition to their
  shared owners (#213, #215–#221, #224).
- Local development, CI, release packaging and container builds use Node 24.21.0.
  Node 22 remains the supported minimum (#228).

### Qualification and limits

- Cookie files are bounded to 1 MiB and 1000 entries. Malformed, expired, ambiguous
  or unsupported input is refused before session creation. Partitioned cookies
  require explicit whole-entry omission; partition semantics are not supported.
  Existing files and symlink output paths cannot be overwritten. The existing
  packaged acceptance harness exercises all three imports, authenticated navigation,
  private export/re-import and refusal controls with synthetic credentials.
- T3 and widget checks qualify controlled fixtures. Full job applications, popup
  ownership, broader widget coverage, production verification/G6, durable recovery
  (T5) and installed external-harness qualification (T8) remain open. No new service
  endpoint, runtime dependency, MCP tool or CI job is introduced by cookie handoff.
  See the [cookie contract](docs/spec/design/cli-cookie-file-handoff.md) and
  [future job checkpoint](docs/spec/design/t6-job-application-checkpoint.md).

## [1.9.0] - 2026-09-19

### Added

- Completed the T2 shared execution and verification foundation. REST, the SDK
  and the first-class CLI use the existing executor, authority ledger and outcome
  contract; MCP remains optional. Optional `verification.evidenceCorrelationId`
  identifies a business receipt separately from the outer service operation ID
  and grants no permission by itself (#203).
- Scoped application receipt preflight uses authority-owned actor, tenant, mode,
  resource and session-incarnation identity. Deadline-abandoned receipt reads keep
  admission busy until they settle; cancellation or revocation withholds late
  evidence, and operation replay never redispatches writes (#204, #205).
- Evidence sources can require explicit permission for the exact verifier,
  version and bounded input. Generation fences apply through execution, reads,
  evaluation and cleanup. The application receipt helper and narrow deployment
  registry provider compose these checks without another executor or store
  (#206, #207).

### Fixed

- Empty subprocess input now closes stdin without an empty pipe write, avoiding
  an EPIPE race while preserving errors for undelivered nonempty input (#208).

### Qualification and limits

- The existing packaged acceptance job now drives seven real compiled-CLI cases
  and their reconciled replays through an extracted service and Chromium. An
  independent controlled application oracle distinguishes a UI-caused commit
  from a historical receipt, ignored action, failed action, stale state or wrong
  resource, including a lost response after commit (#208).
- This is controlled G4 fixture qualification under an exclusive UI actor
  contract. No production evidence source is installed by default. Deployments
  must register trusted verifiers/sources and explicitly authorize protected
  predicates. Production UI/API parity and G6 remain T4 work; durable recovery
  remains T5. The user-facing QA regression/reporting vertical (T3) is ready to
  begin, not included in this release. See the
  [foundation qualification](docs/spec/evidence/t2-foundation-qualification.md).
- Existing application REST/SDK/CLI commands, bulk-form strategies and outcome
  semantics remain available. No new MCP tool, dependency, package or CI job
  was added for this foundation checkpoint.

## [1.8.20] - 2026-09-17

### Added

- Application authority over REST/SDK/CLI (shared-infra slice 2): operator
  binding via `PUT/DELETE /v1/sessions/{id}/application`, delegated discovery
  (`GET .../application`), execution (`POST .../application/execute`) and
  receipt lookup (`GET .../application/receipts/{operationId}`), backed by
  deployment-injected `applicationAdapters`. A repeated operation ID returns
  the recorded operation as a first-class `{replay, operation}` result (never
  re-executes, never surfaces as OPERATION_RECORDED). SDK `sessions.application*`
  methods and an `agentbrowser application` command group (bind/unbind/
  discover/execute/receipt; the global `--operation-id` is the WRITE identity —
  reads must omit it, they refuse a write identity). New
  `application.discover`/`application.execute` delegated
  capabilities granted only to the dedicated `application` agent mode; browser
  modes stay fenced out. Binding is impossible in unauthenticated local mode;
  without adapters the surface fails closed.

## [1.8.19] - 2026-09-17

### Added

- Qualified multi-step widget strategies for react-select single-select and
  chip-multi-select in the autofill orchestrator. React-select commits via
  click-open → per-char typeText filter → fresh-observe exact match click;
  chip-multi-select commits by typing the filter text and clicking the
  matching chip option. Both verified via post-commit chip text or
  committed-attribute evidence (#191).
- `ServiceActRequest` gains `delay` for typeText per-char pacing (#191).

### Fixed

- MCP tool catalog regenerated from the current build (#191).

## [1.8.18] - 2026-09-16

### Added

- CLI full parity with the REST/MCP/SDK surfaces: `autofill` (payload inline,
  `@file`, or stdin; `--policy` override; per-field receipt render that omits
  values and redacted excerpts), `pdf`, `health [--ready|--live]` (exit 1 when
  unhealthy), `artifact get --out`, `page list/get/close`, `page create --url`,
  `session get`, and `download` + `download collect`.
- Flag completions: `screenshot --quality/--mask-sensitive/--out`,
  `observe --since-revision`, `extract --records`.
- SDK: three health methods, `SessionsClient.download`/`collectDownload`, and
  the `parseAutofillRequest` re-export.

### Changed

- Recipe: deterministic keyboard-menu commit procedure (type-to-filter →
  short walk → Enter), the focus-purity rule for keyboard menus, and
  targeted-press-`Delete` chip removal (#170).

## [1.8.17] - 2026-09-16

### Added

- Native scoped bulk autofill: `POST /v1/sessions/{sid}/pages/{pid}/autofill`
  (SDK `sessions.autofill`, MCP `browser_autofill`) accepts a field payload
  upfront (1-50 fields; match by role/label/labelRegex/dataAutomationId with
  optional fieldset block scoping) and the service owns the serial
  resolve → act → reobserve → verify loop, returning per-field verification
  receipts plus a whole-page HTML artifact reference (#174). Native
  text/email/tel/url/search/number inputs, textareas, and native single
  selects are delivered; React-Select/active-descendant comboboxes, chip
  multi-selects, password/file/multi-select inputs are refused with receipts
  rather than guessed at. Values support `vault://` references; operation IDs
  cover the whole batch for delegated sessions; the final pass rechecks all
  previously verified fields. See `docs/bulk-autofill.md`.

## [1.8.16] - 2026-09-15

### Added

- `typeText` action: real per-character keystrokes (focus + per-char
  keydown/textInput/keyup, optional inter-character `delay` 0-1000ms) for
  widgets that ignore programmatic value setting — search-as-you-type boxes,
  typeahead filters, keystroke-driven masks. Chromium implements it; Firefox
  and Safari refuse the action like other unqualified engine features.
  Value bounded at 5000 characters (#170).

### Changed

- Recipe: deterministic keyboard-menu commit procedure (type-to-filter →
  short walk → Enter), the focus-purity rule for keyboard menus, and
  targeted-press-`Delete` chip removal (#170).

## [1.8.15] - 2026-09-15

### Added

- `count` on `press` (1-20, default 1): the keypress repeats inside a single
  action and one revision bump covers the run (#165). Spinbutton-style
  controls need repeated keypresses, and the revision bump from each
  individual press invalidated the ref before the next one, costing an
  observe round trip per press. Surfaced through the protocol, engine
  (Chromium), CLI `act press --count <n>`, and the MCP `browser_act` schema;
  Firefox and Safari refuse the option instead of silently pressing once.

### Changed

- Fill verification (`expectValue`) re-reads once after a short settle before
  failing (#164). The single post-fill readback raced late async
  normalization on production form widgets and reported `VALUE_MISMATCH` for
  values that had landed. The write is still never replayed.
- Non-sensitive `VALUE_MISMATCH` errors now carry `expected` and `actual` in
  details, making the widget's normalization visible without a separate HTML
  round trip (#164). `sensitive: true` fills and password inputs keep the
  value-free error contract.

### Fixed

- A partial counted-press run (a press fails after earlier ones landed)
  bumps the revision; previously the bump was skipped, leaving pre-run refs
  trustworthy after a page mutation (#165).

### Docs

- Interactive-forms recipe: keyboard-commit pattern for select/multi-select
  widgets (arrow walk + Enter; highlight starts at the current value),
  locale selectors resetting dependent blocks, digits-not-display-text for
  spinbutton fields, commit probing via the trigger control's accessible
  name, and `sensitive` fill guidance (#166).

## [1.8.14] - 2026-09-15

### Added

- Page `GET /v1/sessions/{sid}/pages/{pid}` now returns `url` and `title`
  (both secret-redacted) instead of a fixed shell (#152).
- `include: ["formControls"]` on observations mints refs for interactive
  controls the ARIA snapshot misses (div-based widget triggers carrying
  `data-automation-id`, `aria-haspopup`, or inline handlers), bound like any
  ref with document-level evidence (#153). ADR-021.
- `browser_html` MCP tool returning the page HTML inline as ground truth for
  widget state (#153). ADR-020.
- `continueFrom` on `browser_observe` to resume a truncated observation from
  its continuation cursor (#153).
- `checked` on observed checkbox/radio/switch elements, end to end (#154).

### Changed

- `fill` accepts `expectValue`: post-fill readback with `VALUE_MISMATCH`
  (HTTP 422) on disagreement (#154). Single-write contract per the
  coexistence integration evidence.
- Workday-class long-form patterns documented in
  `docs/recipes/interactive-forms.md` (#155).

## [1.8.13] - 2026-09-14

### Changed

- Default session TTL raised from 15 minutes to 3.5 hours (`SessionCoordinator`
  default; operator override `AGENTBROWSER_DEFAULT_TTL_MS` unchanged, per-session
  `ttlMs` still wins). Long flows keep their session across a working block, but
  a session that outlives usefulness now occupies its browser slot 14x longer.
  To retain the previous window: `AGENTBROWSER_DEFAULT_TTL_MS=900000`.

## [1.8.12] — 2026-09-13

### Added

- Per-session `snapshotTimeoutMs` override (1-30000ms) across the protocol,
  API, core, CLI (`--snapshot-timeout`), MCP server (`browser_create`), and
  Playwright engine (#143), for sessions known to navigate large or complex
  pages where the default whole-page ariaSnapshot budget would be exceeded.

### Fixed

- `observe()` no longer silently degrades on large/complex forms (#143). The
  whole-page ariaSnapshot budget default is raised 1000ms → 5000ms; when the
  budget is still exceeded, observations now carry an explicit
  `degraded: true` / `degradedReason: "aria-snapshot-timeout"` marker on
  `browser_observe` and `browser_snapshot` responses instead of returning a
  DOM-tag-only element list with no names, values, or custom widgets and no
  signal. Independent per-element `isVisible()`/`isEnabled()` reads are
  parallelized instead of one sequential round trip per element, removing the
  main source of outright observation timeouts on pages with hundreds of
  elements.

## [1.8.11] — 2026-09-13

### Added

- Explicit, off-by-default `allowServiceWorkers` session option across the
  protocol, API, core, CLI, MCP server, and Playwright engine (#140). Callers
  can enable service-worker-dependent functionality for one session while
  accepting that service-worker-originated requests bypass routing-based
  egress checks. Sessions with an active request policy still block service
  workers by default; see
  [ADR-019](docs/adr/019-explicit-service-worker-opt-in.md).

### Fixed

- Headed Playwright sessions now expose a locale-derived `navigator.languages`
  chain including the base language fallback without duplicates (#140), such
  as `["en-US", "en"]` or `["fr-CA", "fr"]`. Headless behavior is unchanged.
  Live effectiveness of this change and the service-worker opt-in against
  the observed Ashby ATS rejection remains unproven.

## [1.8.10] — 2026-09-12

### Fixed

- Egress choke point (`installEgress()`) corrupted body-bearing uploads: its
  `route.fetch()`/`route.fulfill()` replay did not preserve request bodies
  with the fidelity some upload flows require, causing signature-checked
  multipart uploads (e.g. S3 presigned-POST, a common direct-to-cloud-storage
  pattern) to fail with a 400 even though the identical request succeeds when
  sent natively (#137). `POST`/`PUT`/`PATCH` requests now take the same
  hostname/IP-range verdict check but call `route.continue()` instead,
  leaving `GET`/`HEAD` on the original fetch/fulfill path for redirect-hop
  and response-size inspection. The SSRF-relevant guarantee is unchanged;
  what's given up for these methods is redirect-hop re-checking and
  response-size/body-size capping — see
  [ADR-006](docs/adr/006-network-egress-policy-ssrf.md).

## [1.8.9] — 2026-09-11

Post-release hardening for the `upload` action and the hidden-file-input
discoverability follow-up (PRs 130–132). Strictly additive or
refusal-improving; no route was removed.

### Added

- `observe` enrichment token `fileInputs` (`include: ["fileInputs"]`): mints
  revision-scoped refs for every `input[type=file]` on the page — hidden ones
  included — as `role:"fileinput"` elements carrying `attributes`
  (`id`, `accept`, `multiple`) and a resolved name (aria-label → `label[for]`
  text → `name` → `id`). Available across the HTTP API, the `browser_observe`
  MCP tool, the CLI (`observe --include fileInputs`), and the TypeScript SDK.
  Untargeted `upload` on a multi-input page refuses with `TARGET_AMBIGUOUS`
  details naming every discovered input (`count`, `inputs[]`, `advice`), so
  the observe-and-target advice is actionable exactly where it fires.

### Changed

- Targeted `upload` is exempt from the targeted-action visibility gate:
  hidden Dropzone-style inputs are targetable by ref. `TARGET_DISABLED` still
  applies, and targeted upload now passes the executor's full staleness gates
  like every targeted action — a detached ref refuses with retryable
  `STALE_TARGET` instead of mis-attaching.
- The CLI `act upload` accepts the file path(s) in the ref slot when no ref
  is given, making the no-target single-input form reachable from positionals
  (the empty-string `''` workaround is no longer needed).

### Fixed

- Upload adversarial-review hardening (#130): the server binds `127.0.0.1` by
  default (was `0.0.0.0`; an explicit `HOST` still wins), non-regular files
  refuse with `INVALID_REQUEST`, non-absolute paths are rejected before
  engine contact, acting on a non-file element normalizes to
  `INVALID_REQUEST`, and plan step results carry the upload evidence payload.

## [1.8.8] — 2026-09-11

Native file attachment for agents (PR #128, [ADR-018](docs/adr/018-upload-action.md)):
the one capability the Dice-class real-world flows exposed as genuinely missing —
attaching a local file to a page's `<input type=file>` without the native OS
picker or any JS injection.

### Added

- The `upload` wire action: `{ action: "upload", target?: { ref }, paths: [...] }`.
  `paths` **replace** the input's current file list (setInputFiles semantics).
  `target` is optional because hidden file inputs — the common case — never
  appear in the ARIA snapshot and therefore get no ref; no-target mode binds
  the page's only `input[type=file]` and refuses honestly otherwise
  (`TARGET_NOT_FOUND` at 0, `TARGET_AMBIGUOUS` with `{count}` at >1).
- Path validation before page contact: each path is `fs.stat`-checked
  server-side; a missing file is `INVALID_REQUEST` and the revision is
  untouched.
- Evidence over assertion: the act response carries
  `result: { success, files: [{name, size}], inputFiles?: [names] }` —
  `files` from stat of the validated paths, `inputFiles` read back from the
  live input before the revision bump. Only `upload` produces a per-action
  payload; other actions keep the bare wire shape.
- Delivered across every surface from the single action-type tuple
  ([ADR-015](docs/adr/015-cross-package-contract-single-source-of-truth.md)):
  HTTP `act`/`plan`, `browser_act` MCP tool, CLI `agentbrowser act upload`,
  OpenAPI schema, TypeScript SDK, and FakeEngine (which advertises the
  delivered tuple, so it now delivers what it claims).
- [ADR-018](docs/adr/018-upload-action.md) and a new section in
  [synthetic input limitations](docs/synthetic-input-limitations.md): attach
  files through `upload`, never by clicking the picker.

### What this does not claim

- No native-picker bypassing and no `isTrusted` claims: the input is set
  through the browser's own file machinery, and events the page observes
  remain synthetic.
- Safari engine returns `ENGINE_UNSUPPORTED` for `upload` (safaridriver has
  no equivalent primitive).
- Risk classification is unchanged (ADR-007); operators who want to gate
  uploads add an `{action: "upload"}` rule.

## [1.8.7] — 2026-09-09

Post-release smoke findings batch (PRs 119–123): empty-body request tolerance,
session page visibility, branded-Chrome headed launches, and the deterministic
`records` extraction format (TD-12), plus its docs. Behavior changes are
strictly additive or fix incorrect rejections; no route was removed.

### Added

- `records` extraction format: list extraction with plain CSS selectors —
  `container` plus per-field selectors evaluated within each matched record —
  returning `Record<string,string>[]` with per-record evidence (`url`,
  `revision`, `hash`, `index`). Available across the HTTP API, the
  `browser_extract` MCP tool, and the TypeScript SDK types. Invalid selectors
  are rejected with `INVALID_REQUEST` (400) naming the offending selector.
- `pages` count on session create, get, and list responses (sessions are
  page-less by default; the count makes that contract visible).
- `url` parameter on page creation: the page navigates during creation, so the
  listed page url is the requested one. A failed navigation tears the page
  down and surfaces the error instead of stranding a registered page.
- Branded Chrome support for headed sessions (ADR-016): detected Google
  Chrome is preferred over bundled Chromium (`AGENTBROWSER_CHROME_PATH` still
  wins; `AGENTBROWSER_PREFER_BUNDLED=1` forces bundled, e.g. for CI). The
  selected binary is logged at headed session create.
- Documentation: cookie seeding requires the `name/value/domain/path` wire
  form (url-form is rejected), export via `GET /v1/sessions/{id}/cookies` is
  compatible, and empty `cookies: []` is a silent no-op.

### Changed

- Headed sessions default to a window-true viewport (`viewport: null` plus
  `--start-maximized`) instead of the pinned 1280×720; an explicit viewport
  still pins in both modes and headless is unchanged.
- `links` extraction parses anchors with a real DOM (linkedom) instead of a
  regex, so nested-anchor text and `>` inside attribute values are extracted
  correctly.

### Fixed

- Requests carrying `content-type: application/json` with a zero-length body
  are no longer rejected with 400 (`FST_ERR_CTP_EMPTY_JSON_BODY`); the empty
  body resolves to undefined and routes handle it, while malformed JSON is
  still a 400.

## [1.8.6] — 2026-09-08

Act and wait robustness, richer observations, popup lifecycle, and inline
artifact payloads (PRs 104–107, adversarially reviewed), plus the T2c1
destination-policy and session-owned TCP admission prerequisite (PR 108).
Everything user-facing is additive or strictly opt-in: new wait conditions and
act options default off, new observation fields ride `include`, and existing
error semantics only gain detail fields. No route was removed and no default
behavior changed.

### Added

- New delivered wait conditions, usable both in `wait` and per-act:
  `urlPattern` (glob or `/regex/`), `selectorVisible`, and `minElements`.
  Conditions the engine cannot evaluate natively are polled by the service
  with a bounded deadline; a `timeoutMs` of 0 no longer means "wait forever"
  anywhere (floored at 1ms).
- Opt-in act remap (`remap: true`): when a reference's binding went stale, the
  service takes a fresh observation and re-targets only when exactly one
  candidate matches the original role + name; the response reports
  `remap {from, to}`. Live semantic evidence (a fingerprint mismatch) is never
  remapped — only binding staleness is healable.
- `/act` batch form: `{"steps": [...]}` of 1–20 flat actions, executed
  sequentially with stop-on-first-error, per-step results, and the plan-grade
  self-heal for pre-observed references.
- ACTION_TIMEOUT diagnostics: when an action times out on a target, the error
  details carry `blockedBy {tag, role, name}` from an engine hit-test and a
  diagnostic screenshot artifact id. Diagnostics are best-effort and can never
  outlive the error itself.
- Observe opt-ins via `include`: `"overlays"` returns aggregate blockers
  `{tag, name, covers}` (capped at 30 visible elements), and link elements
  carry their raw `href` (capped at 2048 chars with `hrefTruncated`).
- Act validation errors now list the sorted `validActions`, and the deprecated
  `type` alias is accepted (with a warning) when `action` is absent.
- Inline artifacts: screenshot, pdf, and html responses carry
  `inline {contentBase64, byteSize}` when the artifact is under
  `AGENTBROWSER_INLINE_ARTIFACT_MAX_BYTES` (default 256 KiB, clamped to
  0–10 MiB, invalid values fall back to the default). The artifact is still
  registered in the store either way.
- Popup lifecycle: popups opened by session pages are auto-adopted — they
  appear in the page list with `openerPageId`, emit `page.created`, and are
  fully operable. `page.crashed` is emitted, and a silent engine stream end
  fans out `page.destroyed {reason: "streamEnded"}`. Adoption is serialized
  per session and capped at 20 popups per session. Popups opened with
  `rel="noopener"` have no opener and are never adopted.
- T2c1 gateway prerequisite: destination-policy adaptation produces explicit
  immutable request/destination pairs (TCP-only coverage; one extracted host
  predicate preserves exact/suffix, deny-first and empty-allowlist semantics),
  and sessions own a shared TCP admission scope (8 concurrent slots under the
  32-slot cap) used by downloads. No CONNECT listener — T2c2/T2c3 remain open.

### Changed

- `STALE_TARGET` and `TARGET_NOT_FOUND` refusals carry structured details
  `{ref, revision, role, name}` and a `remapEligible` marker restricted to
  binding staleness; a caller's own `expectedRevision` mismatch or a live
  fingerprint mismatch stays ineligible for remap.

### Docs

- New guides: [human handoff](docs/human-handoff.md) (working a session with a
  person in the loop) and [synthetic input limitations](docs/synthetic-input-limitations.md)
  (what `isTrusted: false` costs and what works).

## [1.8.5] — 2026-09-07

Observation resilience for pages whose elements never stabilize, page
discovery, a longer default idle window, and validated semantic evidence
behind the recovered bindings (PRs 91–98).

**Upgrade notice:** 1.8.5 is the owner-selected release label, not a bug-fix-only
SemVer patch. The page-listing API is additive, idle sessions live longer by
default, and custom network-policy embeddings require migration for downloads.
See [upgrade requirements](docs/operations.md#upgrading-from-184-to-the-185-candidate)
before deployment; private package manifests do not waive embedding compatibility.

### Added

- `GET /v1/sessions/:sessionId/pages` lists a session's pages in creation
  order with each page's cached URL when available — the discovery path
  when a create-page response was lost, and the answer to which page ids are
  live in a session.
  URL metadata is secret-redacted, may lag navigation, and is omitted when the
  engine has no synchronous cache; listing never waits for browser URL I/O.

- Trusted in-process `buildServer({ networkPolicy })` configuration now forwards
  the existing service policy option; session policy remains restrict-only.
  No HTTP option or stock-default relaxation is introduced.

### Changed

- The default session idle timeout is now 10 minutes (previously 2). The
  default remains operator-tunable via `AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS`
  and per-session `idleTimeoutMs` still wins.

- Private, bounded TCP connection-authority primitive with revocation, retained
  in-flight admission and connected-peer verification, backed by deterministic
  and real HTTP/TLS tests. Direct downloads now use it per session generation,
  with shared transfer/socket admission, cancellation before engine teardown,
  logical-host TLS verification and bounded terminal diagnostics. No new
  browser-containment guarantee or public route is exposed.

### Fixed

- Pages whose elements never stabilize — a perpetually animating shared
  header, a hydration loop — no longer fail the whole observation. Per-element
  aria snapshots that cannot stabilize degrade instead of erroring, and the
  recovered bindings act only on validated semantic evidence: evidence is
  fixed-size and provenance-locked at observation, timed-out element captures
  fall back to whole-document evidence that must still match at action time,
  and actions without available semantic evidence refuse with a retryable
  `STALE_TARGET` instead of proceeding on DOM identity alone. One monotonic
  budget bounds snapshot waiting across the document and all elements, and
  `AGENTBROWSER_SNAPSHOT_TIMEOUT_MS` (or the `snapshotTimeoutMs` engine
  option) accepts integer values 1–30000 ms; invalid environment values fall
  back to the default while invalid explicit options throw.
  An observed named control that cannot be safely rebound after total snapshot
  timeout also returns retryable `STALE_TARGET`; unknown refs remain missing.

- Server tarball packaging no longer retains pnpm's API self-link back into the
  build checkout. PR and release CI share extracted-package real-browser checks,
  artifact validation and matching-client workflows before publication.

- CLI commands forward `--api-key` (or `AGENTBROWSER_API_KEY` when no flag is
  supplied) to the SDK, allowing commands against authenticated servers.

- Cancel direct downloads on session termination and prevent late artifact
  publication. Preserve one overall deadline across redirect/body policy work,
  enforce encoded and decoded byte limits, and drain each redirect's lease.
  Download-enabled sessions capture a fixed policy snapshot; custom policies
  must explicitly support immutable snapshots instead of silently losing rules.

- Classify mapped/expanded IPv6 addresses consistently for configured loopback,
  private-network and metadata policy rules. Reject malformed or scoped resolved
  addresses, ambiguous raw dotted-quad hostnames and invalid download resolver
  address/family pairs before connection. Preserve explicitly permitted local
  downloads. This R14/T2b0 correction does not close browser egress gap R4 or
  introduce OS-enforced containment.

## [1.8.4] — 2026-09-07

Patch release of the independently reviewed engineering corrections in PRs
77–83 and transport-feasibility evidence in PRs 84–88. This release does not
introduce a contained browser profile or close the remaining egress gaps.

### Fixed

- Preserve tenant ownership of retained artifacts and traces after session
  closure; redact structured evidence, events and extraction boundaries using
  the configured secret registry.
- Bind Playwright element references to live node identity and enforce
  operator-controlled approval rules with page/action-bound consent.
- Unify action wire semantics and adapter error normalization; keep SDK
  deadlines active through response-body consumption and preserve error details.
- Preserve policy delegation and bound direct-download redirects, response
  collection and retained downloads; expose captured downloads through a typed
  engine contract.
- Centralize observation byte/element budgets and continuation handling; bound
  event retention and approval-token admission.
- Correct Safari session-scoped transport and lifecycle races, with explicit
  refusal when the guarded deployment requires unsupported egress enforcement.

### Changed

- Synchronize all first-party package versions and generated API/CLI stamps
  with the root product version. CI verifies runtime versions and release-tag
  consistency; npm publication depends on the tag guard.
- Retain independently reviewed worker-policy/startup probes, raw evidence and
  79 offline regression tests. The sole-owner comparison does not reproduce
  the earlier early-execution result and does not establish production enforcement.

### Known limitations

- **R4 and T1 remain open:** later browser redirect hops and worker WS/WSS
  coverage are not fully enforced. Execution startup pauses do not gate the
  initial worker-script request. Do not rely on this release for required SSRF
  containment of hostile browsing.
- Native local operation remains supported. A contained Linux Chromium profile
  still requires the accepted transport gates and OS-enforced gateway-only
  egress; full multi-tenant ADR-008 isolation remains deferred. See the
  [remediation tracker](docs/engineering-review-remediation.md) and
  [transport reassessment](docs/egress-transport-reassessment.md).

## [1.8.3] — 2026-09-05

Closes the 2026-08-31 engineering-hygiene audit in full — every finding is now
fixed (see [docs/hygiene-audit.md](docs/hygiene-audit.md)).

### Fixed

- **Screenshots and PDFs from real engines were 0-byte artifacts.** The real
  Playwright and Safari engines silently dropped the `bytesBase64` byte
  payload that `service.ts` needs to build an artifact, so every real
  screenshot/PDF was a 0-byte file — uncaught because all service-level
  tests ran against `FakeEngine` only. The engine contract is now
  compiler-enforced via the `CapturedArtifact` type, with a real-Chromium
  regression test (hygiene C6).
- **Genuine navigation aborts were silently mislabeled as egress-policy
  blocks** (hygiene E3). `navigate()` matched Playwright errors against a
  `net::ERR_ABORTED`-style regex, but every egress deny actually goes
  through `route.fulfill` (detected via the `x-agentbrowser-blocked`
  header) — the regex's only live effect was reporting unrelated real
  navigation aborts as `{status: 'blocked'}`. The regex is removed; real
  aborts now propagate. A regression test reproduces a genuine
  `net::ERR_ABORTED` (superseding a navigation) and confirms it surfaces.
- **`pdf()`/`screenshot()` fail cleanly when an engine violates the
  capture contract.** `CapturedArtifact` is compile-time only and
  `BrowserEngine` is a plugged-in interface a non-TypeScript engine could
  implement over RPC/subprocess; a non-conforming result previously
  crashed with an opaque `Buffer.from(undefined, ...)` TypeError. Both
  routes now throw a diagnosable `INTERNAL` `ServiceError` naming the
  contract violation, with contract-violation tests.
- **Teardown race in listener cleanup** (hygiene D1's own first draft):
  the initial fix used `page.removeAllListeners()`, which strips
  Playwright's own internally-attached listeners too and raced the Obscura
  engine's context-level route handler into an unhandled
  "route.abort: ...has been closed" rejection on teardown. The app's four
  listeners are now removed individually via `.off()`.

### Changed

- Internal consolidations from the audit's low-severity findings,
  behavior-neutral with the existing test suite unchanged: `server.ts`
  `route()`/`params()` helpers (F1/F2), MCP tool catalog hoisted out of
  `buildMcpServer` (F4), one shared SDK `HttpClient` replacing
  per-method HTTP boilerplate (F6), injectable logger (G2), dead
  `composite: true` dropped from tsconfig (G1), `FakeEngine` properly
  typed (C6), and documentation updates marking findings already fixed in
  v1.8.2 (C2/C4/C5/D2/E4).

## [1.8.2] — 2026-09-04

### Security

- **SSRF range gaps closed** (hygiene C3, the audit's top security-adjacent
  item): `blockPrivateIPs` previously allowed entire non-routable ranges —
  `169.254.0.0/16` link-local (including the ECS task-metadata address),
  `100.64.0.0/10` CGNAT, all of `0.0.0.0/8` beyond exact `0.0.0.0`,
  `198.18.0.0/15`, and every IPv6 literal (`::1`, `fe80::/10`, `fc00::/7` —
  the parser was IPv4-only). Public addresses unaffected.

### Fixed

- **Plan steps are validated again** — a v1.8.1 defect: an unvalidated
  `waitMs` on a `waitForLabel` step could hang the plan route in an infinite
  observe loop forever (`waitMs: "abc"` → NaN deadline → a poll that never
  exits; `1e308` → the same via Infinity). The route now schema-checks every
  step (`PlanStepSchema`, the last unvalidated request surface) and the
  service clamps hard (100–60000 ms, finite, typed rejection) as defense in
  depth.
- **Error-to-HTTP mapping is exhaustive** (hygiene F3): three live-thrown
  codes reached clients as 500s — `ACTION_TIMEOUT` (as an incoherent
  500 + retryable), `ENGINE_CRASHED`, and `INVALID_TENANT_ID` (which wasn't
  even in the enum, violating the protocol error schema). Timeouts now map
  to 504, invalid tenants to 400, `SESSION_EXPIRED` to 410; the table is
  `satisfies`-checked so a new code without a mapping is a compile error.

### Added

- **Network summary** (the last required §5.1 evidence row): the egress
  choke point emits `request.started`/`finished`/`failed` at every path —
  including all five previously-silent denial sites, each carrying the
  POLICY's own code/rule instead of a flattened 'deny'. URLs are recorded
  as origin+path only (query strings are the token carrier and are dropped
  at the engine). Events ride the existing pipeline into their own bounded
  ledger (a request flood no longer evicts console lines) and replay via
  `?type=request.finished`.
- **The CLI ships** — previously uninstallable by any packaged means (brew
  had only the MCP binary and the server wrapper; the package is private).
  Release artifacts now include `agentbrowser-cli-<target>` for all five
  targets, `--help`-smoked wherever the runner can execute them.
- **The CLI/MCP session flags dogfooding actually needed**:
  `--idle-timeout` (the 2-minute default was yanking headed human-in-the-loop
  logins mid-flow), `--cookies` + a `session cookies` export command (the
  full credential-handoff loop), `--allow-downloads`/`--max-download-bytes`,
  `--locale`, `--timezone-id`, `--allow-hosts`/`--blocked-hosts`; MCP
  `browser_create` gains `idleTimeoutMs`.
- **Operator session-default env vars**: `AGENTBROWSER_DEFAULT_TTL_MS` and
  `AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS` (per-request values still win).
- **Evidence export from the CLI**: `session trace` (spans artifact),
  `page html` (page HTML artifact), and `session events [--type]` (console +
  request-ledger replay) — the evidence routes are now reachable from
  scripts without curl, via new SDK `trace()`/`html()`/`events()` methods.

### Changed

- **compact_dom de-scoped** (ADR-003 amendment): the Evidence row it
  belonged to is served by the HTML artifact + interactive/content modes,
  there is no reserved plumbing and no consumer, and an ungated delivery
  flip would recreate the exact lie the typed rejection was added to
  prevent. The normalizer-only revival path is documented if a consumer
  appears.
- `SessionPolicy.allowedHosts` is optional (a blockedHosts-only or
  downloads-only policy is a legitimate restrict-only combination).
- operations.md: the "30-second sweep" claim corrected (the API service uses
  lazy-on-access expiry plus a 1-hour background sweep).

## [1.8.1] — 2026-09-04

### Added

- **Evidence completion** (spec §5.1, A3): the span tracer now actually runs
  in production (built and tested since v1.7.1, but never constructed by the
  server); `POST /v1/sessions/:id/trace` exports a session's completed,
  secret-scrubbed spans as a JSON artifact, and
  `POST /v1/sessions/:id/pages/:id/html` captures the page's raw HTML
  (explicitly marked NOT secret-redacted — typed-in form values ride it
  verbatim). `GET /v1/sessions/:id/events/replay` exposes a bounded
  per-session event ledger for late subscribers. Requesting an undelivered
  observation mode (`compact_dom`, `visual`) now fails typed instead of
  silently returning zero elements.
- **`waitForLabel` plan steps** (TD-BROWSER-8 Phase 2): a plan step can
  declare `waitForLabel` (substring match) + `waitMs` instead of a fixed
  `target` — for fields that only exist after a prior step (e.g. a password
  field revealed by clicking Continue). The executor polls, resolves the
  ref itself once the label appears, and fills it into the step; a miss
  surfaces as a typed `PLAN_WAIT_TIMEOUT`, never a hang.
- **`/plan` and `/snapshot` are now documented in OpenAPI** — both have been
  reachable since Phase 1 but were invisible to any spec-generated client.
  The snapshot route (and SDK method) accept `maxElements`/`maxBytes`
  bounds; `executePlan`'s response gains `newRevision`. The CLI gains
  matching `snapshot` and `plan` commands.
- **Schema extraction is complete end-to-end**: CLI `--schema`, SDK
  `ExtractResult.modelUsed`/`tokenUsage`, and REST/SDK/MCP test coverage
  (previously wired in Phase 1 but never tested on those surfaces). The
  schema argument itself is now shape-validated instead of accepting any
  truthy value.

### Fixed

- **Model-adapter hygiene in schema extraction** (hygiene finding E1, worse
  than originally audited): a model failure no longer discards deterministic
  results that had already succeeded, and — the more serious half — **page
  text is now redacted before an injected model adapter sees it**, not only
  on the value it returns. No production code path injects a model today
  (this closes a public-API hazard, not a live leak). Text handed to an
  adapter is also capped. Property-name matching is regex-escaped and
  word-boundary anchored (`price` no longer matches inside `pricey`, E2).
- A stale-then-successfully-remapped plan step now decays its own churn
  bump, matching the always-clean success path. Previously only fully clean
  steps decayed churn, so a plan with several remapped-but-fine steps could
  ratchet upward forever and stay pinned in verified mode even after the
  page had genuinely stabilized.
- A dead `vitest` `resolve.alias` in `packages/api` (relative to CWD, so
  silently broken under `pnpm -r test`) is fixed — surfaced by this cycle's
  first API-package test importing `@agentbrowser/engine-playwright`
  directly.

### Changed

- **ADR-005: session-resume snapshots are de-scoped**, not implemented.
  Auth re-entry — the only real reason to want this — is already fully
  served by cookie seeding (TD-BROWSER-6); the one genuine gap
  (localStorage-based auth) has zero engine support today and would need
  its own scoped TD if it ever becomes a real need. See the ADR for the
  full reasoning.
- TD-BROWSER-8 status corrected: the adaptive-modes table previously
  claimed VERIFIED mode inserts an observation before every step and rides
  snapshots on responses — neither was ever built. VERIFIED only changes
  remap-matching strictness (role+label required, never guesses).
- ADR-003: `compact_dom` is documented as not delivered (was silently
  returning an empty observation; now a typed `INVALID_REQUEST`).

## [1.8.0] — 2026-09-04

### Added

- **Nine new delivered actions** (spec §5.1 parity): `hover`, `dblclick`,
  `clear`, `check`, `uncheck`, `wait`, `goBack`, `goForward`, `reload` — across
  REST, MCP (`browser_act`), CLI, and SDK; `hover`/`wait` are non-mutating
  (refs survive them). `upload` (needs file transport + size policy) and
  `download`-as-action (already first-class policy-gated endpoints) are
  deliberately excluded.
- **Working per-session policy from every client**: the nested `policy` object
  on session create is validated and mapped onto the session (previously
  silently ignored outside REST flat fields); the SDK type surface now mirrors
  the protocol's.
- `browser_extract` gains the `schema` argument (format `schema` was
  REST-only); the MCP tool's format list had omitted it.

### Fixed

- **Every HTTP `select` was rejected** — the flat transport's single `value`
  was never coerced into the protocol action's `values` array (latent since
  select shipped; regression-tested end-to-end).
- **maxBytes hardened**: measured in real UTF-8 bytes (was UTF-16 units —
  multibyte pages could exceed the budget ~3x), the text field and diff
  `changes` are now budgeted (previously only the element list), the
  sinceRevision diff path and post-action observations no longer bypass the
  budget, and non-integer/zero values are rejected.

### Changed

- **ADR-015 implemented** (Proposed → Accepted): contract primitives live once
  in `@agentbrowser/protocol` — the `e<rev>_<ord>` grammar (`REF_PATTERN`/
  `parseRef`, replacing four divergent copies), the extract-format list
  (seven copies had drifted on whether `schema` exists), `UsageError` + one
  user-facing error formatter (the copies had diverged on the STALE_TARGET
  hint), `ActionEffectType`/`EngineTarget` aliases (a latent same-name type
  collision between protocol and engine), and compiled TypeBox request/action
  validation replacing per-surface `typeof` checks — with type-level contract
  tests so schema/type drift fails `type-check`.
- `SessionRequest.engine` accepts registered engine names (the registry
  routes arbitrary names and fails loudly on unknown ones; the old
  two-literal enum couldn't express the shipped semantics).

## [1.7.1] — 2026-09-04

### Added

- Bounded-collection eviction discipline (TD-BROWSER-9, née TD-BROWSER-8): `BoundedCache`/
  `RingBuffer` primitives in `@agentbrowser/core`, applied to the redaction cache, span buffer, and
  network-policy request log (previously **fully unbounded**, not just large); indexed lookups for
  approval-token-by-session and element-by-ref replace per-call linear scans; the plan executor's
  churn map is cleaned up on session/page teardown instead of leaking one entry per session:page
  pair for the life of the process.
- **Summary quantiles over a bounded window** (TD-BROWSER-9, A2): metrics summaries keep
  incremental all-time-exact `_count`/`_sum` and compute quantiles over the most recent
  `maxSamplesPerSummary` samples (default 1,000) — quantiles are now recent-window signals, not
  all-time promises; identical to prior behavior below the window size.
- **Operations guide** (`docs/operations.md`): configuration, auth, health/metrics, session
  lifecycle, engine selection, deployment notes, and a troubleshooting table.
- **`docs/README.md` re-indexed by audience** with a task-based routing table; stale
  "planned documentation" entries resolved (the threat model has existed for a while; the
  operations guide now does too).
- engine-obscura's scope relative to ADR-013's no-evasion rule is now stated explicitly in
  `docs/engines.md` — outside the rule (unregistered, unreachable by `createSession`,
  benchmark-only), and barred from the engine registry until a follow-up ADR closes its tested
  egress-enforcement gap.
- **A `check-doc-links.mjs` CI check** (`scripts/`) validates every relative markdown link and
  heading anchor across the repo; wired into the lint job.
- **Documentation audit and reconciliation**: `CLAUDE.md` no longer claims the project is in
  "Phase 0" (the MVP and five post-MVP TDs have shipped since); the MVP planning docs
  (`technical-design.md`, `implementation-roadmap.md`, the phase progress summaries) carry
  historical-record banners instead of presenting a completed plan as still-open work; 11 of 15
  ADRs are reconciled against current code (isolation-tier honesty in ADR-008, the real 11-tool
  MCP surface in ADR-009, the real approval-token flow in ADR-007, real egress defaults in
  ADR-006, and more).

### Fixed

- **The two decision-record numbering collisions introduced while "resolving" the prior pair are
  now actually resolved.** 1.7.0's changelog entry below claimed the ADR/TD-BROWSER-8 collisions
  were closed; the renumbering picked 012 and TD-BROWSER-8, which — unnoticed at the time — were
  *already* taken by the Accepted, shipped snapshot/plan-batching work (ADR-012, TD-BROWSER-8).
  The Proposed, not-yet-implemented docs move again: the cross-package-contract ADR is now
  **ADR-015**, and the bounded-in-memory-collections TD is now **TD-BROWSER-9**. `docs/README.md`'s
  index is corrected to list all four documents (the two Accepted/shipped ones were previously
  missing from it entirely).
- **`browser_plan`'s MCP schema didn't declare `sessionId`/`pageId`**, so a caller that omitted
  them got the literal string `"undefined"` sent to the service instead of a validation error.
  Fixed alongside a new `browser_snapshot` MCP tool (TD-BROWSER-8's snapshot half had a server
  route and service method but no SDK or MCP path — unreachable from any real client until now).
  The same `"undefined"` coercion on `browser_close`, `browser_cookies`, and `browser_create`'s
  `tenantId` is fixed too, and `browser_plan` no longer reports `ok` for a missing/non-array
  `actions` argument (it was an empty plan with zero steps).
- **Verified mode has teeth** — and its remap works past the first stale step. `verified` mode
  (raised after repeated ref churn) now requires a role+label match before accepting a remapped
  ref (previously it changed nothing behaviorally and could silently rebind an action to the wrong
  element on a reordering page), matching on the redacted form so labels embedding secrets still
  match their own element, reading the pre-failure baseline from the mint-time revision history
  (the self-heal's own re-observe used to invalidate it, killing remap for every stale step after
  the first), reporting a gone element as the honest `PLAN_STEP_FAILED` instead of a misleading
  `AMBIGUOUS_REMAP`, and surfacing a remap-retry failure as the plan envelope instead of a thrown
  error. A leftover debug `console.log` in the same path is removed.
- **Memory/reclamation fixes**: `RingBuffer.clear()` (used by `clearLogs`) now releases item
  references instead of only resetting cursors; per-session teardown is deduplicated into one
  helper, fixing shipped drift where a crashed session's event listeners survived
  `recoverFromCrash` while the sibling paths dropped them.
- The snapshot payload type is declared once (`PageSnapshot` in the SDK) instead of hand-copied
  across three packages, and the release smoke test reports the real tool count instead of a
  hardcoded `9`.

## [1.7.0] — 2026-09-03

### Added

- **npm distribution** (ADR-014): the MCP server ships to npm as `@anvailabs/agentbrowser-mcp`
  via OIDC Trusted Publishing — no publish token exists anywhere. The bun-compiled GitHub-Release
  binaries remain for standalone/no-Node users; the server stays tarballs + Docker.
- **Headed de-fingerprinting + ADR-013**: headed sessions launch with automation fingerprints
  stripped (`--disable-blink-features=AutomationControlled`, no `--enable-automation`,
  `navigator.webdriver` scrubbed) and prefer real Google Chrome (`channel: 'chrome'`) when
  installed (`AGENTBROWSER_CHROME_PATH`). Doctrine: no arms race with CDP-fingerprinting walls —
  the cookie-seeding handoff is the prescribed route. The headless pool keeps stock defaults.
- **`--no-headless` on the CLI**: headed sessions were unreachable from the CLI (the `--headless`
  flag could only ever send `true`). The OpenAPI create-session schema now documents `headless`
  semantics and the `cookies` seeding field the runtime has accepted all along.

### Fixed

- **Both decision-record numbering collisions resolved** (ADR-011 ×2 → the contract ADR became
  ADR-012; TD-BROWSER-6 ×2 → the bounded-collections TD became TD-BROWSER-8), and the branch-flow
  rule that caused them (main merges must be followed by a main→develop back-sync) is now in
  CLAUDE.md. Stale "6-tool catalog" counts corrected to the enforced 9.
  ⚠️ **Corrected in [1.7.1](#171-2026-09-04) above**: this renumbering collided a second time.

## [1.6.1] — 2026-09-02

TD-BROWSER-7 Phase 1: per-session engine registry. See the `v1.6.1` GitHub Release.

## [1.6.0] — 2026-09-01

TD-BROWSER-6 (headed sessions + credential handoff). See the `v1.6.0` GitHub Release.

## [1.1.0] — earlier

MCP MVP through TD-BROWSER-5 (single-binary distribution). See the GitHub Releases for
`v1.1.0`–`v1.5.0`.
