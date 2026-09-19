/**
 * TDD Tests for the AgentBrowser CLI
 *
 * The CLI is built as a factory over injected dependencies so the command
 * surface can be exercised without spawning a process or hitting a server.
 */

import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCli } from './cli';
import type { CliDependencies } from './cli';
import { PRODUCT_VERSION } from './product-version.js';

describe('AgentBrowser CLI', () => {
  let out: string[];
  let err: string[];
  let sessions: Record<string, ReturnType<typeof vi.fn>>;
  let deps: CliDependencies;

  /** Run the CLI with user-style argv and return the exit code. */
  const run = (...argv: string[]) => buildCli(deps).run(argv);

  const lastJson = () => JSON.parse(out.join('\n'));

  it('reports the product version without constructing a service client', async () => {
    expect(await run('--version')).toBe(0);
    expect(out).toEqual([PRODUCT_VERSION]);
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  describe('offline command discovery', () => {
    it('lists only the immediate command surface without contacting a service', async () => {
      expect(await run('describe')).toBe(0);
      const catalog = lastJson();
      expect(catalog).toMatchObject({
        schemaVersion: 1,
        productVersion: PRODUCT_VERSION,
        scope: 'cli-command-definitions',
        command: { path: [], arguments: [] },
      });
      expect(catalog.command.commands.map((command: { name: string }) => command.name)).toEqual(
        expect.arrayContaining(['session', 'page', 'snapshot', 'plan', 'act', 'describe'])
      );
      expect(catalog.command.commands.every((command: object) => !('options' in command))).toBe(
        true
      );
      expect(err).toEqual([]);
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('describes nested arguments and options without executing the selected command', async () => {
      expect(await run('describe', 'act', 'press')).toBe(0);
      const catalog = lastJson();
      expect(catalog.command.path).toEqual(['act', 'press']);
      expect(catalog.command.arguments).toEqual([
        expect.objectContaining({ name: 'sessionId', required: true, variadic: false }),
        expect.objectContaining({ name: 'pageId', required: true, variadic: false }),
        expect.objectContaining({ name: 'key', required: true, variadic: false }),
      ]);
      expect(catalog.command.options).toContainEqual(
        expect.objectContaining({ flags: '--count <n>', required: false, valueRequired: true })
      );
      expect(catalog.globalOptions).toContainEqual(
        expect.objectContaining({ flags: '--operation-id <id>' })
      );
      expect(catalog.guidance.join(' ')).toContain('reconcile');
      expect(catalog.guidance.join(' ')).toContain('exit code');
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('preserves mandatory and negated option metadata from command registration', async () => {
      expect(await run('describe', 'session', 'create')).toBe(0);
      expect(lastJson().command.options).toContainEqual(
        expect.objectContaining({ flags: '--tenant <id>', required: true, valueRequired: true })
      );
      expect(lastJson().command.options).toContainEqual(
        expect.objectContaining({ flags: '--no-headless', negated: true })
      );
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('preserves optional variadic argument metadata', async () => {
      expect(await run('describe', 'act', 'upload')).toBe(0);
      expect(lastJson().command.arguments).toContainEqual(
        expect.objectContaining({ name: 'paths', required: false, variadic: true })
      );
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('never reflects credentials or current option values into discovery', async () => {
      const secret = 'private-api-key-not-metadata';
      expect(await run('--json', '--api-key', secret, 'describe', 'session', 'create')).toBe(0);
      expect(out.join('\n')).not.toContain(secret);
      expect(err).toEqual([]);
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('rejects unknown paths with no partial catalog or service call', async () => {
      expect(await run('describe', 'act', 'not-a-command')).toBe(1);
      expect(out).toEqual([]);
      expect(err.join('\n')).toContain('Unknown command path');
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('projects canonical schemas for the application execute JSON-input command', async () => {
      expect(await run('describe', 'application', 'execute', '--schema')).toBe(0);
      const schemas = lastJson().command.schemas;
      expect(schemas).not.toBeNull();
      // The input schema is the protocol's execute request: operation plus
      // input, optional write identities, additional properties refused.
      expect(schemas.input).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['operation', 'input'],
        properties: {
          operation: { type: 'string' },
          input: {},
          operationId: { type: 'string' },
          expectedVersion: { type: 'integer' },
        },
      });
      // The output schema is the operation-result union: admitted result,
      // rejection, or a replay carrying the recorded operation record.
      expect(Array.isArray(schemas.output.anyOf)).toBe(true);
      const replay = schemas.output.anyOf.find(
        (variant: { properties?: { replay?: unknown } }) => variant.properties?.replay
      );
      expect(replay.properties.operation).toMatchObject({ type: 'object' });
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('keeps schema projection null for application commands without qualified contracts', async () => {
      for (const leaf of ['bind', 'unbind', 'discover', 'receipt']) {
        out = [];
        expect(await run('describe', 'application', leaf, '--schema')).toBe(0);
        expect(lastJson().command.schemas).toBeNull();
      }
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('resolves advertised commands, including implicit help, with useful descriptions', async () => {
      const paths: string[][] = [[]];
      while (paths.length > 0) {
        const path = paths.shift() as string[];
        out = [];
        expect(await run('describe', ...path)).toBe(0);
        const { command } = lastJson();
        expect(command.description.length).toBeGreaterThan(0);
        for (const child of command.commands) paths.push([...path, child.name]);
      }
      expect(deps.createClient).not.toHaveBeenCalled();
    });
  });

  beforeEach(() => {
    out = [];
    err = [];

    sessions = {
      get: vi.fn().mockResolvedValue({
        sessionId: 'ses_1',
        createdAt: '2026-08-23T10:00:00Z',
        ttlMs: 12600000,
        idleTimeoutMs: 600000,
      }),
      listPages: vi
        .fn()
        .mockResolvedValue([{ pageId: 'pg_1', status: 'active', url: 'https://example.com/' }]),
      getPage: vi.fn().mockResolvedValue({
        pageId: 'pg_1',
        status: 'active',
        url: 'https://example.com/',
        title: 'Example',
      }),
      closePage: vi.fn().mockResolvedValue(undefined),
      pdf: vi.fn().mockResolvedValue({
        artifactId: 'pdf_1',
        type: 'pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        url: '/v1/artifacts/pdf_1',
        contentBase64: 'JVBERi0=',
      }),
      download: vi.fn().mockResolvedValue({
        artifactId: 'dl_1',
        type: 'download',
        contentType: 'application/octet-stream',
        sizeBytes: 64,
        url: '/v1/artifacts/dl_1',
        contentBase64: 'AA==',
      }),
      collectDownload: vi.fn().mockResolvedValue({
        artifactId: 'dl_1',
        type: 'download',
        contentType: 'application/octet-stream',
        sizeBytes: 64,
        url: '/v1/artifacts/dl_1',
        contentBase64: 'AA==',
      }),
      autofill: vi
        .fn()
        .mockImplementation(
          async (
            _sessionId: string,
            _pageId: string,
            request: { fields: Array<{ match: Record<string, unknown> }> }
          ) => ({
            ok: true,
            receipts: request.fields.map((field, index) => ({
              field: index,
              match: field.match,
              status: 'verified',
              verified: true,
              resolvedRef: `e1_${index + 2}`,
            })),
            elapsedMs: 1234,
            snapshot: { artifactId: 'art_9' },
          })
        ),
      create: vi.fn().mockResolvedValue({
        sessionId: 'ses_1',
        status: 'ready',
        createdAt: '2026-08-23T10:00:00Z',
      }),
      list: vi.fn().mockResolvedValue([
        { sessionId: 'ses_1', status: 'ready', createdAt: '2026-08-23T10:00:00Z' },
        { sessionId: 'ses_2', status: 'active', createdAt: '2026-08-23T10:05:00Z' },
      ]),
      close: vi.fn().mockResolvedValue(undefined),
      cookies: vi
        .fn()
        .mockResolvedValue([{ name: 'sid', value: 'abc', domain: 'example.com', path: '/' }]),
      trace: vi.fn().mockResolvedValue({
        artifactId: 'trace_1',
        type: 'trace',
        contentType: 'application/json',
        sizeBytes: 2048,
        url: '/v1/sessions/ses_1/artifacts/trace_1',
      }),
      html: vi.fn().mockResolvedValue({
        artifactId: 'html_1',
        type: 'html',
        contentType: 'text/html; charset=utf-8',
        sizeBytes: 37,
        inline: {
          contentBase64: Buffer.from('<html><body>form values</body></html>').toString('base64'),
          byteSize: 37,
        },
      }),
      artifact: vi.fn().mockResolvedValue({
        metadata: {
          artifactId: 'html_1',
          type: 'html',
          contentType: 'text/html; charset=utf-8',
          sizeBytes: 4096,
        },
        contentBase64: Buffer.from('<html>stored bytes</html>').toString('base64'),
      }),
      events: vi
        .fn()
        .mockResolvedValue([{ type: 'request.finished', timestamp: 't', data: { status: 200 } }]),
      createPage: vi.fn().mockResolvedValue({
        pageId: 'pg_1',
        sessionId: 'ses_1',
        status: 'ready',
      }),
      navigate: vi.fn().mockResolvedValue({
        status: 'success',
        url: 'https://example.com',
        redirectChain: [],
      }),
      observe: vi.fn().mockResolvedValue({
        sessionId: 'ses_1',
        pageId: 'pg_1',
        revision: 1,
        url: 'https://example.com',
        title: 'Example',
        status: 'interactive',
        summary: 'Page with 1 button',
        elements: [{ ref: 'e1_0', role: 'button', name: 'Submit', visible: true, enabled: true }],
        truncated: false,
        untrustedContent: true,
      }),
      executeAction: vi.fn().mockResolvedValue({
        status: 'success',
        actionId: 'act_1',
        newRevision: 2,
      }),
      screenshot: vi.fn().mockResolvedValue({
        artifactId: 'art_1',
        type: 'screenshot',
        contentType: 'image/png',
        sizeBytes: 2048,
        url: '/sessions/ses_1/artifacts/art_1',
      }),
    };

    deps = {
      createClient: vi.fn().mockReturnValue({
        health: vi.fn().mockResolvedValue({ status: 'healthy', version: '1.8.18', uptime: 4213 }),
        healthLive: vi.fn().mockResolvedValue({ status: 'live' }),
        healthReady: vi.fn().mockResolvedValue({ status: 'ready', engine: 'playwright-chromium' }),
        sessions,
      }),
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    };
  });

  describe('session commands', () => {
    it('documents the ten-minute default while preserving explicit idle overrides', async () => {
      expect(await run('session', 'create', '--help')).toBe(0);
      expect(out.join('\n')).toContain('600000 = 10 min');
      expect(out.join('\n')).not.toContain('120000 = 2 min');
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('should create a session', async () => {
      const code = await run('session', 'create', '--tenant', 'tenant_1');

      expect(code).toBe(0);
      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant_1' })
      );
      expect(out.join('\n')).toContain('ses_1');
    });

    it('should pass session options through', async () => {
      await run(
        'session',
        'create',
        '--tenant',
        'tenant_1',
        '--engine',
        'playwright-chromium',
        '--headless',
        '--viewport',
        '1280x720'
      );

      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant_1',
          engine: 'playwright-chromium',
          headless: true,
          viewport: { width: 1280, height: 720 },
        })
      );
    });

    it('should pass the new session flags through (idle-timeout, locale, policy nesting)', async () => {
      await run(
        'session',
        'create',
        '--tenant',
        'tenant_1',
        '--idle-timeout',
        '3600000',
        '--locale',
        'en-US',
        '--timezone-id',
        'America/New_York',
        '--allow-downloads',
        '--max-download-bytes',
        '1048576',
        '--blocked-hosts',
        'ads.example.com, tracker.io'
      );

      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant_1',
          idleTimeoutMs: 3_600_000,
          locale: 'en-US',
          timezoneId: 'America/New_York',
          policy: {
            allowDownloads: true,
            maxDownloadBytes: 1_048_576,
            blockedHosts: ['ads.example.com', 'tracker.io'],
          },
        })
      );
    });

    it('should seed cookies from inline JSON and reject malformed JSON', async () => {
      const jar = JSON.stringify([{ name: 'sid', value: 'abc', domain: 'example.com', path: '/' }]);
      await run('session', 'create', '--tenant', 'tenant_1', '--cookies', jar);
      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/' }],
        })
      );

      const bad = await run('session', 'create', '--tenant', 'tenant_1', '--cookies', 'not-json');
      expect(bad).toBe(1);
      expect(sessions.create).toHaveBeenCalledTimes(1);
    });

    it('should export cookies (the credential-handoff loop)', async () => {
      await run('session', 'cookies', 'ses_1');
      expect(sessions.cookies).toHaveBeenCalledWith('ses_1');
    });

    it('should export trace, HTML, and replay events (evidence from the CLI)', async () => {
      await run('session', 'trace', 'ses_1');
      expect(sessions.trace).toHaveBeenCalledWith('ses_1');

      await run('page', 'html', '--no-print', 'ses_1', 'pg_1');
      expect(sessions.html).toHaveBeenCalledWith('ses_1', 'pg_1');

      await run('session', 'events', 'ses_1', '--type', 'request.finished');
      expect(sessions.events).toHaveBeenCalledWith('ses_1', 'request.finished');
    });

    it('prints HTML inline by default and pulls stored bytes when not inlined', async () => {
      await run('page', 'html', 'ses_1', 'pg_1');
      expect(sessions.artifact).not.toHaveBeenCalled();
      expect(out.join('\n')).toContain('form values');

      sessions.html.mockResolvedValueOnce({
        artifactId: 'html_2',
        type: 'html',
        contentType: 'text/html; charset=utf-8',
        sizeBytes: 999999,
      });
      await run('page', 'html', 'ses_1', 'pg_1');
      expect(sessions.artifact).toHaveBeenCalledWith('ses_1', 'html_2');
      expect(out.join('\n')).toContain('stored bytes');
    });

    it('forwards --continue-from to resume a truncated observation', async () => {
      await run('observe', 'ses_1', 'pg_1', '--continue-from', '40');
      expect(sessions.observe).toHaveBeenCalledWith('ses_1', 'pg_1', {
        continueFrom: 40,
      });
    });

    it('should send headless:false for --no-headless (the flag that was missing live)', async () => {
      await run('session', 'create', '--tenant', 'tenant_1', '--no-headless');

      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant_1', headless: false })
      );
    });

    it('should treat --headless --no-headless as last-one-wins (false), pinning the truth table', async () => {
      await run('session', 'create', '--tenant', 'tenant_1', '--headless', '--no-headless');
      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant_1', headless: false })
      );
    });

    it('should omit headless entirely when neither flag is given (server default applies)', async () => {
      await run('session', 'create', '--tenant', 'tenant_1');

      const call = (sessions.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect('headless' in call).toBe(false);
    });

    it('should reject a malformed viewport', async () => {
      const code = await run('session', 'create', '--tenant', 't', '--viewport', 'wide');

      expect(code).toBe(1);
      expect(sessions.create).not.toHaveBeenCalled();
      expect(err.join('\n')).toContain('viewport');
    });

    it('should list sessions', async () => {
      const code = await run('session', 'list');

      expect(code).toBe(0);
      expect(sessions.list).toHaveBeenCalled();
      expect(out.join('\n')).toContain('ses_1');
      expect(out.join('\n')).toContain('ses_2');
    });

    it('should report an empty session list', async () => {
      sessions.list.mockResolvedValue([]);

      await run('session', 'list');

      expect(out.join('\n')).toContain('No sessions');
    });

    it('should close a session', async () => {
      const code = await run('session', 'close', 'ses_1');

      expect(code).toBe(0);
      expect(sessions.close).toHaveBeenCalledWith('ses_1');
    });
  });

  describe('page commands', () => {
    it('should create a page', async () => {
      const code = await run('page', 'create', 'ses_1');

      expect(code).toBe(0);
      expect(sessions.createPage).toHaveBeenCalledWith('ses_1', undefined);
      expect(out.join('\n')).toContain('pg_1');
    });
  });

  describe('navigate command', () => {
    it('should navigate a page', async () => {
      const code = await run('navigate', 'ses_1', 'pg_1', 'https://example.com');

      expect(code).toBe(0);
      expect(sessions.navigate).toHaveBeenCalledWith('ses_1', 'pg_1', {
        url: 'https://example.com',
      });
    });

    it('should pass waitUntil through', async () => {
      await run('navigate', 'ses_1', 'pg_1', 'https://example.com', '--wait-until', 'networkidle');

      expect(sessions.navigate).toHaveBeenCalledWith('ses_1', 'pg_1', {
        url: 'https://example.com',
        waitUntil: 'networkidle',
      });
    });
  });

  describe('observe command', () => {
    it('should print a readable observation', async () => {
      const code = await run('observe', 'ses_1', 'pg_1');

      expect(code).toBe(0);
      expect(sessions.observe).toHaveBeenCalledWith('ses_1', 'pg_1', {});
      const text = out.join('\n');
      expect(text).toContain('Example');
      expect(text).toContain('e1_0');
      expect(text).toContain('button');
      expect(text).toContain('Submit');
    });

    it('should pass mode and limits through', async () => {
      await run('observe', 'ses_1', 'pg_1', '--mode', 'content', '--max-elements', '50');

      expect(sessions.observe).toHaveBeenCalledWith('ses_1', 'pg_1', {
        mode: 'content',
        maxElements: 50,
      });
    });

    it('should accumulate repeatable --include tokens', async () => {
      await run('observe', 'ses_1', 'pg_1', '--include', 'fileInputs', '--include', 'overlays');

      expect(sessions.observe).toHaveBeenCalledWith('ses_1', 'pg_1', {
        include: ['fileInputs', 'overlays'],
      });
    });

    it('should omit include when the flag is absent', async () => {
      await run('observe', 'ses_1', 'pg_1', '--mode', 'content');

      expect(sessions.observe).toHaveBeenCalledWith('ses_1', 'pg_1', { mode: 'content' });
    });

    it('should warn that page content is untrusted', async () => {
      await run('observe', 'ses_1', 'pg_1');

      expect(out.join('\n').toLowerCase()).toContain('untrusted');
    });
  });

  describe('observe command', () => {
    it('renders a [checked] marker for checked checkboxes', async () => {
      sessions.observe.mockResolvedValueOnce({
        sessionId: 'ses_1',
        pageId: 'pg_1',
        revision: 1,
        url: 'https://example.com',
        title: 'Example',
        status: 'interactive',
        elements: [
          {
            ref: 'e1_0',
            role: 'checkbox',
            name: 'Notify me',
            visible: true,
            enabled: true,
            checked: true,
          },
        ],
        truncated: false,
        untrustedContent: true,
      });
      await run('observe', 'ses_1', 'pg_1');

      expect(out.join('\n')).toContain('[checked]');
    });
  });

  describe('action commands', () => {
    it('should execute a click', async () => {
      const code = await run('act', 'click', 'ses_1', 'pg_1', 'e1_0');

      expect(code).toBe(0);
      expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', {
        action: 'click',
        target: { ref: 'e1_0' },
      });
    });

    it('should execute a fill', async () => {
      await run('act', 'fill', 'ses_1', 'pg_1', 'e1_0', 'hello@example.com');

      expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', {
        action: 'fill',
        target: { ref: 'e1_0' },
        value: 'hello@example.com',
      });
    });

    it('should execute a select', async () => {
      await run('act', 'select', 'ses_1', 'pg_1', 'e1_0', 'Canada');

      expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', {
        action: 'select',
        target: { ref: 'e1_0' },
        value: 'Canada',
      });
    });

    it('should reject a malformed element ref before calling the API', async () => {
      const code = await run('act', 'click', 'ses_1', 'pg_1', 'button.submit');

      expect(code).toBe(1);
      expect(sessions.executeAction).not.toHaveBeenCalled();
      expect(err.join('\n')).toContain('button.submit');
    });

    it('upload: takes a single absolute path as the file list, not a ref', async () => {
      // commander fills [ref] before the variadic paths, so the natural
      // no-ref invocation would otherwise die as "missing required argument
      // 'paths'". Refs are never absolute paths, so the shift is safe.
      const code = await run('act', 'upload', 'ses_1', 'pg_1', '/tmp/resume.pdf');

      expect(code).toBe(0);
      expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', {
        action: 'upload',
        paths: ['/tmp/resume.pdf'],
      });
    });

    it('upload: still targets by ref when a ref is given with paths', async () => {
      const code = await run('act', 'upload', 'ses_1', 'pg_1', 'e1_0', '/tmp/resume.pdf');

      expect(code).toBe(0);
      expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', {
        action: 'upload',
        target: { ref: 'e1_0' },
        paths: ['/tmp/resume.pdf'],
      });
    });

    it('upload: multiple paths bind untargeted', async () => {
      // The first path lands in commander's [ref] slot; an absolute token
      // there is reassigned to the paths list.
      const code = await run('act', 'upload', 'ses_1', 'pg_1', '/tmp/a.pdf', '/tmp/b.pdf');

      expect(code).toBe(0);
      expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', {
        action: 'upload',
        paths: ['/tmp/a.pdf', '/tmp/b.pdf'],
      });
    });

    it('upload: refuses with a usage error when no path is given', async () => {
      const code = await run('act', 'upload', 'ses_1', 'pg_1');

      expect(code).toBe(1);
      expect(sessions.executeAction).not.toHaveBeenCalled();
      expect(err.join('\n')).toContain('at least one absolute file path');
    });

    it('should surface the new revision', async () => {
      await run('act', 'click', 'ses_1', 'pg_1', 'e1_0');

      expect(out.join('\n')).toContain('2');
    });
  });

  describe('screenshot command', () => {
    it('should capture a screenshot', async () => {
      const code = await run('screenshot', 'ses_1', 'pg_1');

      expect(code).toBe(0);
      expect(sessions.screenshot).toHaveBeenCalledWith('ses_1', 'pg_1', {});
      expect(out.join('\n')).toContain('art_1');
    });

    it('should pass capture options through', async () => {
      await run('screenshot', 'ses_1', 'pg_1', '--full-page', '--format', 'jpeg');

      expect(sessions.screenshot).toHaveBeenCalledWith('ses_1', 'pg_1', {
        fullPage: true,
        format: 'jpeg',
      });
    });
  });

  describe('global options', () => {
    it.each([
      { flag: 'flag-key', environment: undefined, expected: 'flag-key' },
      { flag: undefined, environment: 'environment-key', expected: 'environment-key' },
      { flag: 'flag-key', environment: 'environment-key', expected: 'flag-key' },
      { flag: undefined, environment: undefined, expected: undefined },
      { flag: undefined, environment: '', expected: undefined },
    ])(
      'passes authentication to the SDK with flag precedence ($expected)',
      async ({ flag, environment, expected }) => {
        vi.stubEnv('AGENTBROWSER_API_KEY', environment);
        try {
          expect(await run(...(flag ? ['--api-key', flag] : []), 'session', 'list')).toBe(0);
          const options = vi.mocked(deps.createClient).mock.calls[0]?.[0];
          if (expected === undefined) expect(options).not.toHaveProperty('apiKey');
          else expect(options).toMatchObject({ apiKey: expected });
          expect([...out, ...err].join('\n')).not.toMatch(/flag-key|environment-key/);
        } finally {
          vi.unstubAllEnvs();
        }
      }
    );

    it('should default to the local server', async () => {
      await run('session', 'list');

      expect(deps.createClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://localhost:5709' })
      );
    });

    it('should honour --base-url', async () => {
      await run('--base-url', 'https://browser.internal', 'session', 'list');

      expect(deps.createClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://browser.internal' })
      );
    });

    it('should emit machine-readable output with --json', async () => {
      await run('--json', 'observe', 'ses_1', 'pg_1');

      const parsed = lastJson();
      expect(parsed.pageId).toBe('pg_1');
      expect(parsed.elements[0].ref).toBe('e1_0');
    });

    it('should emit JSON for a created session', async () => {
      await run('--json', 'session', 'create', '--tenant', 't1');

      expect(lastJson().sessionId).toBe('ses_1');
    });
  });

  describe('error handling', () => {
    it('should report an API error and exit non-zero', async () => {
      sessions.navigate.mockRejectedValue(
        Object.assign(new Error('POLICY_DENIED: host is blocked'), {
          name: 'AgentBrowserError',
          code: 'POLICY_DENIED',
          retryable: false,
        })
      );

      const code = await run('navigate', 'ses_1', 'pg_1', 'https://blocked.test');

      expect(code).toBe(1);
      expect(err.join('\n')).toContain('POLICY_DENIED');
      expect(out.join('\n')).toBe('');
    });

    it('should report a stale ref without retrying', async () => {
      sessions.executeAction.mockRejectedValue(
        Object.assign(new Error('STALE_TARGET: ref belongs to revision 1'), {
          name: 'AgentBrowserError',
          code: 'STALE_TARGET',
          retryable: true,
        })
      );

      const code = await run('act', 'click', 'ses_1', 'pg_1', 'e1_0');

      expect(code).toBe(1);
      expect(sessions.executeAction).toHaveBeenCalledTimes(1);
      expect(err.join('\n')).toContain('STALE_TARGET');
    });

    it('should report an unexpected failure', async () => {
      sessions.list.mockRejectedValue(new Error('connection refused'));

      const code = await run('session', 'list');

      expect(code).toBe(1);
      expect(err.join('\n')).toContain('connection refused');
    });

    it('should report an unknown command without throwing', async () => {
      const code = await run('teleport');

      expect(code).toBe(1);
    });
  });

  describe('bulk command input and discovery', () => {
    const payload = { fields: [{ match: { label: 'Name' }, value: 'private value' }] };

    it('expands canonical nested autofill schemas only when requested, offline', async () => {
      expect(await run('describe', 'autofill')).toBe(0);
      expect(lastJson().command.schemas).toBeUndefined();
      out.length = 0;
      expect(await run('describe', 'autofill', '--schema')).toBe(0);
      const schemas = lastJson().command.schemas;
      expect(
        schemas.input.properties.fields.items.properties.match.properties.block.properties.label
          .maxLength
      ).toBe(512);
      expect(schemas.output.properties.receipts.items.properties.status.anyOf).toContainEqual({
        const: 'uncertain',
        type: 'string',
      });
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('describes the canonical plan array and report without constructing a client', async () => {
      expect(await run('describe', 'plan', '--schema')).toBe(0);
      const { input, output } = lastJson().command.schemas;
      expect(input.type).toBe('array');
      expect(input.items.properties.waitMs.maximum).toBe(60000);
      expect(output.$id).toBe('urn:agentbrowser:plan-report:v1');
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('describes the canonical outcome request and report without constructing a client', async () => {
      expect(await run('describe', 'outcome', '--schema')).toBe(0);
      const { input, output } = lastJson().command.schemas;
      expect(input.properties.actions.items.properties.waitMs.maximum).toBe(60000);
      expect(input.properties.verification.properties.verifier.required).toEqual(['id', 'version']);
      expect(input.properties.verification.properties.evidenceCorrelationId).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[a-zA-Z0-9_-]{1,128}$',
      });
      expect(input.properties.verification.required).not.toContain('evidenceCorrelationId');
      expect(output.properties).toHaveProperty('plan');
      expect(output.properties).toHaveProperty('outcome');
      expect(deps.createClient).not.toHaveBeenCalled();
    });

    it('executes one canonical outcome call and exits zero only for a derived pass', async () => {
      const request = {
        actions: [{ action: 'press', key: 'Tab' }],
        verification: {
          verifier: { id: 'fixture.saved', version: '1' },
          input: { expected: true },
          evidenceCorrelationId: 'save-profile-42',
        },
      };
      const report = {
        plan: { ok: true, completed: 1, results: [{ step: 0, ok: true }] },
        outcome: {
          availability: 'available',
          execution: 'completed',
          verification: {
            status: 'passed',
            verifier: { id: 'fixture.saved', version: '1' },
            requiredLayer: 'G6',
            achievedLayer: 'G6',
            evidenceRefIds: ['receipt_1'],
          },
          cleanup: 'not_needed',
          testedSeam: 'ui',
        },
      };
      sessions.outcome = vi.fn().mockResolvedValue(report);
      expect(
        await run(
          '--json',
          '--operation-id',
          'outcome-once',
          'outcome',
          'ses_1',
          'pg_1',
          JSON.stringify(request)
        )
      ).toBe(0);
      expect(sessions.outcome).toHaveBeenCalledTimes(1);
      expect(sessions.outcome).toHaveBeenCalledWith('ses_1', 'pg_1', request);
      expect(request.verification.evidenceCorrelationId).not.toBe('outcome-once');
      expect(lastJson()).toEqual(report);
      expect(deps.createClient).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { 'x-agentbrowser-operation-id': 'outcome-once' } })
      );

      out.length = 0;
      report.outcome.verification.status = 'failed';
      sessions.outcome.mockResolvedValue(report);
      expect(await run('--json', 'outcome', 'ses_1', 'pg_1', JSON.stringify(request))).toBe(1);
      expect(lastJson()).toEqual(report);
    });

    it('reports an outcome replay as reconciliation without printing a false report', async () => {
      const request = {
        actions: [{ action: 'press', key: 'Tab' }],
        verification: {
          verifier: { id: 'fixture.saved', version: '1' },
          input: true,
        },
      };
      sessions.outcome = vi.fn().mockRejectedValue(
        Object.assign(new Error('OPERATION_RECORDED: reconcile its status'), {
          name: 'AgentBrowserError',
          code: 'OPERATION_RECORDED',
          retryable: false,
          details: { operationId: 'outcome-once' },
        })
      );
      expect(
        await run(
          '--json',
          '--operation-id',
          'outcome-once',
          'outcome',
          'ses_1',
          'pg_1',
          JSON.stringify(request)
        )
      ).toBe(1);
      expect(sessions.outcome).toHaveBeenCalledOnce();
      expect(out).toEqual([]);
      expect(err.join(' ')).toContain('OPERATION_RECORDED');
    });

    it('rejects malformed outcome input and contradictory private reports without retrying', async () => {
      sessions.outcome = vi.fn();
      expect(await run('outcome', 'ses_1', 'pg_1', '{"actions":"PRIVATE-INPUT"}')).toBe(1);
      expect(sessions.outcome).not.toHaveBeenCalled();
      expect(err.join(' ')).not.toContain('PRIVATE-INPUT');

      err.length = 0;
      expect(
        await run(
          'outcome',
          'ses_1',
          'pg_1',
          JSON.stringify({
            actions: [{ action: 'press', key: 'Tab' }],
            verification: {
              verifier: { id: 'fixture.saved', version: '1' },
              input: true,
              evidenceCorrelationId: 'PRIVATE.INVALID',
            },
          })
        )
      ).toBe(1);
      expect(sessions.outcome).not.toHaveBeenCalled();
      expect(err.join(' ')).not.toContain('PRIVATE.INVALID');

      err.length = 0;
      const request = {
        actions: [{ action: 'press', key: 'Tab' }],
        verification: {
          verifier: { id: 'fixture.saved', version: '1' },
          input: { expected: 'PRIVATE-EXPECTED' },
        },
      };
      sessions.outcome.mockResolvedValue({
        plan: {
          ok: true,
          completed: 0,
          results: [],
          error: { code: 'REMOTE', message: 'PRIVATE-REPORT' },
        },
        outcome: {
          availability: 'available',
          execution: 'completed',
          verification: {
            status: 'passed',
            verifier: { id: 'fixture.saved', version: '1' },
            requiredLayer: 'G6',
            achievedLayer: 'G6',
            evidenceRefIds: ['receipt_1'],
          },
          cleanup: 'not_needed',
          testedSeam: 'ui',
        },
      });
      expect(await run('--json', 'outcome', 'ses_1', 'pg_1', JSON.stringify(request))).toBe(1);
      expect(sessions.outcome).toHaveBeenCalledTimes(1);
      expect(out).toEqual([]);
      expect(err.join(' ')).toContain('may have executed');
      expect(err.join(' ')).not.toContain('PRIVATE-EXPECTED');
      expect(err.join(' ')).not.toContain('PRIVATE-REPORT');
    });

    it('rejects invalid plan steps before dispatch', async () => {
      sessions.plan = vi.fn();
      expect(await run('plan', 'ses_1', 'pg_1', '[{"action":"press","count":21}]')).toBe(1);
      expect(sessions.plan).not.toHaveBeenCalled();
    });

    it('explicitly reports missing schemas instead of inventing contracts', async () => {
      expect(await run('describe', 'act', 'press', '--schema')).toBe(0);
      expect(lastJson().command.schemas).toBeNull();
    });

    it('passes piped autofill through one SDK call with the retained operation ID', async () => {
      deps.stdin = Readable.from([JSON.stringify(payload)]);
      expect(
        await run('--json', '--operation-id', 'fill-once', 'autofill', 'ses_1', 'pg_1', '-')
      ).toBe(0);
      expect(sessions.autofill).toHaveBeenCalledTimes(1);
      expect(sessions.autofill).toHaveBeenCalledWith('ses_1', 'pg_1', payload);
      expect(deps.createClient).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { 'x-agentbrowser-operation-id': 'fill-once' } })
      );
    });

    it('preserves partial receipts in JSON and exits nonzero on failed autofill', async () => {
      const report = {
        ok: false,
        receipts: [{ field: 0, match: { label: 'Name' }, status: 'uncertain', verified: false }],
        elapsedMs: 10,
      };
      sessions.autofill.mockResolvedValue(report);
      expect(await run('--json', 'autofill', 'ses_1', 'pg_1', JSON.stringify(payload))).toBe(1);
      expect(lastJson()).toEqual(report);
      expect(err).toEqual([]);
    });

    it('rejects a malformed autofill report without echoing it or retrying', async () => {
      sessions.autofill.mockResolvedValue({ ok: 'false', receipts: [], private: 'PRIVATE-REPORT' });
      expect(await run('--json', 'autofill', 'ses_1', 'pg_1', JSON.stringify(payload))).toBe(1);
      expect(sessions.autofill).toHaveBeenCalledTimes(1);
      expect(out).toEqual([]);
      expect(err.join(' ')).toContain('may have executed');
      expect(err.join(' ')).not.toContain('PRIVATE-REPORT');
    });

    it('rejects contradictory autofill success without echoing it or retrying', async () => {
      sessions.autofill.mockResolvedValue({
        ok: true,
        receipts: [
          {
            field: 0,
            match: { label: 'Name' },
            status: 'verified',
            verified: false,
            error: { code: 'REMOTE_FAILURE', message: 'PRIVATE-REPORT' },
          },
        ],
        elapsedMs: 1,
      });
      expect(await run('--json', 'autofill', 'ses_1', 'pg_1', JSON.stringify(payload))).toBe(1);
      expect(sessions.autofill).toHaveBeenCalledTimes(1);
      expect(out).toEqual([]);
      expect(err.join(' ')).toContain('may have executed');
      expect(err.join(' ')).not.toContain('PRIVATE-REPORT');
    });

    it('rejects successful autofill that omits a requested field receipt', async () => {
      const twoFields = {
        fields: [...payload.fields, { match: { label: 'Email' }, value: 'private email' }],
      };
      sessions.autofill.mockImplementation(
        async (_sessionId: string, _pageId: string, request: typeof twoFields) => {
          request.fields.pop();
          return {
            ok: true,
            receipts: [
              {
                field: 0,
                match: { label: 'Name' },
                status: 'verified',
                verified: true,
                actual: 'PRIVATE-REPORT',
              },
            ],
            elapsedMs: 1,
          };
        }
      );
      expect(await run('--json', 'autofill', 'ses_1', 'pg_1', JSON.stringify(twoFields))).toBe(1);
      expect(sessions.autofill).toHaveBeenCalledTimes(1);
      expect(out).toEqual([]);
      expect(err.join(' ')).toContain('may have executed');
      expect(err.join(' ')).not.toContain('PRIVATE-REPORT');
    });

    it('does not retry a lost autofill response', async () => {
      sessions.autofill.mockRejectedValue(new Error('Write outcome uncertain'));
      expect(await run('autofill', 'ses_1', 'pg_1', JSON.stringify(payload))).toBe(1);
      expect(sessions.autofill).toHaveBeenCalledTimes(1);
    });

    it('shares bounded stdin input with plan and preserves a failed result', async () => {
      const steps = [{ action: 'press', key: 'Tab' }];
      deps.stdin = Readable.from([JSON.stringify(steps)]);
      const report = {
        ok: false,
        completed: 0,
        results: [{ step: 0, ok: false, error: 'denied' }],
      };
      sessions.plan = vi.fn().mockResolvedValue(report);
      expect(await run('--json', 'plan', 'ses_1', 'pg_1', '-')).toBe(1);
      expect(sessions.plan).toHaveBeenCalledTimes(1);
      expect(sessions.plan).toHaveBeenCalledWith('ses_1', 'pg_1', steps);
      expect(lastJson()).toEqual(report);
    });

    it('rejects contradictory plan success without echoing it or retrying', async () => {
      sessions.plan = vi.fn().mockResolvedValue({
        ok: true,
        completed: 1,
        results: [],
        error: { code: 'REMOTE_FAILURE', message: 'PRIVATE-REPORT' },
      });
      expect(await run('--json', 'plan', 'ses_1', 'pg_1', '[]')).toBe(1);
      expect(sessions.plan).toHaveBeenCalledTimes(1);
      expect(out).toEqual([]);
      expect(err.join(' ')).toContain('may have executed');
      expect(err.join(' ')).not.toContain('PRIVATE-REPORT');
    });

    it('rejects successful plan that omits a requested step result', async () => {
      const steps = [
        { action: 'press', key: 'Tab' },
        { action: 'press', key: 'Tab' },
      ];
      sessions.plan = vi.fn().mockImplementation(async (_sessionId, _pageId, dispatchedSteps) => {
        dispatchedSteps.pop();
        return {
          ok: true,
          completed: 1,
          results: [{ step: 0, ok: true, result: { secret: 'PRIVATE-REPORT' } }],
        };
      });
      expect(await run('--json', 'plan', 'ses_1', 'pg_1', JSON.stringify(steps))).toBe(1);
      expect(out).toEqual([]);
      expect(err.join(' ')).toContain('may have executed');
      expect(sessions.plan).toHaveBeenCalledTimes(1);
      expect(err.join(' ')).not.toContain('PRIVATE-REPORT');
    });

    it('rejects unsafe explicitly requested fill verification evidence', async () => {
      const steps = [
        {
          action: 'fill',
          target: { ref: 'e1_0' },
          value: 'PRIVATE-WRITTEN',
          expectValue: 'PRIVATE-EXPECTED',
        },
      ];
      sessions.plan = vi.fn().mockResolvedValue({
        ok: true,
        completed: 1,
        results: [{ step: 0, ok: true, result: { verified: true, actual: 'PRIVATE-READBACK' } }],
      });
      expect(await run('--json', 'plan', 'ses_1', 'pg_1', JSON.stringify(steps))).toBe(1);
      expect(out).toEqual([]);
      expect(err.join(' ')).toContain('may have executed');
      expect(sessions.plan).toHaveBeenCalledTimes(1);
      expect(err.join(' ')).not.toContain('PRIVATE-WRITTEN');
      expect(err.join(' ')).not.toContain('PRIVATE-EXPECTED');
      expect(err.join(' ')).not.toContain('PRIVATE-READBACK');
    });

    it('rejects private malformed or oversized input before dispatch', async () => {
      for (const input of ['PRIVATE-VALUE', ' '.repeat(1024 * 1024 + 1)]) {
        err.length = 0;
        expect(await run('autofill', 'ses_1', 'pg_1', input)).toBe(1);
        expect(err.join(' ')).not.toContain('PRIVATE-VALUE');
      }
      expect(sessions.autofill).not.toHaveBeenCalled();
    });

    it('rejects two stdin payloads before consuming either', async () => {
      deps.stdin = Readable.from([JSON.stringify(payload)]);
      expect(await run('autofill', 'ses_1', 'pg_1', '-', '--policy', '-')).toBe(1);
      expect(deps.stdin.readableDidRead).toBe(false);
      expect(sessions.autofill).not.toHaveBeenCalled();
    });
  });

  describe('cli full parity additions', () => {
    it('autofill sends the parsed payload and renders receipts without field values', async () => {
      const code = await run(
        '--json',
        'autofill',
        'ses_1',
        'pg_1',
        JSON.stringify({
          fields: [
            { match: { label: 'First Name' }, value: 'Vijaykumar', verify: 'exact' },
            { match: { label: 'Last Name' }, value: 'Singh', verify: 'exact' },
          ],
        })
      );
      expect(code).toBe(0);
      expect(sessions.autofill).toHaveBeenCalledWith(
        'ses_1',
        'pg_1',
        expect.objectContaining({ fields: expect.any(Array) })
      );
      const report = lastJson();
      expect(report.ok).toBe(true);
      expect(report.receipts).toHaveLength(2);
    });

    it('autofill reads the payload from @file', async () => {
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'cli-autofill-'));
      const file = join(dir, 'payload.json');
      writeFileSync(file, JSON.stringify({ fields: [{ match: { label: 'A' }, value: 'b' }] }));
      expect(await run('autofill', 'ses_1', 'pg_1', `@${file}`)).toBe(0);
      expect(sessions.autofill).toHaveBeenCalled();
    });

    it('autofill rejects invalid JSON locally without contacting the client', async () => {
      const code = await run('autofill', 'ses_1', 'pg_1', '{not json');
      expect(code).toBe(1);
      expect(sessions.autofill).not.toHaveBeenCalled();
    });

    it('autofill rejects a protocol-invalid field locally', async () => {
      const code = await run(
        'autofill',
        'ses_1',
        'pg_1',
        JSON.stringify({ fields: [{ match: { label: 'A' } }] })
      );
      expect(code).toBe(1);
      expect(sessions.autofill).not.toHaveBeenCalled();
    });

    it('autofill --policy replaces the policy object', async () => {
      const code = await run(
        '--json',
        'autofill',
        'ses_1',
        'pg_1',
        JSON.stringify({ fields: [{ match: { label: 'A' }, value: 'b' }] }),
        '--policy',
        JSON.stringify({ onAmbiguous: 'skip', maxReobserve: 1 })
      );
      expect(code).toBe(0);
      expect(sessions.autofill).toHaveBeenCalledWith(
        'ses_1',
        'pg_1',
        expect.objectContaining({
          policy: expect.objectContaining({ onAmbiguous: 'skip' }),
        })
      );
    });

    it('autofill text render omits field values', async () => {
      sessions.autofill.mockResolvedValue({
        ok: true,
        receipts: [
          {
            field: 0,
            match: { label: 'A' },
            status: 'verified',
            verified: true,
            resolvedRef: 'e1_2',
            actual: 'SECRET-VALUE',
          },
        ],
        elapsedMs: 5,
      });
      expect(
        await run(
          'autofill',
          'ses_1',
          'pg_1',
          JSON.stringify({ fields: [{ match: { label: 'A' }, value: 'x' }] })
        )
      ).toBe(0);
      expect(out.join('\n')).not.toContain('SECRET-VALUE');
      expect(out.join('\n')).toContain('1/1 fields verified');
    });

    it('pdf forwards options and saves bytes with --out', async () => {
      const { writeFileSync } = await import('node:fs');
      const out = await import('node:os');
      const code = await run('pdf', 'ses_1', 'pg_1', '--landscape', '--out', '/tmp/cli-test.pdf');
      expect(code).toBe(0);
      expect(sessions.pdf).toHaveBeenCalledWith('ses_1', 'pg_1', { landscape: true });
      void writeFileSync;
      void out;
    });

    it('health defaults to the health summary and exits 1 when unhealthy', async () => {
      expect(await run('health')).toBe(0);
      expect(deps.createClient).toHaveBeenCalled();
      const client = (deps.createClient as unknown as ReturnType<typeof vi.fn>).mock.results[0]
        ?.value as { health: ReturnType<typeof vi.fn> } | undefined;
      client?.health.mockResolvedValueOnce({ status: 'unavailable' });
      expect(await run('health')).toBe(1);
    });

    it('health --ready and --live select the right probe', async () => {
      expect(await run('health', '--ready')).toBe(0);
      expect(await run('health', '--live')).toBe(0);
    });

    it('health errors cleanly when the client lacks health methods', async () => {
      (deps.createClient as ReturnType<typeof vi.fn>).mockImplementation((cfg: unknown) => {
        const real = (vi.mocked(deps.createClient).mock.results[0]?.value ?? { sessions }) as {
          sessions: unknown;
        };
        void real;
        return { sessions, health: undefined };
      });
      const code = await run('health');
      expect(code).toBe(1);
    });

    it('artifact get saves bytes with --out', async () => {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'cli-artifact-'));
      const file = join(dir, 'out.bin');
      sessions.artifact = vi.fn().mockResolvedValue({
        metadata: { artifactId: 'art_1' },
        contentBase64: Buffer.from('bytes').toString('base64'),
      });
      const code = await run('artifact', 'get', 'ses_1', 'art_1', '--out', file);
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('Saved art_1');
    });

    it('session get renders the session', async () => {
      const code = await run('session', 'get', 'ses_1');
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('2026-08-23T10:00:00Z');
    });

    it('page list renders pages', async () => {
      const code = await run('page', 'list', 'ses_1');
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('pg_1');
    });

    it('page create passes --url', async () => {
      const code = await run('page', 'create', 'ses_1', '--url', 'https://example.com/x');
      expect(code).toBe(0);
      expect(sessions.createPage).toHaveBeenCalledWith('ses_1', { url: 'https://example.com/x' });
    });

    it('page get and close round trip', async () => {
      expect(await run('page', 'get', 'ses_1', 'pg_1')).toBe(0);
      expect(await run('page', 'close', 'ses_1', 'pg_1')).toBe(0);
      expect(sessions.closePage).toHaveBeenCalledWith('ses_1', 'pg_1');
    });

    it('download and download collect dispatch separately', async () => {
      expect(await run('download', 'ses_1', 'pg_1', 'https://example.com/f.zip')).toBe(0);
      expect(sessions.download).toHaveBeenCalledWith('ses_1', 'pg_1', {
        url: 'https://example.com/f.zip',
      });
      expect(await run('download', 'collect', 'ses_1', 'pg_1', 'f.zip')).toBe(0);
      expect(sessions.collectDownload).toHaveBeenCalledWith('ses_1', 'pg_1', 'f.zip');
    });

    it('observe forwards --since-revision', async () => {
      sessions.observe = vi.fn().mockResolvedValue({ elements: [], revision: 9 });
      await run('observe', 'ses_1', 'pg_1', '--since-revision', '8');
      expect(sessions.observe).toHaveBeenCalledWith(
        'ses_1',
        'pg_1',
        expect.objectContaining({ sinceRevision: 8 })
      );
    });

    it('extract forwards --records', async () => {
      sessions.extract = vi.fn().mockResolvedValue({ data: [] });
      await run(
        'extract',
        'ses_1',
        'pg_1',
        '--format',
        'records',
        '--records',
        JSON.stringify({ container: '.row', fields: { name: '.name' } })
      );
      expect(sessions.extract).toHaveBeenCalledWith(
        'ses_1',
        'pg_1',
        expect.objectContaining({
          records: expect.objectContaining({ container: '.row' }),
        })
      );
    });

    it('help mentions the new commands', async () => {
      await run('--help');
      const text = out.join('\n');
      for (const token of ['autofill', 'pdf', 'download', 'health', 'artifact']) {
        expect(text).toContain(token);
      }
    });
  });

  describe('application authority commands', () => {
    beforeEach(() => {
      sessions.applicationBind = vi
        .fn()
        .mockResolvedValue({ adapter: 'owned-counter', resource: 'account' });
      sessions.applicationUnbind = vi.fn().mockResolvedValue({ unbound: true });
      sessions.applicationDiscover = vi.fn().mockResolvedValue({
        adapter: 'owned-counter',
        resource: 'account',
        operations: [
          { name: 'add', mode: 'write' },
          { name: 'balance', mode: 'read' },
        ],
      });
      sessions.applicationExecute = vi
        .fn()
        .mockResolvedValue({ status: 'committed', value: { operationId: 'effect-1', total: 1 } });
      sessions.applicationReceipt = vi
        .fn()
        .mockResolvedValue({ operationId: 'effect-1', total: 1 });
    });

    it('binds an adapter and renders the binding', async () => {
      expect(await run('application', 'bind', 'ses_1', 'owned-counter', 'account')).toBe(0);
      expect(sessions.applicationBind).toHaveBeenCalledWith('ses_1', {
        adapter: 'owned-counter',
        resource: 'account',
      });
      expect(out).toEqual(['Bound owned-counter to resource account']);
    });

    it('discovers operations in readable form and reports an empty binding', async () => {
      expect(await run('application', 'discover', 'ses_1')).toBe(0);
      expect(sessions.applicationDiscover).toHaveBeenCalledWith('ses_1');
      expect(out).toEqual([
        'Adapter owned-counter bound to account',
        '  write add',
        '  read  balance',
      ]);
      sessions.applicationDiscover = vi.fn().mockResolvedValue(null);
      out = [];
      expect(await run('application', 'discover', 'ses_1')).toBe(0);
      expect(out).toEqual(['No application binding on this session']);
    });

    it('executes a write with both identities and renders the receipt value', async () => {
      // The write identity rides the global reconciliation --operation-id.
      expect(
        await run(
          '--operation-id',
          'effect-1',
          'application',
          'execute',
          'ses_1',
          'add',
          '1',
          '--expected-version',
          '0'
        )
      ).toBe(0);
      expect(sessions.applicationExecute).toHaveBeenCalledWith('ses_1', {
        operation: 'add',
        input: 1,
        operationId: 'effect-1',
        expectedVersion: 0,
      });
      expect(out).toEqual(['committed: {"operationId":"effect-1","total":1}']);
    });

    it('renders rejections, replays, and defaults input to null', async () => {
      sessions.applicationExecute = vi
        .fn()
        .mockResolvedValue({ status: 'rejected', reason: 'stale business version' });
      expect(await run('application', 'execute', 'ses_1', 'add', '1')).toBe(0);
      expect(sessions.applicationExecute).toHaveBeenCalledWith('ses_1', {
        operation: 'add',
        input: 1,
      });
      expect(out).toEqual(['Rejected: stale business version']);
      sessions.applicationExecute = vi
        .fn()
        .mockResolvedValue({ replay: true, operation: { operationId: 'effect-1' } });
      out = [];
      expect(await run('application', 'execute', 'ses_1', 'balance')).toBe(0);
      expect(sessions.applicationExecute).toHaveBeenCalledWith('ses_1', {
        operation: 'balance',
        input: null,
      });
      expect(out.join('\n')).toContain('Replayed operation');
    });

    it('refuses a malformed --expected-version before calling the client', async () => {
      expect(
        await run(
          'application',
          'execute',
          'ses_1',
          'add',
          '1',
          '--expected-version',
          'not-a-number'
        )
      ).toBe(1);
      expect(err.join('\n')).toContain('--expected-version');
      expect(sessions.applicationExecute).not.toHaveBeenCalled();
    });

    it('reads a receipt and renders a missing one without failing', async () => {
      expect(await run('application', 'receipt', 'ses_1', 'effect-1')).toBe(0);
      expect(sessions.applicationReceipt).toHaveBeenCalledWith('ses_1', 'effect-1');
      expect(JSON.parse(out.join('\n'))).toEqual({ operationId: 'effect-1', total: 1 });
      sessions.applicationReceipt = vi.fn().mockResolvedValue(null);
      out = [];
      expect(await run('application', 'receipt', 'ses_1', 'effect-404')).toBe(0);
      expect(out).toEqual(['No receipt recorded for this operation ID']);
    });

    it('unbinds and renders the confirmation', async () => {
      expect(await run('application', 'unbind', 'ses_1')).toBe(0);
      expect(sessions.applicationUnbind).toHaveBeenCalledWith('ses_1');
      expect(out).toEqual(['Application binding removed']);
    });
  });

  describe('structural SDK mirror', () => {
    it('the real SDK client satisfies the CliClient slice (ADR-015)', async () => {
      // Compile-time enforcement lives in src/contracts.ts via
      // `pnpm -r type-check` (vitest does not type-check). This companion
      // constructs the real client as the mirror so the wiring stays honest
      // at runtime too.
      const { AgentBrowserClient } = await import('@agentbrowser/sdk-typescript');
      const real: CliClient = new AgentBrowserClient({ baseUrl: 'http://127.0.0.1:1' });
      for (const member of [
        'get',
        'create',
        'autofill',
        'plan',
        'outcome',
        'applicationBind',
        'applicationExecute',
      ] as const) {
        expect(typeof real.sessions[member]).toBe('function');
      }
    });
  });
});
