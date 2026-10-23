/**
 * Command-line surface of the server entrypoint. Configuration is
 * environment-only (operator startup settings, see docs/operations.md); argv
 * carries just --help and --version. Kept dependency-free so bin.ts can answer
 * them before the engine graph (Playwright) loads — a broken or absent browser
 * install must never stop `agentbrowser-server --help` from working.
 */
import { PRODUCT_VERSION } from './product-version.js';

export type ServerArgs =
  | { kind: 'run' }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'policy-export' }
  | { kind: 'error'; message: string };

export const SERVER_HELP = `agentbrowser-server ${PRODUCT_VERSION}
Agent-native browser service: REST + WebSocket API for AgentBrowser clients.

Usage:
  agentbrowser-server            start the service
  agentbrowser-server policy export
                                write the policy document for today's
                                environment configuration to stdout
  agentbrowser-server --help     show this help
  agentbrowser-server --version  print the version

Configuration is read from the environment:
  HOST                                  listen address (default 127.0.0.1)
  PORT                                  listen port (default 5709)
  AGENTBROWSER_API_KEYS                 key:tenant[,key:tenant] bearer keys; unset = local no-keys mode
  AGENTBROWSER_ALLOWED_HOSTS            extra trusted Host names (default: loopback only without keys)
  AGENTBROWSER_CORS_ORIGINS             exact browser origins allowed to call the API
  AGENTBROWSER_LOG_LEVEL                debug, info (default), warn or error
  AGENTBROWSER_DEFAULT_TTL_MS           default session lifetime in ms
  AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS  default session idle timeout in ms
  AGENTBROWSER_SHUTDOWN_ON_STDIN_EOF    1 = stop when stdin closes (launcher lifeline)
  PLAYWRIGHT_BROWSERS_PATH              where Playwright's Chromium is installed

All settings: https://anvai-labs.github.io/agentbrowser/operations/
`;

export function parseServerArgs(argv: readonly string[]): ServerArgs {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  if (argv.includes('--version') || argv.includes('-v')) return { kind: 'version' };
  if (argv[0] === 'policy') {
    if (argv[1] === 'export' && argv.length === 2) return { kind: 'policy-export' };
    return {
      kind: 'error',
      message:
        "agentbrowser-server: usage: agentbrowser-server policy export. Writes the policy document for today's environment configuration to stdout.",
    };
  }
  const unknown = argv[0];
  if (unknown !== undefined) {
    return {
      kind: 'error',
      message: `agentbrowser-server: unknown argument '${unknown}'. The service is configured through environment variables (HOST, PORT, ...); run agentbrowser-server --help.`,
    };
  }
  return { kind: 'run' };
}

/** The structured logger's levels (packages/core/src/logger.ts), lowest first. */
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type ServerLogLevel = (typeof LOG_LEVELS)[number];

/**
 * Parse AGENTBROWSER_LOG_LEVEL. Unset or blank means info; an unknown value
 * also means info, with a warning the caller prints, never a silent guess.
 */
export function parseLogLevel(raw: string | undefined): {
  level: ServerLogLevel;
  warning?: string;
} {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '') return { level: 'info' };
  const known = LOG_LEVELS.find((level) => level === value);
  if (known !== undefined) return { level: known };
  return {
    level: 'info',
    warning: `[agentbrowser] Ignoring AGENTBROWSER_LOG_LEVEL="${raw}" - expected one of ${LOG_LEVELS.join(', ')}; using info.`,
  };
}
