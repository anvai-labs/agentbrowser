// @ts-check
/** Private application workflow composition; requires the built workspace. */
import { isAbsolute } from 'node:path';
import {
  VERIFICATION_SNAPSHOT_LIMITS,
  snapshotJsonData,
} from '../../packages/protocol/dist/index.js';
import { callInstalledCli } from '../node-test/application-outcome.mjs';
import { readPrivateRecipeBytes } from '../node-test/report-artifacts.mjs';

/** @returns {never} */
function fail() {
  throw new Error('Listing review capture failed.');
}
const ensure = (condition) => {
  if (!condition) fail();
};
/** @param {unknown} value @param {string[]} required @param {string[]} optional
 * @returns {asserts value is Record<string, any>} */
function record(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  ensure(
    required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function parse(bytes) {
  return snapshotJsonData(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    VERIFICATION_SNAPSHOT_LIMITS
  );
}
function checkUrl(value, listing) {
  ensure(typeof value === 'string' && value.length <= 4096);
  const url = new URL(value);
  ensure(!url.username && !url.password && !value.includes('#'));
  ensure(
    listing
      ? url.protocol === 'https:' && url.href === value
      : ['http:', 'https:'].includes(url.protocol) && !value.includes('?')
  );
}

/**
 * Read one owner-selected existing page for private review. No browser writes,
 * eligibility evaluation, artifact publication or source authentication.
 * @param {string} configPath Owner-supplied private JSON file.
 * @param {{env?: NodeJS.ProcessEnv, token?: string, signal?: AbortSignal}} options
 */
export async function captureListingForReview(configPath, options = {}) {
  try {
    const { env = {}, token, signal } = options;
    signal?.throwIfAborted();
    const config = parse(await readPrivateRecipeBytes(configPath));
    record(config, ['schemaVersion', 'cli', 'serviceBaseUrl', 'sessionId', 'pageId', 'listingUrl']);
    ensure(config.schemaVersion === 1);
    ensure(
      Array.isArray(config.cli) &&
        config.cli.length >= 1 &&
        config.cli.length <= 4 &&
        config.cli.every(
          (arg) =>
            typeof arg === 'string' && arg.length > 0 && arg.length <= 4096 && !arg.includes('\0')
        )
    );
    ensure(isAbsolute(config.cli[0]));
    for (const id of [config.sessionId, config.pageId])
      ensure(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id));
    checkUrl(config.serviceBaseUrl, false);
    checkUrl(config.listingUrl, true);
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const result = await callInstalledCli(
      config.cli,
      [
        '--base-url',
        config.serviceBaseUrl,
        '--json',
        'extract',
        config.sessionId,
        config.pageId,
        '--format',
        'text',
      ],
      { env, token, signal }
    );
    signal?.throwIfAborted();
    ensure(result.code === 0);
    const output = parse(Buffer.from(result.stdout, 'utf8'));
    record(output, ['data', 'evidence'], ['warnings']);
    if (Object.hasOwn(output, 'warnings'))
      ensure(Array.isArray(output.warnings) && output.warnings.length === 0);
    record(output.data, ['text']);
    ensure(typeof output.data.text === 'string' && output.data.text.trim().length > 0);
    ensure(Array.isArray(output.evidence) && output.evidence.length === 1);
    const evidence = output.evidence[0];
    record(evidence, ['url', 'revision', 'hash'], ['text']);
    ensure(
      evidence.url === config.listingUrl &&
        Number.isSafeInteger(evidence.revision) &&
        evidence.revision >= 0
    );
    ensure(typeof evidence.hash === 'string' && /^[a-f0-9]{8}$/.test(evidence.hash));
    if (Object.hasOwn(evidence, 'text'))
      ensure(typeof evidence.text === 'string' && evidence.text.length <= 200);
    const completedAt = Date.now();
    ensure(
      Number.isSafeInteger(startedAt) &&
        startedAt >= 0 &&
        Number.isSafeInteger(completedAt) &&
        completedAt >= startedAt
    );
    signal?.throwIfAborted();
    return {
      schemaVersion: 1,
      status: 'captured_unreviewed',
      eligibility: 'not_evaluated',
      capture: {
        url: evidence.url,
        revision: evidence.revision,
        hash: evidence.hash,
        startedAt,
        completedAt,
      },
      text: output.data.text,
    };
  } catch {
    return fail();
  }
}
