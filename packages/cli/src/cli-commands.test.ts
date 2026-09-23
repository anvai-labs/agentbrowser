/**
 * Behavioral coverage for the remaining CLI command surface: delegated
 * operation reconciliation, session-create option plumbing, snapshot/plan/
 * outcome text rendering, the full act vocabulary, artifact saving and the
 * observation renderer's element markers. Drives the same injected-dependency
 * factory as cli.test.ts — no process, no server.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCli } from './cli.js';
import type { CliClient, CliDependencies } from './cli.js';
import { assertCookieRequestSize, parseCookieText } from './cookie-file.js';
import { PRODUCT_VERSION } from './product-version.js';

describe('AgentBrowser CLI remaining command surface', () => {
  let out: string[];
  let err: string[];
  let sessions: Record<string, ReturnType<typeof vi.fn>>;
  let deps: CliDependencies;

  /** Run the CLI with user-style argv and return the exit code. */
  const run = (...argv: string[]) => buildCli(deps).run(argv);

  const lastJson = () => JSON.parse(out.join('\n'));

  /** A temp file path that should receive artifact bytes. */
  const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'cli-cov-')), name);

  beforeEach(() => {
    out = [];
    err = [];

    sessions = {
      get: vi.fn().mockResolvedValue({ sessionId: 'ses_1' }),
      list: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
      cookies: vi
        .fn()
        .mockResolvedValue([{ name: 'sid', value: 'abc', domain: 'example.com', path: '/' }]),
      trace: vi.fn().mockResolvedValue({ artifactId: 'trace_1', type: 'trace', sizeBytes: 1 }),
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
        metadata: { artifactId: 'html_1' },
        contentBase64: Buffer.from('<html>stored bytes</html>').toString('base64'),
      }),
      events: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        sessionId: 'ses_1',
        status: 'ready',
        createdAt: '2026-08-23T10:00:00Z',
      }),
      listPages: vi
        .fn()
        .mockResolvedValue([{ pageId: 'pg_1', status: 'active', url: 'https://example.com/' }]),
      getPage: vi.fn().mockResolvedValue({ pageId: 'pg_1', status: 'active', url: '', title: '' }),
      closePage: vi.fn().mockResolvedValue(undefined),
      createPage: vi.fn().mockResolvedValue({ pageId: 'pg_1', sessionId: 'ses_1' }),
      navigate: vi.fn().mockResolvedValue({ status: 'success', url: 'https://example.com' }),
      observe: vi.fn().mockResolvedValue({
        sessionId: 'ses_1',
        pageId: 'pg_1',
        revision: 1,
        url: 'https://example.com',
        title: 'Example',
        status: 'interactive',
        elements: [],
        truncated: false,
        untrustedContent: false,
      }),
      snapshot: vi.fn().mockResolvedValue({
        url: 'https://example.com',
        mode: 'stable',
        revision: 7,
        fields: [{ ref: 'e7_0', role: 'button', label: 'Submit' }],
        truncated: false,
      }),
      plan: vi.fn().mockResolvedValue({ ok: true, completed: 0, results: [] }),
      outcome: vi.fn().mockResolvedValue({}),
      executeAction: vi.fn().mockResolvedValue({
        status: 'success',
        actionId: 'act_1',
        newRevision: 2,
      }),
      extract: vi.fn().mockResolvedValue({ data: { ok: true } }),
      screenshot: vi.fn().mockResolvedValue({
        artifactId: 'art_1',
        type: 'screenshot',
        contentType: 'image/png',
        sizeBytes: 2048,
        url: '/sessions/ses_1/artifacts/art_1',
      }),
      pdf: vi.fn().mockResolvedValue({
        artifactId: 'pdf_1',
        type: 'pdf',
        contentType: 'application/pdf',
        sizeBytes: 2048,
        url: '/v1/artifacts/pdf_1',
      }),
      download: vi.fn().mockResolvedValue({
        artifactId: 'dl_1',
        type: 'download',
        contentType: 'application/octet-stream',
        sizeBytes: 64,
        url: '/v1/artifacts/dl_1',
      }),
      collectDownload: vi.fn().mockResolvedValue({
        artifactId: 'dl_1',
        type: 'download',
        contentType: 'application/octet-stream',
        sizeBytes: 64,
        url: '/v1/artifacts/dl_1',
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
            elapsedMs: 12,
          })
        ),
      operation: vi.fn().mockResolvedValue({ operationId: 'op_1', state: 'recorded' }),
    };

    deps = {
      createClient: vi.fn().mockReturnValue({
        health: vi.fn().mockResolvedValue({ status: 'healthy', version: '1.8.18', uptime: 42 }),
        healthLive: vi.fn().mockResolvedValue({ status: 'live' }),
        healthReady: vi.fn().mockResolvedValue({ status: 'ready' }),
        sessions,
      }),
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    };
  });

  describe('delegated session plumbing', () => {
    it('session operation reads the recorded operation status as JSON', async () => {
      expect(await run('session', 'operation', 'ses_1', 'op_1')).toBe(0);
      expect(sessions.operation).toHaveBeenCalledWith('ses_1', 'op_1');
      expect(lastJson()).toEqual({ operationId: 'op_1', state: 'recorded' });
    });

    it('session operation refuses a client without the reconciliation surface', async () => {
      (deps.createClient as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => ({ sessions: {} }) as unknown as CliClient
      );
      expect(await run('session', 'operation', 'ses_1', 'op_1')).toBe(1);
      expect(err.join(' ')).toContain('operation reconciliation');
      expect(sessions.operation).not.toHaveBeenCalled();
    });

    it('session create forwards ttl, snapshot-timeout, allowed hosts and service workers', async () => {
      expect(
        await run(
          'session',
          'create',
          '--tenant',
          'tenant_1',
          '--ttl',
          '7200000',
          '--snapshot-timeout',
          '20000',
          '--allow-hosts',
          'a.test, b.test',
          '--allow-service-workers'
        )
      ).toBe(0);
      expect(sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant_1',
          ttlMs: 7_200_000,
          snapshotTimeoutMs: 20_000,
          policy: { allowedHosts: ['a.test', 'b.test'], allowServiceWorkers: true },
        })
      );
    });

    it('session create surfaces the raw service error when no cookie file is involved', async () => {
      sessions.create.mockRejectedValueOnce(new Error('quota exceeded'));
      expect(await run('session', 'create', '--tenant', 'tenant_1')).toBe(1);
      expect(err.join(' ')).toContain('quota exceeded');
    });

    it('session cookies surfaces the raw export error when printing inline', async () => {
      sessions.cookies.mockRejectedValueOnce(new Error('export blew up'));
      expect(await run('session', 'cookies', 'ses_1')).toBe(1);
      expect(err.join(' ')).toContain('export blew up');
      expect(out).toEqual([]);
    });
  });

  describe('page evidence', () => {
    it('page list reports an empty page list', async () => {
      sessions.listPages.mockResolvedValueOnce([]);
      expect(await run('page', 'list', 'ses_1')).toBe(0);
      expect(out).toEqual(['No pages']);
    });

    it('page html falls back to the artifact descriptor when no bytes are available', async () => {
      sessions.html.mockResolvedValueOnce({
        artifactId: 'html_3',
        type: 'html',
        contentType: 'text/html; charset=utf-8',
        sizeBytes: 1234,
      });
      sessions.artifact.mockResolvedValueOnce({ metadata: { artifactId: 'html_3' } });
      expect(await run('page', 'html', 'ses_1', 'pg_1')).toBe(0);
      expect(sessions.artifact).toHaveBeenCalledWith('ses_1', 'html_3');
      expect(out.join('\n')).toContain('HTML artifact html_3');
      expect(out.join('\n')).toContain('1234 bytes');
      expect(out.join('\n')).not.toContain('stored bytes');
    });
  });

  describe('observation bounds and rendering', () => {
    it('observe forwards --max-bytes', async () => {
      await run('observe', 'ses_1', 'pg_1', '--max-bytes', '512');
      expect(sessions.observe).toHaveBeenCalledWith('ses_1', 'pg_1', { maxBytes: 512 });
    });

    it('observe renders values, markers and the truncation note', async () => {
      sessions.observe.mockResolvedValueOnce({
        sessionId: 'ses_1',
        pageId: 'pg_1',
        revision: 3,
        url: 'https://example.com',
        title: 'Form',
        status: 'interactive',
        summary: 'complex form',
        elements: [
          {
            ref: 'e3_0',
            role: 'textbox',
            name: 'Email',
            value: 'agent@example.com',
            enabled: false,
            visible: false,
          },
        ],
        truncated: true,
        untrustedContent: true,
      });
      expect(await run('observe', 'ses_1', 'pg_1')).toBe(0);
      const text = out.join('\n');
      expect(text).toContain('= "agent@example.com"');
      expect(text).toContain('[disabled]');
      expect(text).toContain('[hidden]');
      expect(text).toContain('Observation truncated.');
    });
  });

  describe('snapshot command', () => {
    it('forwards bounds and renders the field list', async () => {
      expect(
        await run('snapshot', 'ses_1', 'pg_1', '--max-elements', '10', '--max-bytes', '2048')
      ).toBe(0);
      expect(sessions.snapshot).toHaveBeenCalledWith('ses_1', 'pg_1', {
        maxElements: 10,
        maxBytes: 2048,
      });
      expect(out).toEqual(['https://example.com (stable, revision 7)', '  e7_0 [button] Submit']);
    });

    it('marks a truncated snapshot and tolerates empty bounds', async () => {
      sessions.snapshot.mockResolvedValueOnce({
        url: 'https://example.com/x',
        mode: 'verified',
        revision: 8,
        fields: [],
        truncated: true,
      });
      expect(await run('snapshot', 'ses_1', 'pg_1')).toBe(0);
      expect(sessions.snapshot).toHaveBeenCalledWith('ses_1', 'pg_1', {});
      expect(out[0]).toBe('https://example.com/x (verified, revision 8)');
      expect(out).toContain('  (truncated)');
    });
  });

  describe('plan and outcome text rendering', () => {
    it('plan renders per-step lines in text mode, including a plan-level error', async () => {
      sessions.plan.mockResolvedValueOnce({
        ok: true,
        completed: 1,
        results: [{ step: 0, ok: true }],
        mode: 'verified',
      });
      expect(await run('plan', 'ses_1', 'pg_1', '[{"action":"press","key":"Tab"}]')).toBe(0);
      expect(out).toEqual(['ok: 1/1 steps completed (mode: verified)', '  step 0: ok']);

      sessions.plan.mockResolvedValueOnce({
        ok: false,
        completed: 0,
        results: [{ step: 0, ok: false, error: 'denied' }],
        error: { code: 'PLAN_ABORTED', message: 'step 0 failed' },
      });
      out = [];
      expect(await run('plan', 'ses_1', 'pg_1', '[{"action":"press","key":"Tab"}]')).toBe(1);
      expect(out).toEqual([
        'failed: 0/1 steps completed (mode: stable)',
        '  step 0: FAILED - denied',
        '  PLAN_ABORTED: step 0 failed',
      ]);
    });

    it('outcome renders the execution summary in text mode', async () => {
      sessions.outcome = vi.fn().mockResolvedValue({
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
      });
      const request = {
        actions: [{ action: 'press', key: 'Tab' }],
        verification: {
          verifier: { id: 'fixture.saved', version: '1' },
          input: { expected: true },
        },
      };
      expect(await run('outcome', 'ses_1', 'pg_1', JSON.stringify(request))).toBe(0);
      expect(out).toEqual([
        'execution: completed; verification: passed; cleanup: not_needed',
        'plan: 1/1 steps completed',
        'evidence: receipt_1',
      ]);
    });
  });

  describe('act vocabulary', () => {
    it.each([
      ['dblclick', { action: 'dblclick', target: { ref: 'e1_0' } }],
      ['hover', { action: 'hover', target: { ref: 'e1_0' } }],
      ['clear', { action: 'clear', target: { ref: 'e1_0' } }],
      ['check', { action: 'check', target: { ref: 'e1_0' } }],
      ['uncheck', { action: 'uncheck', target: { ref: 'e1_0' } }],
    ] as const)('act %s targets the ref', async (command, expected) => {
      expect(await run('act', command, 'ses_1', 'pg_1', 'e1_0')).toBe(0);
      expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', expected);
      expect(out.join('\n')).toContain(`${expected.action} e1_0: success`);
    });

    it('act wait forwards the condition with and without a timeout', async () => {
      expect(await run('act', 'wait', 'ses_1', 'pg_1', 'networkidle', '--timeout-ms', '5000')).toBe(
        0
      );
      expect(sessions.executeAction).toHaveBeenLastCalledWith('ses_1', 'pg_1', {
        action: 'wait',
        condition: { until: 'networkidle', timeoutMs: 5000 },
      });
      expect(await run('act', 'wait', 'ses_1', 'pg_1', 'settled')).toBe(0);
      expect(sessions.executeAction).toHaveBeenLastCalledWith('ses_1', 'pg_1', {
        action: 'wait',
        condition: { until: 'settled' },
      });
    });

    it.each([
      ['goBack', { action: 'goBack' }],
      ['goForward', { action: 'goForward' }],
      ['reload', { action: 'reload' }],
      ['dismissDialog', { action: 'dismissDialog' }],
    ] as const)('act %s dispatches untargeted', async (command, expected) => {
      expect(await run('act', command, 'ses_1', 'pg_1')).toBe(0);
      expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', expected);
    });

    it('act acceptDialog dispatches with and without a prompt answer', async () => {
      expect(await run('act', 'acceptDialog', 'ses_1', 'pg_1', 'yes')).toBe(0);
      expect(sessions.executeAction).toHaveBeenLastCalledWith('ses_1', 'pg_1', {
        action: 'acceptDialog',
        promptText: 'yes',
      });
      expect(await run('act', 'acceptDialog', 'ses_1', 'pg_1')).toBe(0);
      expect(sessions.executeAction).toHaveBeenLastCalledWith('ses_1', 'pg_1', {
        action: 'acceptDialog',
      });
    });

    it('act type-text types keystrokes with a validated delay', async () => {
      expect(await run('act', 'type-text', 'ses_1', 'pg_1', 'hello')).toBe(0);
      expect(sessions.executeAction).toHaveBeenLastCalledWith('ses_1', 'pg_1', {
        action: 'typeText',
        value: 'hello',
      });
      expect(await run('act', 'type-text', 'ses_1', 'pg_1', 'hi', '--delay', '50')).toBe(0);
      expect(sessions.executeAction).toHaveBeenLastCalledWith('ses_1', 'pg_1', {
        action: 'typeText',
        value: 'hi',
        delay: 50,
      });
      expect(await run('act', 'type-text', 'ses_1', 'pg_1', 'hi', '--delay', '2000')).toBe(1);
      expect(err.join(' ')).toContain('--delay must be an integer between 0 and 1000');
      expect(sessions.executeAction).toHaveBeenCalledTimes(2);
    });

    it('act press repeats a key when a count is given', async () => {
      expect(await run('act', 'press', 'ses_1', 'pg_1', 'Enter', '--count', '3')).toBe(0);
      expect(sessions.executeAction).toHaveBeenLastCalledWith('ses_1', 'pg_1', {
        action: 'press',
        key: 'Enter',
        count: 3,
      });
      expect(await run('act', 'press', 'ses_1', 'pg_1', 'Escape')).toBe(0);
      expect(sessions.executeAction).toHaveBeenLastCalledWith('ses_1', 'pg_1', {
        action: 'press',
        key: 'Escape',
      });
    });

    it('act scroll forwards the parsed amount', async () => {
      expect(await run('act', 'scroll', 'ses_1', 'pg_1', 'down', '500')).toBe(0);
      expect(sessions.executeAction).toHaveBeenCalledWith('ses_1', 'pg_1', {
        action: 'scroll',
        direction: 'down',
        amount: 500,
      });
    });

    it('rejects actions the wire vocabulary refuses, before dispatch', async () => {
      expect(await run('act', 'wait', 'ses_1', 'pg_1', 'bogus')).toBe(1);
      expect(err.join(' ')).toContain('Invalid action');
      expect(sessions.executeAction).not.toHaveBeenCalled();
      err = [];
      expect(await run('act', 'scroll', 'ses_1', 'pg_1', 'up', 'abc')).toBe(1);
      expect(err.join(' ')).toContain('Invalid action');
      expect(sessions.executeAction).not.toHaveBeenCalled();
    });
  });

  describe('extraction and capture', () => {
    it('extract forwards an inline --schema payload', async () => {
      const schema = JSON.stringify({ properties: { price: { type: 'string' } } });
      expect(await run('extract', 'ses_1', 'pg_1', '--format', 'schema', '--schema', schema)).toBe(
        0
      );
      expect(sessions.extract).toHaveBeenCalledWith('ses_1', 'pg_1', {
        format: 'schema',
        schema: { properties: { price: { type: 'string' } } },
      });
    });

    it('screenshot forwards quality and mask-sensitive options', async () => {
      await run('screenshot', 'ses_1', 'pg_1', '--quality', '80', '--mask-sensitive');
      expect(sessions.screenshot).toHaveBeenCalledWith('ses_1', 'pg_1', {
        quality: 80,
        maskSensitive: true,
      });
    });

    it('screenshot --out saves the fetched artifact bytes', async () => {
      const file = tempFile('shot.png');
      expect(await run('screenshot', 'ses_1', 'pg_1', '--out', file)).toBe(0);
      expect(sessions.artifact).toHaveBeenCalledWith('ses_1', 'art_1');
      expect(out.join('\n')).toContain(`Saved art_1 to ${file}`);
      expect(readFileSync(file, 'utf8')).toBe('<html>stored bytes</html>');
    });

    it('pdf forwards every print option and saves bytes with --out', async () => {
      const file = tempFile('doc.pdf');
      expect(
        await run(
          'pdf',
          'ses_1',
          'pg_1',
          '--landscape',
          '--display-header-footer',
          '--print-background',
          '--out',
          file
        )
      ).toBe(0);
      expect(sessions.pdf).toHaveBeenCalledWith('ses_1', 'pg_1', {
        landscape: true,
        displayHeaderFooter: true,
        printBackground: true,
      });
      expect(out.join('\n')).toContain('Saved pdf_1');
    });

    it('download saves artifact bytes with --out and collect renders its descriptor', async () => {
      const first = tempFile('f.zip');
      expect(
        await run('download', 'ses_1', 'pg_1', 'https://example.com/f.zip', '--out', first)
      ).toBe(0);
      expect(sessions.download).toHaveBeenCalledWith('ses_1', 'pg_1', {
        url: 'https://example.com/f.zip',
      });
      expect(out.join('\n')).toContain('Saved dl_1');
      out = [];
      expect(await run('download', 'collect', 'ses_1', 'pg_1', 'dl_capture_1')).toBe(0);
      expect(sessions.collectDownload).toHaveBeenCalledWith('ses_1', 'pg_1', 'dl_capture_1');
      expect(out).toEqual(['Download dl_1', '  bytes: 64']);
    });

    it.each(['parent', 'child'])(
      'collect saves artifact bytes with %s-position --out',
      async (position) => {
        const file = tempFile('collected.zip');
        const args =
          position === 'parent'
            ? ['download', '--out', file, 'collect', 'ses_1', 'pg_1', 'dl_capture_1']
            : ['download', 'collect', 'ses_1', 'pg_1', 'dl_capture_1', '--out', file];
        expect(await run(...args)).toBe(0);
        expect(sessions.collectDownload).toHaveBeenCalledWith('ses_1', 'pg_1', 'dl_capture_1');
        expect(sessions.download).not.toHaveBeenCalled();
        expect(sessions.artifact).toHaveBeenCalledWith('ses_1', 'dl_1');
        expect(readFileSync(file, 'utf8')).toBe('<html>stored bytes</html>');
        expect(out.join('\n')).toContain(`Saved dl_1 to ${file}`);
      }
    );

    it('collect with --out fails without writing when artifact bytes are unavailable', async () => {
      const file = tempFile('missing.zip');
      sessions.artifact.mockResolvedValueOnce({ metadata: { artifactId: 'dl_1' } });
      expect(await run('download', 'collect', 'ses_1', 'pg_1', 'dl_capture_1', '--out', file)).toBe(
        1
      );
      expect(err.join(' ')).toContain('dl_1 has no inline content');
      expect(existsSync(file)).toBe(false);
      expect(out.join('\n')).not.toContain('Saved dl_1');
    });

    it('saving an expired screenshot artifact fails without writing a file', async () => {
      sessions.artifact.mockResolvedValueOnce({ metadata: { artifactId: 'art_1' } });
      expect(await run('screenshot', 'ses_1', 'pg_1', '--out', tempFile('x.png'))).toBe(1);
      expect(err.join(' ')).toContain('art_1 has no inline content');
      expect(out.join('\n')).not.toContain('Saved art_1');
    });
  });

  describe('artifact and health surfaces', () => {
    it('artifact get renders metadata inline by default', async () => {
      expect(await run('artifact', 'get', 'ses_1', 'art_1')).toBe(0);
      expect(out.join('\n')).toContain('Artifact art_1');
    });

    it('artifact get --out refuses an artifact without inline content', async () => {
      sessions.artifact.mockResolvedValueOnce({ metadata: { artifactId: 'art_x' } });
      expect(await run('artifact', 'get', 'ses_1', 'art_x', '--out', tempFile('y.bin'))).toBe(1);
      expect(err.join(' ')).toContain('no inline content');
      expect(out).toEqual([]);
    });

    it('health refuses contradictory probes before calling the service', async () => {
      expect(await run('health', '--ready', '--live')).toBe(1);
      expect(err.join(' ')).toContain('mutually exclusive');
    });
  });

  describe('autofill input and report edges', () => {
    it('autofill refuses a non-object payload before dispatch', async () => {
      expect(await run('autofill', 'ses_1', 'pg_1', '[]')).toBe(1);
      expect(err.join(' ')).toContain('must be an object');
      expect(sessions.autofill).not.toHaveBeenCalled();
    });

    it('autofill renders a snapshot error line alongside the receipts', async () => {
      sessions.autofill.mockResolvedValueOnce({
        ok: true,
        receipts: [
          {
            field: 0,
            match: { label: 'A' },
            status: 'verified',
            verified: true,
            resolvedRef: 'e1_2',
          },
        ],
        elapsedMs: 5,
        snapshotError: 'SNAPSHOT_TIMEOUT: page too busy',
      });
      expect(
        await run(
          'autofill',
          'ses_1',
          'pg_1',
          JSON.stringify({ fields: [{ match: { label: 'A' }, value: 'x' }] })
        )
      ).toBe(0);
      expect(out.join('\n')).toContain('snapshot error: SNAPSHOT_TIMEOUT: page too busy');
      expect(out.join('\n')).toContain('1/1 fields verified');
    });
  });

  describe('cookie plumbing edges', () => {
    it('assertCookieRequestSize refuses unserializable requests', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => assertCookieRequestSize(circular)).toThrow('not serializable');
    });

    it('parseCookieText rejects an unparseable numeric expiry', () => {
      const digits = '9'.repeat(400);
      const row = `.example.com\tTRUE\t/\tFALSE\t${digits}\tsid\tv`;
      expect(() => parseCookieText(row, 'netscape')).toThrow('invalid expiry');
    });
  });

  describe('package entry point', () => {
    it('re-exports the CLI factory', async () => {
      const entry = await import('./index.js');
      expect(typeof entry.buildCli).toBe('function');
      const cli = entry.buildCli(deps);
      expect(await cli.run(['--version'])).toBe(0);
      expect(out).toEqual([PRODUCT_VERSION]);
    });
  });
});
