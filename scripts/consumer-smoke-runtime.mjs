import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolvePackagedModules } from './package-acceptance.mjs';
import { checkCli } from './release-smoke.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidateMessage =
  'Packaged candidate mode requires --server-root, --expected-version, --expected-commit, --cli and --mcp';

/** Load one smoke from either the source checkout or an exact extracted candidate. */
export async function loadConsumerSmokeRuntime(featureOptions = {}) {
  const { values } = parseArgs({
    options: {
      ...featureOptions,
      'server-root': { type: 'string' },
      'expected-version': { type: 'string' },
      'expected-commit': { type: 'string' },
      cli: { type: 'string' },
      mcp: { type: 'string' },
      'allow-dirty': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const candidateFields = [
    values['server-root'],
    values['expected-version'],
    values['expected-commit'],
    values.cli,
    values.mcp,
  ];
  const packaged = candidateFields.some((value) => value !== undefined);
  if (packaged && candidateFields.some((value) => value === undefined)) {
    throw new Error(candidateMessage);
  }
  if (!packaged && values['allow-dirty']) {
    throw new Error('--allow-dirty requires packaged candidate mode');
  }

  let paths;
  let version;
  let packageCommit;
  let dirty;
  let cliCommand;
  let mcpCommand;
  if (packaged) {
    const modules = await resolvePackagedModules(
      resolve(values['server-root']),
      values['expected-version'],
      {
        expectedCommit: values['expected-commit'],
        allowDirty: values['allow-dirty'],
      }
    );
    assert.ok(modules.protocol, 'Packaged candidate omitted its protocol dependency');
    paths = modules;
    version = values['expected-version'];
    packageCommit = modules.commit;
    dirty = modules.dirty;
    cliCommand = [resolve(values.cli)];
    mcpCommand = [resolve(values.mcp)];
  } else {
    const require = createRequire(
      new URL('../packages/engine-playwright/package.json', import.meta.url)
    );
    paths = {
      api: fileURLToPath(new URL('../packages/api/dist/index.js', import.meta.url)),
      engine: fileURLToPath(
        new URL('../packages/engine-playwright/dist/index.js', import.meta.url)
      ),
      policy: fileURLToPath(new URL('../packages/policy/dist/index.js', import.meta.url)),
      protocol: fileURLToPath(new URL('../packages/protocol/dist/index.js', import.meta.url)),
      playwright: require.resolve('playwright'),
    };
    version = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
    dirty =
      execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=normal'], {
        encoding: 'utf8',
      }).trim().length > 0;
    cliCommand = [process.execPath, join(root, 'packages/cli/dist/bin.js')];
    mcpCommand = [process.execPath, join(root, 'packages/mcp-server/dist/bin.js')];
  }

  const [api, engine, policy, protocol, sdk, playwrightModule] = await Promise.all([
    import(pathToFileURL(paths.api)),
    import(pathToFileURL(paths.engine)),
    import(pathToFileURL(paths.policy)),
    import(pathToFileURL(paths.protocol)),
    import('../packages/sdk-typescript/dist/index.js'),
    import(pathToFileURL(paths.playwright)),
  ]);
  if (packaged) await checkCli(cliCommand, { expectedVersion: version });
  return {
    values,
    root,
    version,
    buildServer: api.buildServer,
    PlaywrightChromiumEngine: engine.PlaywrightChromiumEngine,
    NetworkPolicy: policy.NetworkPolicy,
    protocol,
    sdk,
    playwright: playwrightModule.default ?? playwrightModule,
    cliCommand,
    mcpCommand,
    provenance: Object.freeze({
      candidateSource: packaged ? 'extracted_package' : 'workspace',
      ...(packageCommit ? { packageCommit } : {}),
      dirty,
      releaseEvidence: packaged && !dirty,
    }),
  };
}
