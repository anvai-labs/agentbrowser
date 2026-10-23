import type { Readable } from 'node:stream';
import { vi } from 'vitest';
import { buildCapturedCli } from './captured-cli.js';

/**
 * The offline-command suites' harness (form-prepare, test-evaluate): the CLI over
 * captured stdio, an optional stdin, and a createClient spy that must NEVER be
 * called — constructing a client would mean the command went online.
 */
export function offlineCliHarness(stdin?: Readable) {
  const createClient = vi.fn(() => {
    throw new Error('Offline command constructed a client');
  });
  return { ...buildCapturedCli(createClient, stdin), createClient };
}
