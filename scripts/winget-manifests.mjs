#!/usr/bin/env node
// winget-manifests.mjs — generate winget-pkgs manifests for the combined
// AgentBrowser MCP server + CLI single-binary distribution (TD-BROWSER-5).
//
// Why one zip: winget allows a single installer per architecture/type/scope
// combination, so three bare portable exes in one package fail validation
// as duplicate installer entries. The release publishes
// agentbrowser-windows-x64.zip (scripts/assemble-windows-bundle.mjs: the three
// exes plus the bundled node\ runtime and server\ tree);
// the manifest declares it as `InstallerType: zip` with
// `NestedInstallerType: portable` and one NestedInstallerFiles entry per
// command, so a single `winget install AnvaiLabs.AgentBrowser` provisions
// `agentbrowser-mcp`, `agentbrowser-cli` and `agentbrowser-server` on PATH.
//
// IMPORTANT winget-pkgs requirement: InstallerUrl must be PUBLIC and
// immutable. The public release repo (anvai-labs/agentbrowser) is the asset
// host — never point manifests at the private anvaiops remote.
//
// Usage:
//   node scripts/winget-manifests.mjs --version 1.17.0 \
//     --zip-file agentbrowser-windows-x64.zip \
//     --out winget/            # optional, default: winget/
//   # or pass the precomputed hash instead of the local file:
//   node scripts/winget-manifests.mjs --version 1.17.0 --zip-sha256 <64hex>
//
// Output (winget-pkgs directory layout):
//   winget/AnvaiLabs.AgentBrowser.yaml            (version manifest)
//   winget/AnvaiLabs.AgentBrowser.installer.yaml  (one zip installer, three nested portable commands)
//   winget/AnvaiLabs.AgentBrowser.locale.en-US.yaml
// Copy these to manifests/a/AnvaiLabs/AgentBrowser/<version>/ in a
// winget-pkgs fork and open the PR. release.yml automates this when
// WINGET_FORK_TOKEN is configured.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { argv, exit } from 'node:process';

const DEFAULT_BASE = 'https://github.com/anvai-labs/agentbrowser/releases/download';
const MANIFEST_VERSION = '1.6.0';

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return argv[i + 1];
}
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase();
}

const version = arg('version');
const outDir = arg('out', 'winget');
const base = arg('base-url', DEFAULT_BASE).replace(/\/+$/, '');
const zipName = 'agentbrowser-windows-x64.zip';
// RelativeFilePath -> PortableCommandAlias: the file names inside the bundle
// built by scripts/assemble-windows-bundle.mjs (flat zip). winget extracts the
// whole zip into the package directory, so the server launcher finds its
// bundled node\ and server\ beside it.
const COMMANDS = [
  ['agentbrowser-mcp.exe', 'agentbrowser-mcp'],
  ['agentbrowser-cli.exe', 'agentbrowser-cli'],
  ['agentbrowser-server.exe', 'agentbrowser-server'],
];
const zipFile = arg('zip-file');
let zipSha = arg('zip-sha256');

if (!version) { console.error('--version is required'); exit(1); }
if (!zipSha) {
  if (!zipFile) { console.error('need --zip-file or --zip-sha256'); exit(1); }
  zipSha = sha256(zipFile);
}
if (!/^[0-9A-Fa-f]{64}$/.test(zipSha)) { console.error(`zip sha256 malformed: ${zipSha}`); exit(1); }
zipSha = zipSha.toUpperCase();

mkdirSync(outDir, { recursive: true });
const zipUrl = `${base}/v${version.replace(/^v/, '')}/${zipName}`;
const nestedFiles = COMMANDS.map(
  ([file, alias]) => `  - RelativeFilePath: ${file}\n    PortableCommandAlias: ${alias}\n`
).join('');

const yamls = {
  'AnvaiLabs.AgentBrowser.yaml':
`PackageIdentifier: AnvaiLabs.AgentBrowser
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${MANIFEST_VERSION}
`,
  'AnvaiLabs.AgentBrowser.installer.yaml':
`PackageIdentifier: AnvaiLabs.AgentBrowser
PackageVersion: ${version}
InstallerLocale: en-US
Platform:
- Windows.Desktop
MinimumOSVersion: 10.0.17763.0
Installers:
- Architecture: x64
  InstallerType: zip
  NestedInstallerType: portable
  NestedInstallerFiles:
${nestedFiles}  InstallerUrl: ${zipUrl}
  InstallerSha256: ${zipSha}
ManifestType: installer
ManifestVersion: ${MANIFEST_VERSION}
`,
  'AnvaiLabs.AgentBrowser.locale.en-US.yaml':
`PackageIdentifier: AnvaiLabs.AgentBrowser
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Anvai Labs
PublisherUrl: https://github.com/anvai-labs
PackageName: AgentBrowser
PackageUrl: https://github.com/anvai-labs/agentbrowser
License: Apache-2.0
LicenseUrl: https://github.com/anvai-labs/agentbrowser/blob/main/LICENSE
ShortDescription: Browser automation for AI agents - MCP server, CLI and browser service
Description: |-
  AgentBrowser drives a real Chromium browser for AI agents and test
  automation. This package installs the Model Context Protocol server
  (agentbrowser-mcp), the command-line client (agentbrowser-cli) and the
  browser service (agentbrowser-server). The service runs on its own
  bundled Node.js runtime; on first start it downloads the Chromium build it
  needs (roughly 300 MB) into %LOCALAPPDATA%\\agentbrowser\\browsers.
Moniker: agentbrowser
Tags:
- mcp
- browser
- automation
- ai
- playwright
- cli
ReleaseNotesUrl: https://github.com/anvai-labs/agentbrowser/releases/tag/v${version.replace(/^v/, '')}
ManifestType: defaultLocale
ManifestVersion: ${MANIFEST_VERSION}
`,
};

for (const [name, body] of Object.entries(yamls)) {
  writeFileSync(`${outDir}/${name}`, body);
  console.log(`wrote ${outDir}/${name}`);
}
console.log(`
Next steps:
  1) Verify the URL resolves (public repo): ${zipUrl}
  2) Copy the three files to a winget-pkgs fork at
     manifests/a/AnvaiLabs/AgentBrowser/${version}/
     (release.yml does this automatically when WINGET_FORK_TOKEN is set)
  3) Users then install with:
     winget install AnvaiLabs.AgentBrowser
`);
