import { describe, expect, it } from 'vitest';
import { PRODUCT_VERSION } from './product-version.js';
import { parseLogLevel, parseServerArgs, SERVER_HELP } from './server-args.js';

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
    expect(SERVER_HELP).toMatch(/AGENTBROWSER_LOG_LEVEL\s+debug, info \(default\), warn or error/);
    expect(SERVER_HELP).toContain(PRODUCT_VERSION);
  });
});

describe('parseLogLevel', () => {
  it('defaults to info when unset or blank', () => {
    expect(parseLogLevel(undefined)).toEqual({ level: 'info' });
    expect(parseLogLevel('  ')).toEqual({ level: 'info' });
  });

  it('accepts every level the structured logger supports, case-insensitively', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      expect(parseLogLevel(level)).toEqual({ level });
      expect(parseLogLevel(` ${level.toUpperCase()} `)).toEqual({ level });
    }
  });

  it('falls back to info loudly on an unknown value instead of guessing', () => {
    const parsed = parseLogLevel('verbose');
    expect(parsed.level).toBe('info');
    expect(parsed.warning).toContain('AGENTBROWSER_LOG_LEVEL="verbose"');
    expect(parsed.warning).toContain('debug, info, warn, error');
  });
});
