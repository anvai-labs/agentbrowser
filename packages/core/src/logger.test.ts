/**
 * TDD Tests for structured logging (TD-021)
 *
 * JSON lines with level, message and merged context; secrets never reach a
 * sink; levels filter output.
 */

import { describe, expect, it } from 'vitest';
import { StructuredLogger } from './logger';
import { SecretManager } from './secret-manager';

/** Collect log lines instead of writing to the console. */
function collectingLogger(options: ConstructorParameters<typeof StructuredLogger>[0] = {}) {
  const lines: string[] = [];
  const logger = new StructuredLogger({
    sink: (line: string) => lines.push(line),
    ...options,
  });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

describe('StructuredLogger', () => {
  it('should emit JSON lines with level and message', () => {
    const { logger, lines } = collectingLogger();
    logger.info('session created');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0] as string);
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('session created');
    expect(typeof entry.timestamp).toBe('string');
  });

  it('should merge structured fields into entries', () => {
    const { logger, parsed } = collectingLogger();
    logger.info('navigate', { sessionId: 'ses_1', url: 'https://example.com' });

    const [entry] = parsed();
    expect(entry.sessionId).toBe('ses_1');
    expect(entry.url).toBe('https://example.com');
  });

  it('should carry child context into subsequent entries', () => {
    const { logger, parsed } = collectingLogger();
    const session = logger.child({ sessionId: 'ses_1' });
    session.info('page created');

    const [entry] = parsed();
    expect(entry.sessionId).toBe('ses_1');
    expect(entry.message).toBe('page created');
  });

  it('should filter below the configured level', () => {
    const { logger, lines } = collectingLogger({ level: 'warn' });
    logger.debug('noisy detail');
    logger.info('normal info');
    logger.warn('actionable');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).level).toBe('warn');
  });

  it('should redact secrets before anything reaches the sink', () => {
    const { logger, lines } = collectingLogger({
      secretManager: new SecretManager({ 'vault://p': 'swordfish' }),
    });
    logger.info('fill', { value: 'swordfish', note: 'password=swordfish' });

    const serialized = lines.join('\n');
    expect(serialized).not.toContain('swordfish');
    expect(serialized).toContain('***');
  });
});
