import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = resolve(root, 'packages/sdk-typescript/src/client.ts');

// Compile the real callers against an in-memory SDK mutation. No checked-in or
// built files are changed, and a clean checkout needs no generated dist files.
function diagnostics(mutate = (source) => source) {
  const configPath = resolve(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options = {
    ...parsed.options, noEmit: true, rootDir: root, baseUrl: root,
    paths: {
      '@agentbrowser/sdk-typescript': ['packages/sdk-typescript/src/index.ts'],
      '@agentbrowser/protocol': ['packages/protocol/src/index.ts'],
    },
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  let mutated = false;
  host.readFile = (path) => {
    const source = read(path);
    if (resolve(path) !== sdk || source === undefined) return source;
    mutated = true;
    return mutate(source);
  };
  const program = ts.createProgram(['cli/src/contracts.ts', 'mcp-server/src/contracts.ts']
    .map((path) => resolve(root, 'packages', path)), options, host);
  const result = ts.getPreEmitDiagnostics(program);
  assert.ok(mutated, 'fault probe must read the actual SDK source');
  return result;
}

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, `fault must match once: ${before}`);
  return source.replace(before, after);
}

function assertCallerFailure(errors, caller, code) {
  assert.ok(errors.some((error) => error.code === code &&
    error.file && resolve(error.file.fileName) === resolve(root, 'packages', caller)),
  `${caller} must reject fault with TS${code}; got ${errors.map((e) =>
    `${e.file?.fileName}: TS${e.code} ${ts.flattenDiagnosticMessageText(e.messageText, ' ')}`).join('\n')}`);
}

test('real SDK and both production callers compile without a mutation', () => {
  const errors = diagnostics();
  assert.deepEqual(errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')), []);
});

test('renaming optional SDK methods breaks the consumers rather than silently dropping them', () => {
  for (const [method, callers] of [
    ['applicationDiscover', ['cli/src/cli.ts']],
    ['operation', ['cli/src/cli.ts', 'mcp-server/src/mcp-server.ts']],
  ]) {
    const errors = diagnostics((source) => replaceOnce(source,
      `async ${method}(`, `async removed_${method}(`));
    for (const caller of callers) assertCallerFailure(errors, caller, 2344);
  }
});

test('narrowing SDK input fails at the actual CLI and MCP call sites', () => {
  const errors = diagnostics((source) => replaceOnce(source,
    'async create(request: SessionRequest)',
    'async create(request: SessionRequest & { newlyRequired: string })'));
  for (const caller of ['cli/src/cli.ts', 'mcp-server/src/mcp-server.ts'])
    assertCallerFailure(errors, caller, 2379);
});
