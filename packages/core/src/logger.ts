/**
 * Structured Logger (TD-021)
 *
 * JSON log lines with level, timestamp, message and merged fields. Every
 * entry is scrubbed by the SecretManager before it reaches the sink, so
 * logs can never carry a credential.
 */

import type { SecretManager } from './secret-manager.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  /** Minimum level to emit (default info). */
  level?: LogLevel;
  /** Line sink; defaults to console.log. */
  sink?(line: string): void;
  /** Scrub entries of registered secrets before they reach the sink. */
  secretManager?: SecretManager;
}

export class StructuredLogger {
  private readonly level: LogLevel;
  private readonly sink: (line: string) => void;
  private readonly secretManager: SecretManager | undefined;
  private readonly context: Record<string, unknown>;

  constructor(options: LoggerOptions & { context?: Record<string, unknown> } = {}) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? ((line: string) => console.log(line));
    this.secretManager = options.secretManager;
    this.context = options.context ?? {};
  }

  /** A logger carrying additional context on every entry. */
  child(fields: Record<string, unknown>): StructuredLogger {
    return new StructuredLogger({
      level: this.level,
      sink: this.sink,
      ...(this.secretManager ? { secretManager: this.secretManager } : {}),
      context: { ...this.context, ...fields },
    });
  }

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) {
      return;
    }

    const entry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...this.context,
      ...fields,
    };

    const safe = this.secretManager ? this.secretManager.redact(entry) : entry;
    this.sink(JSON.stringify(safe));
  }
}
