#!/usr/bin/env node
// winget-manifests.mjs — generate winget-pkgs manifests for the combined
// AgentBrowser MCP server + CLI single-binary distribution (TD-BROWSER-5).
//
// Why portable installers: the release already publishes two bare exes
// (agentbrowser-mcp-windows-x64.exe / agentbrowser-cli-windows-x64.exe).
// winget's `portable` installer type ingests exactly that — no MSI wrapping
// needed — and one package can carry multiple PortableCommandAlias entries,
// so a single `winget install AnvaiLabs.AgentBrowser` provisions BOTH
// `agentbrowser-mcp` and `agentbrowser-cli` commands on PATH.
//
// IMPORTANT winget-pkgs requirement: InstallerUrl must be PUBLIC and
// immutable. The public release repo (anvai-labs/agentbrowser) is the asset
// host — never point manifests at the private anvaiops remote.
//
// Usage:
//   node scripts/winget-manifests.mjs --version 1.15.1 \
//     --mcp-file agentbrowser-mcp-windows-x64.exe \
//     --cli-file agentbrowser-cli-windows-x64.exe \
//     --out winget/            # optional, default: winget/
//   # or pass precomputed hashes instead of local files:
//   node scripts/winget-manifests.mjs --version 1.15.1 \
//     --mcp-sha256 <64hex> --cli-sha256 <64hex>
//
// Output (winget-pkgs directory layout):
//   winget/AnvaiLabs.AgentBrowser.yaml            (version manifest)
//   winget/AnvaiLabs.AgentBrowser.installer.yaml  (2x portable installers)
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
const mcpName = 'agentbrowser-mcp-windows-x64.exe';
const cliName = 'agentbrowser-cli-windows-x64.exe';
const mcpFile = arg('mcp-file');
const cliFile = arg('cli-file');
let mcpSha = arg('mcp-sha256');
let cliSha = arg('cli-sha256');

if (!version) { console.error('--version is required'); exit(1); }
if (!mcpSha) {
  if (!mcpFile) { console.error('need --mcp-file or --mcp-sha256'); exit(1); }
  mcpSha = sha256(mcpFile);
}
if (!cliSha) {
  if (!cliFile) { console.error('need --cli-file or --cli-sha256'); exit(1); }
  cliSha = sha256(cliFile);
}
for (const [label, h] of [['mcp', mcpSha], ['cli', cliSha]]) {
  if (!/^[0-9A-Fa-f]{64}$/.test(h)) { console.error(`${label} sha256 malformed: ${h}`); exit(1); }
}

mkdirSync(outDir, { recursive: true });
const mcpUrl = `${base}/v${version.replace(/^v/, '')}/${mcpName}`;
const cliUrl = `${base}/v${version.replace(/^v/, '')}/${cliName}`;

const yamls = {
  'AnvaiLabs.AgentBrowser.yaml':
`PackageIdentifier: AnvaiLabs.AgentBrowser
PackageVersion: ${version}
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
  InstallerType: portable
  InstallerUrl: ${mcpUrl}
  InstallerSha256: ${mcpSha}
  PortableCommandAlias: agentbrowser-mcp
- Architecture: x64
  InstallerType: portable
  InstallerUrl: ${cliUrl}
  InstallerSha256: ${cliSha}
  PortableCommandAlias: agentbrowser-cli
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
ShortDescription: Browser automation for AI agents - MCP server and CLI (single-binary)
Description: |-
  AgentBrowser drives a real Chromium/Chrome browser for AI agents and test
  automation. This package installs both the Model Context Protocol server
  (agentbrowser-mcp) and the command-line client (agentbrowser-cli) as
  standalone executables. System Chrome is auto-detected; no Node.js
  runtime is required.
Moniker: agentbrowser
Tags:
- mcp
- browser
- automation
- ai
- playwright
- cli
ReleaseNotesUrl: ${base}/v${version.replace(/^v/, '')}
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
  1) Verify URLs resolve (public repo): ${mcpUrl}
  2) Copy the three files to a winget-pkgs fork at
     manifests/a/AnvaiLabs/AgentBrowser/${version}/
     (release.yml does this automatically when WINGET_FORK_TOKEN is set)
  3) Users then install with:
     winget install AnvaiLabs.AgentBrowser
`);
