/** Application-owned Node test using an installed CLI and a preconfigured service. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cleanupRecipeFiles, publishRecipeArtifacts, readPrivateRecipeBytes } from './report-artifacts.mjs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const APPLICATION_RECIPE_FAILURE = 'Application outcome recipe failed.';

const BYTE_LIMIT = 64 * 1024;
const CLI_TIMEOUT_MS = 20_000;
const HTTP_TIMEOUT_MS = 5_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CASE_RESOURCES = Object.freeze({
  pass: 'recipe-pass',
  broken: 'recipe-broken',
  'cleanup-failure': 'recipe-cleanup-failure',
});
const RUNTIME_ENV = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);

export function applicationRecipeTestName(name) {
  if (!Object.hasOwn(CASE_RESOURCES, name)) fail();
  return `application outcome: ${name}`;
}

function fail(message = APPLICATION_RECIPE_FAILURE) {
  throw new Error(message);
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function parseUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      fail();
    return url;
  } catch {
    return fail();
  }
}

function parseConfig(value) {
  if (
    !exactKeys(value, [
      'caseName',
      'serviceBaseUrl',
      'cli',
      'application',
      'expectedVersion',
      'reportPath',
    ]) ||
    !Object.hasOwn(CASE_RESOURCES, value.caseName) ||
    !Array.isArray(value.cli) ||
    value.cli.length < 1 ||
    value.cli.length > 4 ||
    !value.cli.every(
      (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 4096
    ) ||
    typeof value.expectedVersion !== 'string' ||
    !IDENTIFIER.test(value.expectedVersion) ||
    typeof value.reportPath !== 'string' ||
    !isAbsolute(value.reportPath) ||
    value.reportPath.length > 4096 ||
    !exactKeys(value.application, ['adapter', 'resource', 'url', 'fixture', 'verifier']) ||
    value.application.adapter !== 'fixture-counter' ||
    value.application.resource !== CASE_RESOURCES[value.caseName] ||
    !exactKeys(value.application.fixture, ['id', 'version']) ||
    value.application.fixture.id !== 'fixture-counter' ||
    value.application.fixture.version !== '1' ||
    !exactKeys(value.application.verifier, ['id', 'version']) ||
    value.application.verifier.id !== 'fixture.ui-commit' ||
    value.application.verifier.version !== '1'
  )
    fail();
  parseUrl(value.serviceBaseUrl);
  parseUrl(value.application.url);
  return value;
}

export function counterAssertion(context) {
  if (
    !exactKeys(context, ['sessionId', 'pageId', 'targetRef', 'command', 'businessCorrelationId']) ||
    typeof context.sessionId !== 'string' ||
    !context.sessionId ||
    typeof context.pageId !== 'string' ||
    !context.pageId ||
    typeof context.targetRef !== 'string' ||
    !context.targetRef ||
    !plainRecord(context.command) ||
    !exactKeys(context.command, ['operationId', 'expectedVersion', 'amount']) ||
    !Number.isSafeInteger(context.command.expectedVersion) ||
    context.command.expectedVersion < 0 ||
    !Number.isSafeInteger(context.command.amount) ||
    context.command.amount < 1 ||
    context.businessCorrelationId !== context.command.operationId ||
    !OPERATION_ID.test(context.businessCorrelationId)
  )
    fail();
  return Object.freeze({
    actions: Object.freeze([
      Object.freeze({ action: 'click', target: Object.freeze({ ref: context.targetRef }) }),
    ]),
    verification: Object.freeze({
      verifier: Object.freeze({ id: 'fixture.ui-commit', version: '1' }),
      input: Object.freeze({ ...context.command }),
      evidenceCorrelationId: context.businessCorrelationId,
    }),
  });
}

export function counterDescriptor(expectedVersion) {
  if (typeof expectedVersion !== 'string' || !IDENTIFIER.test(expectedVersion)) fail();
  return Object.freeze({
    id: 'counter.ui-add',
    version: '1',
    testedSeam: 'ui',
    environment: Object.freeze({
      productVersion: expectedVersion,
      cliVersion: expectedVersion,
      engine: Object.freeze({ name: 'playwright-chromium', version: '1.0.0' }),
      fixture: Object.freeze({ id: 'fixture-counter', version: '1' }),
    }),
    assertions: Object.freeze([Object.freeze({ id: 'save', required: true })]),
  });
}

export function createCliEnvironment(env, token) {
  if (!plainRecord(env) || (token !== undefined && (typeof token !== 'string' || !token))) fail();
  const isolated = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => RUNTIME_ENV.has(name.toUpperCase()) && typeof value === 'string'
    )
  );
  if (token !== undefined) isolated.AGENTBROWSER_API_KEY = token;
  return isolated;
}

/**
 * Shared bounded CLI process owner for application recipes.
 * @param {string[]} cli
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, token?: string, input?: string, timeoutMs?: number, maxOutputBytes?: number, signal?: AbortSignal}} options
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function callInstalledCli(
  cli,
  args,
  { env, token, input, timeoutMs = CLI_TIMEOUT_MS, maxOutputBytes = BYTE_LIMIT, signal } = {}
) {
  if (
    !Array.isArray(cli) ||
    cli.length < 1 ||
    cli.length > 4 ||
    !cli.every((entry) => typeof entry === 'string' && entry.length > 0) ||
    !Array.isArray(args) ||
    !args.every((entry) => typeof entry === 'string') ||
    (input !== undefined && typeof input !== 'string') ||
    Buffer.byteLength(input ?? '') > BYTE_LIMIT ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    (signal !== undefined && !(signal instanceof AbortSignal)) ||
    signal?.aborted
  )
    fail();
  const child = spawn(cli[0], [...cli.slice(1), ...args], {
    env: createCliEnvironment(env ?? {}, token),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let failed = false;
  let closed = false;
  let escalation;
  const terminate = () => {
    if (failed) return;
    failed = true;
    if (!closed) {
      child.kill('SIGTERM');
      escalation = setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, 200);
      escalation.unref?.();
    }
  };
  const collect = (name, chunk) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > maxOutputBytes) return terminate();
    if (name === 'stdout') stdout += chunk;
    else stderr += chunk;
  };
  child.stdout.on('data', (chunk) => collect('stdout', chunk));
  child.stderr.on('data', (chunk) => collect('stderr', chunk));
  child.stdout.once('error', terminate);
  child.stderr.once('error', terminate);
  child.once('error', terminate);
  child.stdin.once('error', terminate);
  const onAbort = () => terminate();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) terminate();
  const timeout = setTimeout(terminate, timeoutMs);
  timeout.unref?.();
  try {
    if (Buffer.byteLength(input ?? '') === 0) child.stdin.end();
    else child.stdin.end(input);
  } catch {
    terminate();
  }
  const result = await new Promise((resolvePromise) => {
    child.once('close', (code, exitSignal) => {
      closed = true;
      resolvePromise({ code, signal: exitSignal });
    });
  });
  clearTimeout(timeout);
  clearTimeout(escalation);
  signal?.removeEventListener('abort', onAbort);
  if (failed || result.signal || stderr !== '') fail('Installed CLI invocation failed.');
  if (result.code === 0) return { stdout, stderr, code: 0 };
  if (result.code === 1 && stdout) {
    try {
      if (plainRecord(JSON.parse(stdout))) return { stdout, stderr, code: 1 };
    } catch {
      // Invalid failure output is not a canonical report.
    }
  }
  return fail('Installed CLI invocation failed.');
}

async function boundedResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BYTE_LIMIT) fail();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes
  ).toString('utf8');
}

export async function readJson(
  url,
  { operatorKey, method = 'GET', body, operationId, statuses = [200], signal } = {}
) {
  try {
    parseUrl(url);
    if (
      (operatorKey !== undefined && (typeof operatorKey !== 'string' || !operatorKey)) ||
      (operationId !== undefined && !OPERATION_ID.test(operationId)) ||
      !Array.isArray(statuses) ||
      statuses.length < 1 ||
      !statuses.every((status) => Number.isSafeInteger(status) && status >= 100 && status <= 599) ||
      (signal !== undefined && !(signal instanceof AbortSignal)) ||
      signal?.aborted
    )
      fail();
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && Buffer.byteLength(serialized) > BYTE_LIMIT) fail();
    const response = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        ...(operatorKey ? { Authorization: `Bearer ${operatorKey}` } : {}),
        ...(operationId ? { 'x-agentbrowser-operation-id': operationId } : {}),
        ...(serialized !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(serialized !== undefined ? { body: serialized } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)].filter(Boolean)),
    });
    const text = await boundedResponse(response);
    if (!statuses.includes(response.status)) fail();
    return { status: response.status, value: text ? JSON.parse(text) : undefined };
  } catch {
    return fail('HTTP request failed.');
  }
}

function jsonOutput(result, expectedCodes, label) {
  if (!expectedCodes.includes(result.code) || result.stderr !== '' || !result.stdout) fail(label);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fail(label);
  }
}

function sameEngine(left, right) {
  return left?.name === right?.name && left?.version === right?.version;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function executeCounterCase(rawConfig, { signal } = {}) {
  const config = parseConfig(rawConfig);
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail();
  const operatorKey = process.env.AGENTBROWSER_RECIPE_OPERATOR_KEY;
  if (typeof operatorKey !== 'string' || !operatorKey) fail();
  const serviceBaseUrl = new URL(config.serviceBaseUrl);
  const servicePath = serviceBaseUrl.pathname.replace(/\/$/u, '');
  const service = (path) => {
    const target = new URL(serviceBaseUrl);
    target.pathname = servicePath + path;
    target.search = '';
    return target.href;
  };
  const cli = (args, options = {}) =>
    callInstalledCli(config.cli, args, { env: process.env, signal, ...options });
  const operator = (path, options = {}) =>
    readJson(service(path), { operatorKey, signal, ...options });

  const descriptor = counterDescriptor(config.expectedVersion);
  const cliVersionResult = await cli(['--version']);
  if (cliVersionResult.code !== 0 || cliVersionResult.stderr !== '') fail();
  const cliVersion = cliVersionResult.stdout.trim();
  const outcomeDiscovery = jsonOutput(
    await cli(['--json', 'describe', 'outcome', '--schema']),
    [0],
    'CLI discovery failed.'
  );
  const evaluationDiscovery = jsonOutput(
    await cli(['--json', 'describe', 'test', 'evaluate', '--schema'], {
      maxOutputBytes: 128 * 1024,
    }),
    [0],
    'CLI discovery failed.'
  );
  if (
    cliVersion !== config.expectedVersion ||
    outcomeDiscovery.productVersion !== config.expectedVersion ||
    outcomeDiscovery.command?.schemas?.input?.$id !== 'urn:agentbrowser:outcome-run-request:v1' ||
    outcomeDiscovery.command?.schemas?.output?.$id !== 'urn:agentbrowser:outcome-run-report:v1' ||
    evaluationDiscovery.productVersion !== config.expectedVersion ||
    evaluationDiscovery.command?.schemas?.input?.$id !==
      'urn:agentbrowser:test-case-evaluation-input:v1' ||
    evaluationDiscovery.command?.schemas?.output?.$id !==
      'urn:agentbrowser:test-case-evaluation-report:v1'
  )
    fail();

  const health = (await operator('/health')).value;
  const ready = (await operator('/health/ready')).value;
  const readyEngine = ready && { name: ready.engine, version: ready.version };
  const before = (await readJson(new URL('/state', config.application.url).href, { signal })).value;
  if (
    health?.version !== config.expectedVersion ||
    !sameEngine(readyEngine, descriptor.environment.engine) ||
    !isDeepStrictEqual(before, { version: 0, total: 0 })
  )
    fail();

  let sessionId;
  let setup = 'failed';
  let cleanup = 'unknown';
  let assertion = { id: 'save', status: 'skipped', reasonCode: 'PRECONDITION_UNAVAILABLE' };
  let invocation;
  let after;
  let observedEngine;
  let workflowFailure;
  let sessionOpen = false;
  try {
    const session = (
      await operator('/v1/sessions', {
        method: 'POST',
        body: { controlMode: 'delegated' },
        statuses: [201],
      })
    ).value;
    if (typeof session?.sessionId !== 'string' || !session.sessionId) fail();
    sessionId = session.sessionId;
    sessionOpen = true;
    if (!sameEngine(session.engine, readyEngine)) fail();
    observedEngine = Object.freeze({ ...session.engine });
    const base = `/v1/sessions/${encodeURIComponent(sessionId)}`;
    const binding = (
      await operator(`${base}/application`, {
        method: 'PUT',
        body: { adapter: config.application.adapter, resource: config.application.resource },
      })
    ).value;
    if (
      binding?.adapter !== config.application.adapter ||
      binding?.resource !== config.application.resource
    )
      fail();
    const confirmed = (await operator(`${base}/application`)).value;
    if (
      confirmed?.adapter !== binding.adapter ||
      confirmed?.resource !== binding.resource ||
      !confirmed?.operations?.some(
        (operation) => operation.name === 'reserve' && operation.mode === 'read'
      )
    )
      fail();
    const reserved = (
      await operator(`${base}/application/execute`, {
        method: 'POST',
        body: { operation: 'reserve', input: {} },
      })
    ).value;
    const command = reserved?.value?.command;
    if (
      reserved?.status !== 'read' ||
      !exactKeys(command, ['operationId', 'expectedVersion', 'amount']) ||
      !OPERATION_ID.test(command.operationId) ||
      command.expectedVersion !== 0 ||
      command.amount !== 2
    )
      fail();
    const pageOperationId = `recipe-page-${randomUUID()}`;
    const page = (
      await operator(`${base}/pages`, {
        method: 'POST',
        body: {},
        operationId: pageOperationId,
        statuses: [201],
      })
    ).value;
    if (typeof page?.pageId !== 'string') fail();
    const pagePath = `${base}/pages/${encodeURIComponent(page.pageId)}`;
    await operator(`${pagePath}/navigate`, {
      method: 'POST',
      body: { url: config.application.url },
      operationId: `recipe-navigate-${randomUUID()}`,
    });
    let button;
    for (let attempt = 0; attempt < 40 && !button; attempt++) {
      const snapshot = (await operator(`${pagePath}/snapshot`)).value;
      const candidates = snapshot?.fields?.filter(
        (field) => field?.role === 'button' && field.label === 'Add' && field.disabled !== true
      );
      if (!Array.isArray(candidates) || candidates.length > 1) fail();
      button = candidates[0];
      if (!button) await sleep(50);
    }
    if (typeof button?.ref !== 'string') fail();
    const review = (await operator(`${base}/control/prepare-resume`, { method: 'POST' })).value;
    const grant = (
      await operator(`${base}/control/delegate`, {
        method: 'POST',
        body: { epoch: review?.epoch, mode: 'qa' },
      })
    ).value;
    if (grant?.mode !== 'qa' || typeof grant.token !== 'string' || !grant.token) fail();
    setup = 'completed';
    const outerOperationId = `recipe-outcome-${randomUUID()}`;
    if (outerOperationId === command.operationId) fail();
    const request = counterAssertion({
      sessionId,
      pageId: page.pageId,
      targetRef: button.ref,
      command,
      businessCorrelationId: command.operationId,
    });
    invocation = { id: 'save', operationId: outerOperationId, request };
    const outcomeResult = await cli(
      [
        '--base-url',
        config.serviceBaseUrl,
        '--json',
        '--operation-id',
        outerOperationId,
        'outcome',
        sessionId,
        page.pageId,
        '-',
      ],
      { token: grant.token, input: JSON.stringify(request) }
    );
    const outcome = jsonOutput(outcomeResult, [0, 1], 'CLI outcome failed.');
    if (
      outcomeResult.code !== (outcome.outcome?.verification?.status === 'passed' ? 0 : 1) ||
      outcome.outcome?.verification?.verifier?.id !== config.application.verifier.id ||
      outcome.outcome?.verification?.verifier?.version !== config.application.verifier.version
    )
      fail();
    assertion = { id: 'save', status: 'completed', operationId: outerOperationId, report: outcome };
    after = (await readJson(new URL('/state', config.application.url).href, { signal })).value;
  } catch (error) {
    workflowFailure = error;
  }

  const closeSession = async () => {
    if (!sessionOpen || !sessionId) return;
    const base = `/v1/sessions/${encodeURIComponent(sessionId)}`;
    await operator(base, { method: 'DELETE', statuses: [200, 404] });
    await operator(base, { statuses: [404] });
    await operator(`${base}/application`, { statuses: [404] });
    sessionOpen = false;
  };
  try {
    if (config.caseName === 'cleanup-failure') fail('Injected cleanup failure.');
    await closeSession();
    cleanup = 'complete';
  } catch {
    cleanup = 'failed';
  }
  try {
    await closeSession();
  } catch {
    fail('Application outcome fallback cleanup failed.');
  }
  if (workflowFailure) fail();

  const environment = {
    productVersion: health.version,
    cliVersion,
    engine: observedEngine,
    fixture: { ...config.application.fixture },
  };
  if (!isDeepStrictEqual(environment, descriptor.environment) || !invocation) fail();
  const report = {
    case: { id: descriptor.id, version: descriptor.version },
    environment,
    setup,
    assertions: [assertion],
    cleanup,
  };
  const bundle = { schemaVersion: 1, descriptor, invocations: [invocation], report };
  const serialized = JSON.stringify(bundle);
  if (Buffer.byteLength(serialized) > BYTE_LIMIT) fail();
  const evaluationResult = await cli(['--json', 'test', 'evaluate', '-'], {
    input: serialized,
    token: undefined,
  });
  const evaluation = jsonOutput(evaluationResult, [0, 1], 'CLI evaluation failed.');
  if (
    evaluationResult.code !== (evaluation.verdict === 'passed' ? 0 : 1) ||
    evaluation.schemaVersion !== 1 ||
    evaluation.provenance !== 'caller_observed' ||
    !isDeepStrictEqual(evaluation.descriptor, descriptor) ||
    !isDeepStrictEqual(evaluation.report, report)
  )
    fail();
  const expectedAfter =
    config.caseName === 'broken' ? { version: 0, total: 0 } : { version: 1, total: 2 };
  return {
    evaluation,
    oracleMatches:
      isDeepStrictEqual(before, { version: 0, total: 0 }) &&
      isDeepStrictEqual(after, expectedAfter),
    sessionId,
  };
}

export async function runCounterCase(rawConfig, options = {}) {
  try {
    return await executeCounterCase(rawConfig, options);
  } catch {
    return fail();
  }
}

async function readPrivateConfig(path) {
  try {
    if (typeof path !== 'string' || !isAbsolute(path)) fail();
    return parseConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readPrivateRecipeBytes(path))));
  } catch {
    return fail('Application outcome recipe configuration is invalid.');
  }
}

async function main() {
  let config;
  try {
    config = await readPrivateConfig(process.argv[2]);
  } catch {
    console.error('Application outcome recipe configuration is invalid.');
    process.exitCode = 1;
    return;
  }
  const { default: test } = await import('node:test');
  const { strict: assert } = await import('node:assert');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  test(applicationRecipeTestName(config.caseName), async (context) => {
    let artifact;
    try {
      const result = await runCounterCase(config, { signal: controller.signal });
      controller.signal.throwIfAborted();
      artifact = await publishRecipeArtifacts(config.reportPath, result, { signal: controller.signal });
      controller.signal.throwIfAborted();
      context.diagnostic(`Private evaluation artifact: sha256:${artifact.evaluation.sha256}`);
      assert.equal(result.evaluation.verdict, 'passed', 'Application outcome did not pass.');
      assert.equal(result.oracleMatches, true, 'Independent application outcome did not match.');
    } catch {
      if (controller.signal.aborted && artifact) {
        await cleanupRecipeFiles([`${config.reportPath}.manifest.json`, config.reportPath]);
      }
      throw new Error(APPLICATION_RECIPE_FAILURE);
    } finally {
      process.removeListener('SIGTERM', abort);
      process.removeListener('SIGINT', abort);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
