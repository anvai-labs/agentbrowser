import { DEFAULT_EXTRACT_MAX_BYTES } from '@agentbrowser/protocol';
import { expect, it } from 'vitest';
import { extractMaxBytesFromEnvironment } from './extraction-config.js';

it('defaults to 1 MiB and accepts an operator-supplied decimal ceiling', () => {
  expect(extractMaxBytesFromEnvironment({})).toBe(DEFAULT_EXTRACT_MAX_BYTES);
  expect(DEFAULT_EXTRACT_MAX_BYTES).toBe(1048576);
  expect(extractMaxBytesFromEnvironment({ AGENTBROWSER_EXTRACT_MAX_BYTES: ' 2097152 ' })).toBe(
    2097152
  );
});

it.each(['', ' ', '0', '-1', '1.5', '4KB', '1e6', '0x1000', 'Infinity', '9007199254740992'])(
  'fails closed on invalid startup configuration %s',
  (raw) => {
    expect(() => extractMaxBytesFromEnvironment({ AGENTBROWSER_EXTRACT_MAX_BYTES: raw })).toThrow(
      'AGENTBROWSER_EXTRACT_MAX_BYTES'
    );
  }
);
