# ADR-023: Windows Server Ships as a Bundled-Node Zip, Not a Single-File Executable

**Status:** Accepted (2026-10-12)
**Related:** [ADR-001](001-typescript-playwright-mvp.md) (TypeScript + Playwright),
[ADR-014](014-npm-distribution.md) (distribution),
[TD-BROWSER-5](../td/TD-BROWSER-5-single-binary-mcp-distribution.md) (single-binary MCP)

## Context

The MCP adapter ships as a Bun single-file executable (TD-BROWSER-5), and the CLI later followed
the same pipeline. Their dependencies (commander, the fetch-only SDK) bundle cleanly. From
**v1.15.2 through v1.17.0**, the **browser service** shipped on Windows the same way, as
`agentbrowser-server-windows-x64.exe`. Every one of those executables embeds the frozen build path
and fails on every machine except CI:

```
error: Cannot find module 'D:\a\agentbrowser\agentbrowser\node_modules\.pnpm\playwright-core@1.62.1\node_modules\playwright-core\package.json'
```

- **`__dirname` is frozen at build time.** playwright-core reads its own `package.json` and
  `browsers.json` through `__dirname` at load time, and `bun build --compile` freezes
  `__dirname` to the build machine's path. Playwright also forks helper scripts
  (`oopBrowserDownload`), and the journal store forks a child script. Neither works inside a
  single-file binary.
- **CI never noticed:** the release smoke ran the exe *inside* the build checkout, where those
  frozen paths happened to exist.
- **The project had already decided against this.** TD-BROWSER-5's scope boundary states that
  "compiling the REST server + Playwright into the binary is explicitly rejected". ADR-014 §3 calls
  Playwright "bundler-hostile", and the macOS/Linux server packaging says its package tree "must
  ship intact". The Windows server executable contradicted those decisions; this ADR restores
  them.

Two further constraints shaped the fix:
- **Symlinks:** the macOS/Linux server tarballs use pnpm's symlinked layout, which Windows `tar`
  cannot extract without Developer Mode.
- **Lockfile:** pnpm 9's hoisted `deploy` ignores the lockfile.

## Decision

On Windows, the service ships inside **`agentbrowser-windows-x64.zip`**, assembled and
clean-room tested by the release pipeline:

| Path | Contents |
|---|---|
| `agentbrowser-server.exe` | A launcher: a Bun runtime carrying a few hundred lines of builtins-only code, no server code, and no location derived from `__dirname` |
| `agentbrowser-cli.exe`, `agentbrowser-mcp.exe` | The same bytes as the standalone release assets |
| `node\node.exe`, `node\LICENSE` | Official Node.js, pinned to `.tool-versions` by SHA-256 |
| `server\` | The lockfile-faithful isolated deploy, rewritten link-free (`scripts/materialize-hoisted.mjs`) |

**What the launcher does:**
- finds its bundle from the real executable path, which works through winget's Links symlink;
- refuses a mismatched server version;
- downloads Chromium on first start into `%LOCALAPPDATA%\agentbrowser\browsers`;
- supervises the server through a stdin lifeline, so killing the launcher never orphans the server
  or Chromium.

**winget installs the zip as one package**, with three nested portable commands. A single-file
server executable is not built for any platform.

## Consequences

**Gates added** (they run on every pull request in Windows CI, and again in the release):
- A **shipped-path scan** fails the build if any shipped file embeds a runner or checkout path,
  raw or JS-escaped, in UTF-8 or UTF-16LE. It fails on v1.17.0's exe.
- A **clean-room smoke** runs outside any checkout. It covers first start, a real Chromium
  session through the CLI and MCP executables, launcher-kill cleanup, and invocation through a
  symlink.

**Windows matches macOS and Linux.** The server runs the same lockfile-pinned package tree on a
pinned Node.

**Size:** the zip is about 160 MB, because it holds three Bun runtimes and `node.exe`. A
follow-up could run the CLI and MCP on the bundled Node to share one runtime.

**No Windows service registration:** the service runs in a terminal or under Task Scheduler.
Homebrew's `brew services` has no winget equivalent.

**Unsigned executables:** they may trigger SmartScreen. Authenticode signing is a follow-up.

## Alternatives considered

- **Fix the single-file exe** by embedding Playwright's metadata and patching its `__dirname`
  lookups. That is fragile against every Playwright release, and it still cannot fork helper
  scripts. Rejected.
- **Require a system Node.js.** It puts the runtime version outside our control and adds an
  install step. Rejected for a winget package that should just work.
- **Ship the POSIX tarball for Windows.** Its pnpm symlinks don't extract on Windows. Rejected.
- **Use pnpm's hoisted deploy.** It ignores the lockfile, and a Windows build drifted to newer,
  semver-major dependencies. Rejected in favour of materializing the isolated deploy.
