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

/** Run `body` with the ambient stamp forced to `value`, restoring afterwards. */
function withAmbientStamp(value: string | undefined, body: () => void): void {
  const stamped = process.env.AGENTBROWSER_MCP_VERSION;
  if (value === undefined) Reflect.deleteProperty(process.env, 'AGENTBROWSER_MCP_VERSION');
  else process.env.AGENTBROWSER_MCP_VERSION = value;
  try {
    body();
  } finally {
    if (stamped === undefined) Reflect.deleteProperty(process.env, 'AGENTBROWSER_MCP_VERSION');
    else process.env.AGENTBROWSER_MCP_VERSION = stamped;
  }
}

describe('resolveVersion unstamped-binary fallback', () => {
  it('reports unknown when neither a stamp nor a package file is available', () => {
    withAmbientStamp(undefined, () => {
      expect(resolveVersion({})).toBe('unknown');
    });
  });

  it('uses the injected stamp when no ambient stamp exists', () => {
    withAmbientStamp(undefined, () => {
      expect(resolveVersion({ AGENTBROWSER_MCP_VERSION: '0.0.0-stamp' })).toBe('0.0.0-stamp');
    });
  });

  it('the ambient process.env stamp wins over an injected one (it is the compile-time stamp surrogate)', () => {
    withAmbientStamp('0.9.9-ambient', () => {
      expect(resolveVersion({ AGENTBROWSER_MCP_VERSION: '0.0.0-stamp' })).toBe('0.9.9-ambient');
    });
  });
});
