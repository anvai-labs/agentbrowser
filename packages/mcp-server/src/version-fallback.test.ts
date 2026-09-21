/**
 * The unstamped-binary fallback of version resolution (TD-BROWSER-5): with
 * no build stamp and no readable package.json, the honest answer is
 * 'unknown'. The filesystem is mocked out so the package file lookup fails
 * the way it does in the compiled binary.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveVersion } from './version.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('ENOENT: no package.json in the bundled binary');
  }),
}));

describe('resolveVersion unstamped-binary fallback', () => {
  it('reports unknown when neither a stamp nor a package file is available', () => {
    const stamped = process.env.AGENTBROWSER_MCP_VERSION;
    Reflect.deleteProperty(process.env, 'AGENTBROWSER_MCP_VERSION');
    try {
      expect(resolveVersion({})).toBe('unknown');
    } finally {
      if (stamped !== undefined) process.env.AGENTBROWSER_MCP_VERSION = stamped;
    }
  });

  it('still prefers an explicit environment stamp over the fallback', () => {
    expect(resolveVersion({ AGENTBROWSER_MCP_VERSION: '0.0.0-stamp' })).toBe('0.0.0-stamp');
  });
});
