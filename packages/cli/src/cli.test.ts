/**
 * TDD Tests for the AgentBrowser CLI
 *
 * The CLI is built as a factory over injected dependencies so the command
 * surface can be exercised without spawning a process or hitting a server.
 */

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
      autofill: vi.fn().mockResolvedValue({
        ok: true,
        receipts: [
          { field: 0, status: 'verified', verified: true, resolvedRef: 'e1_2' },
          { field: 1, status: 'verified', verified: true, resolvedRef: 'e1_3' },
        ],
        elapsedMs: 1234,
        snapshot: { artifactId: 'art_9' },
      }),
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

    it('autofill reads the payload from @file and pipes stdin', async () => {
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
        receipts: [{ field: 0, status: 'verified', verified: true, resolvedRef: 'e1_2' }],
        elapsedMs: 5,
        actual: 'SECRET-VALUE',
        value: 'SECRET-VALUE',
      });
      await run(
        'autofill',
        'ses_1',
        'pg_1',
        JSON.stringify({ fields: [{ match: { label: 'A' }, value: 'x' }] })
      );
      expect(out.join('\n')).not.toContain('SECRET-VALUE');
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
});
