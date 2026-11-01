import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const biome = join(root, 'node_modules/@biomejs/biome/bin/biome');
const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'));
function check(files, configuration = config) {
  const directory = mkdtempSync(join(tmpdir(), 'agentbrowser-lint-policy-'));
  try {
    writeFileSync(join(directory, 'biome.json'), JSON.stringify(configuration));
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'lint-policy-fixture', type: 'module', dependencies: {} })
    );
    for (const [name, source] of Object.entries(files))
      writeFileSync(join(directory, name), source);
    const result = spawnSync(
      process.execPath,
      [
        biome,
        'lint',
        '--config-path',
        directory,
        '--vcs-enabled=false',
        '--reporter=json',
        '--error-on-warnings',
        '--max-diagnostics=none',
        ...Object.keys(files).map((name) => join(directory, name)),
      ],
      { cwd: directory, encoding: 'utf8', timeout: 30000 }
    );
    assert.ifError(result.error);
    assert.notEqual(result.signal, 'SIGTERM', 'lint fixture must settle within its deadline');
    return { status: result.status, report: JSON.parse(result.stdout) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const cases = [
  ['correctness/noUnusedVariables', { 'unused.ts': 'export {}; const unused = 1;' }],
  ['correctness/noUnusedImports', { 'unused.ts': "import { join } from 'node:path'; export {};" }],
  [
    'correctness/noUnusedFunctionParameters',
    { 'unused.ts': 'export function value(unused: number) { return 1; }' },
  ],
  [
    'correctness/noUnusedPrivateClassMembers',
    { 'unused.ts': 'export class Value { private unused = 1; public read() { return 2; } }' },
  ],
  [
    'correctness/noUndeclaredDependencies',
    { 'dependency.ts': "export { value } from 'undeclared-lint-fixture-dependency';" },
  ],
  ['suspicious/noUnusedExpressions', { 'expression.ts': 'export {}; 42;' }],
  ['security/noGlobalEval', { 'evaluate.ts': "export const value = eval('1');" }],
  [
    'suspicious/noImportCycles',
    {
      'first.ts':
        "import { second } from './second.js'; export function first() { return second; }",
      'second.ts': "import { first } from './first.js'; export function second() { return first; }",
    },
  ],
];
for (const [rule, files] of cases) {
  test(`lint rejects ${rule} as an error`, () => {
    const { status, report } = check(files);
    assert.equal(status, 1, JSON.stringify(report));
    assert.ok(
      report.diagnostics.some(
        (diagnostic) => diagnostic.category === `lint/${rule}` && diagnostic.severity === 'error'
      ),
      JSON.stringify(report)
    );
  });
}
for (const [rule, files] of cases.slice(0, 4)) {
  test(`lint enforces ${rule} in test files too`, () => {
    const testFiles = Object.fromEntries(
      Object.entries(files).map(([name, source]) => [name.replace('.ts', '.test.ts'), source])
    );
    const { status, report } = check(testFiles);
    assert.equal(status, 1, JSON.stringify(report));
    assert.ok(
      report.diagnostics.some(
        (diagnostic) => diagnostic.category === `lint/${rule}` && diagnostic.severity === 'error'
      ),
      JSON.stringify(report)
    );
  });
}
test('lint accepts used values, parameters, imports and private members', () => {
  const { status, report } = check({
    'clean.ts':
      "import { basename } from 'node:path'; export class Name { private prefix = 'file:'; public label(path: string) { return this.prefix + basename(path); } }",
  });
  assert.equal(status, 0, JSON.stringify(report));
  assert.equal(report.summary.errors, 0);
});
test('recommended-preset diagnostics remain blocking', () => {
  const { status, report } = check({ 'recommended.ts': 'export {}; debugger;' });
  assert.equal(status, 1, JSON.stringify(report));
  assert.ok(
    report.diagnostics.some((diagnostic) => diagnostic.category === 'lint/suspicious/noDebugger'),
    JSON.stringify(report)
  );
});
test('disabled-rule failure control is distinguishable from enforcement', () => {
  const disabled = structuredClone(config);
  disabled.linter.rules.correctness.noUnusedVariables = 'off';
  const { status, report } = check({ 'unused.ts': 'export {}; const unused = 1;' }, disabled);
  assert.equal(status, 0, JSON.stringify(report));
  assert.ok(!report.diagnostics.some((d) => d.category === 'lint/correctness/noUnusedVariables'));
});
