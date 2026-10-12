// winget-manifests.test.mjs — the generated manifests must pass winget's
// semantic validation, which the JSON schema alone does not express: at most
// one installer per architecture/type/scope/locale (three bare portable exes
// in one package are rejected as duplicate installer entries).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHA = 'A'.repeat(64);

function generate() {
  const out = mkdtempSync(join(tmpdir(), 'winget-'));
  execFileSync(process.execPath, [
    'scripts/winget-manifests.mjs', '--version', '1.2.3', '--zip-sha256', SHA, '--out', out,
  ]);
  const read = (name) => readFileSync(join(out, name), 'utf8');
  return {
    version: read('AnvaiLabs.AgentBrowser.yaml'),
    installer: read('AnvaiLabs.AgentBrowser.installer.yaml'),
    locale: read('AnvaiLabs.AgentBrowser.locale.en-US.yaml'),
  };
}

test('one zip installer carries all three commands as nested portable files', () => {
  const { installer } = generate();
  const entries = installer.split('\n- Architecture:').length - 1;
  assert.equal(entries, 1, 'exactly one installer entry (no duplicate arch/type)');
  assert.match(installer, /InstallerType: zip\n\s+NestedInstallerType: portable/);
  for (const alias of ['agentbrowser-mcp', 'agentbrowser-cli', 'agentbrowser-server']) {
    assert.match(
      installer,
      new RegExp(`RelativeFilePath: ${alias}-windows-x64\\.exe\\n\\s+PortableCommandAlias: ${alias}\\n`)
    );
  }
  assert.match(installer, /InstallerUrl: https:\/\/github\.com\/anvai-labs\/agentbrowser\/releases\/download\/v1\.2\.3\/agentbrowser-windows-x64\.zip/);
  assert.match(installer, new RegExp(`InstallerSha256: ${SHA}`));
});

test('version manifest declares the default locale the schema requires', () => {
  const { version, locale } = generate();
  assert.match(version, /^DefaultLocale: en-US$/m);
  assert.match(locale, /^PackageLocale: en-US$/m);
});

test('refuses a malformed zip hash', () => {
  assert.throws(() =>
    execFileSync(process.execPath, ['scripts/winget-manifests.mjs', '--version', '1.2.3', '--zip-sha256', 'nothex'], { stdio: 'pipe' })
  );
});
