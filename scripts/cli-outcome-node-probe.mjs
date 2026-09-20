/** Intentional red reporter controls; not an automatically discovered customer test suite. */
import { readFile, writeFile } from 'node:fs/promises';
import test, { before } from 'node:test';
import {
  NODE_OUTCOME_CONTROLS, NODE_OUTCOME_FAILURE, validNodeOutcomeProjection,
} from './cli-outcome-node-acceptance.mjs';

let cases;
before(async () => {
  try {
    const bytes = await readFile(process.argv[2]);
    if (bytes.length > 64 * 1024) throw new Error();
    const config = JSON.parse(bytes.toString('utf8'));
    if (Object.keys(config).sort().join(',') !== 'cases,expectedVersion,resultPath' ||
        typeof config.expectedVersion !== 'string' || !config.expectedVersion ||
        typeof config.resultPath !== 'string' || !validNodeOutcomeProjection(config.cases))
      throw new Error();
    cases = config.cases;
    await writeFile(config.resultPath, JSON.stringify({
      schemaVersion: 1, productVersion: config.expectedVersion,
      runtime: process.version, cases,
    }), { flag: 'wx', mode: 0o600 });
  } catch { throw new Error('Node test probe setup failed'); }
});

for (const [index, { name }] of NODE_OUTCOME_CONTROLS.entries()) {
  test(name, () => {
    if (cases[index].passing !== true) throw new Error(NODE_OUTCOME_FAILURE);
  });
}
