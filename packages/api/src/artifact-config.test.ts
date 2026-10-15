import { expect, it } from 'vitest';
import { artifactStoreFromEnvironment } from './artifact-config.js';

it('keeps the store default when unset and accepts an operator ceiling', () => {
  expect(artifactStoreFromEnvironment({})).toBeUndefined();
  const store = artifactStoreFromEnvironment({
    AGENTBROWSER_ARTIFACT_MAX_TOTAL_BYTES: ' 20971520 ',
  });
  expect(store).toBeDefined();
  // 20 MiB holds two max-size artifacts; a third evicts the first.
  const big = new Uint8Array(10 * 1024 * 1024);
  const first = store?.put('download', 'application/octet-stream', big);
  store?.put('download', 'application/octet-stream', big);
  store?.put('download', 'application/octet-stream', big);
  expect(first && store?.get(first.artifactId)).toBeUndefined();
  expect(store?.totalBytes()).toBe(2 * big.length);
});

it.each(['', ' ', '0', '-1', '1.5', '4KB', '1e9', '0x1000', '1024', '9007199254740992'])(
  'fails closed on invalid startup configuration %s',
  (raw) => {
    expect(() =>
      artifactStoreFromEnvironment({ AGENTBROWSER_ARTIFACT_MAX_TOTAL_BYTES: raw })
    ).toThrow('AGENTBROWSER_ARTIFACT_MAX_TOTAL_BYTES');
  }
);
