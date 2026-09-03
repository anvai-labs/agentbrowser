/**
 * TDD Tests for the AgentBrowser CLI
 *
 * The CLI is built as a factory over injected dependencies so the command
 * surface can be exercised without spawning a process or hitting a server.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCli } from './cli';
import type { CliDependencies } from './cli';

describe('AgentBrowser CLI', () => {
  let out: string[];
  let err: string[];
  let sessions: Record<string, ReturnType<typeof vi.fn>>;
  let deps: CliDependencies;

  /** Run the CLI with user-style argv and return the exit code. */
  const run = (...argv: string[]) => buildCli(deps).run(argv);

  const lastJson = () => JSON.parse(out.join('\n'));

  beforeEach(() => {
    out = [];
    err = [];

    sessions = {
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
      createClient: vi.fn().mockReturnValue({ sessions }),
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    };
  });

  describe('session commands', () => {
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
      expect(sessions.createPage).toHaveBeenCalledWith('ses_1');
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

    it('should warn that page content is untrusted', async () => {
      await run('observe', 'ses_1', 'pg_1');

      expect(out.join('\n').toLowerCase()).toContain('untrusted');
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
    it('should default to the local server', async () => {
      await run('session', 'list');

      expect(deps.createClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://localhost:3000' })
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
});
