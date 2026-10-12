import { describe, expect, it } from 'vitest';
import { PRODUCT_VERSION } from './product-version.js';
import { SERVER_HELP, parseServerArgs } from './server-args.js';

describe('parseServerArgs', () => {
  it('runs the server when no arguments are given (Docker, brew services, SDK)', () => {
    expect(parseServerArgs([])).toEqual({ kind: 'run' });
  });

  it('answers --help and -h without running', () => {
    for (const flag of ['--help', '-h']) {
      expect(parseServerArgs([flag])).toEqual({ kind: 'help' });
    }
  });

  it('answers --version and -v without running', () => {
    for (const flag of ['--version', '-v']) {
      expect(parseServerArgs([flag])).toEqual({ kind: 'version' });
    }
  });

  it('lets --help win over other flags', () => {
    expect(parseServerArgs(['--version', '--help'])).toEqual({ kind: 'help' });
  });

  it('rejects unknown arguments instead of silently starting a server', () => {
    const parsed = parseServerArgs(['--port', '9000']);
    expect(parsed.kind).toBe('error');
    if (parsed.kind === 'error') {
      expect(parsed.message).toContain("unknown argument '--port'");
      expect(parsed.message).toContain('PORT');
    }
  });
});

describe('SERVER_HELP', () => {
  it('documents configuration through the environment, not flags', () => {
    for (const name of [
      'HOST',
      'PORT',
      'AGENTBROWSER_API_KEYS',
      'AGENTBROWSER_ALLOWED_HOSTS',
      'AGENTBROWSER_CORS_ORIGINS',
      'AGENTBROWSER_LOG_LEVEL',
      'AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF',
    ]) {
      expect(SERVER_HELP).toContain(name);
    }
    expect(SERVER_HELP).toContain(PRODUCT_VERSION);
  });
});
