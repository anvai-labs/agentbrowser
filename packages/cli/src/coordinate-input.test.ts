import { expect, it, vi } from 'vitest';
import type { CliClient } from './cli.js';
import { buildCapturedCli } from './test-support/captured-cli.js';

function fixture() {
  const executeAction = vi.fn(async () => ({
    status: 'success',
    newRevision: 1,
    result: { dispatched: true, visibleEffect: 'none' },
  }));
  return {
    ...buildCapturedCli(() => ({ sessions: { executeAction } }) as unknown as CliClient),
    executeAction,
  };
}
it('sends explicit CSS/image coordinates through /act and makes an ineffective dispatched click loud', async () => {
  const f = fixture();
  expect(await f.cli.run(['act', 'click', 's', 'p', '--at', '10,20'])).toBe(0);
  expect(f.executeAction).toHaveBeenLastCalledWith('s', 'p', {
    action: 'clickAt',
    at: { unit: 'css', x: 10, y: 20 },
  });
  expect(f.out.join('\n')).toContain('WARNING: No visible effect');
  expect(
    await f.cli.run([
      'act',
      'click',
      's',
      'p',
      '--at',
      '20,40',
      '--capture',
      'capture-1',
      '--image-size',
      '1600,1200',
    ])
  ).toBe(0);
  expect(f.executeAction).toHaveBeenLastCalledWith('s', 'p', {
    action: 'clickAt',
    at: {
      unit: 'image',
      x: 20,
      y: 40,
      captureId: 'capture-1',
      rasterWidth: 1600,
      rasterHeight: 1200,
    },
  });
});
it.each([
  ['act', 'click', 's', 'p', 'e1_0', '--at', '10,20'],
  ['act', 'click', 's', 'p', '--at', 'NaN,2'],
  ['act', 'click', 's', 'p', '--at', '10,20', '--capture', 'c'],
  ['act', 'click', 's', 'p', '--capture', 'c', '--image-size', '10,20'],
  ['act', 'upload', 's', 'p', '/private/tmp/proof.txt', '--at', '10,20'],
])('refuses ambiguous, malformed or unverified input before network: %j', async (...argv) => {
  const f = fixture();
  expect(await f.cli.run(argv)).not.toBe(0);
  expect(f.executeAction).not.toHaveBeenCalled();
});
it('requires one integrity-bound file for coordinate chooser attachment', async () => {
  const f = fixture();
  const sha256 = 'a'.repeat(64);
  expect(
    await f.cli.run([
      'act',
      'upload',
      's',
      'p',
      '/private/tmp/proof.txt',
      '--at',
      '10,20',
      '--sha256',
      sha256,
    ])
  ).toBe(0);
  expect(f.executeAction).toHaveBeenLastCalledWith('s', 'p', {
    action: 'uploadAt',
    at: { unit: 'css', x: 10, y: 20 },
    paths: ['/private/tmp/proof.txt'],
    sha256,
  });
});
