import { describe, expect, it } from 'vitest';
import { detectDisplayAvailability } from './display';

describe('detectDisplayAvailability', () => {
  it('linux: available when DISPLAY is set', () => {
    expect(detectDisplayAvailability({ DISPLAY: ':0' }, 'linux')).toEqual({ available: true });
  });

  it('linux: available when only WAYLAND_DISPLAY is set', () => {
    expect(detectDisplayAvailability({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toEqual({
      available: true,
    });
  });

  it('linux: unavailable with no display env', () => {
    const result = detectDisplayAvailability({}, 'linux');
    expect(result.available).toBe(false);
    expect(result.reason).toBe('no-x11-or-wayland-display');
  });

  it('macos: a launchd label alone does not prove the absence of a GUI session', () => {
    const result = detectDisplayAvailability(
      { XPC_SERVICE_NAME: 'sh.brew.agentbrowser' },
      'darwin'
    );
    expect(result.available).toBe(true);
  });

  it('macos: available from an interactive shell (XPC_SERVICE_NAME=0)', () => {
    expect(detectDisplayAvailability({ XPC_SERVICE_NAME: '0' }, 'darwin')).toEqual({
      available: true,
    });
  });

  it('macos: AGENTBROWSER_ASSUME_DISPLAY=1 overrides daemon detection', () => {
    expect(
      detectDisplayAvailability(
        { XPC_SERVICE_NAME: 'sh.brew.agentbrowser', AGENTBROWSER_ASSUME_DISPLAY: '1' },
        'darwin'
      )
    ).toEqual({ available: true });
  });

  it('allows the browser host to declare display absence', () => {
    expect(detectDisplayAvailability({ AGENTBROWSER_ASSUME_DISPLAY: '0' }, 'darwin')).toEqual({
      available: false,
      reason: 'operator-declared-no-display',
    });
  });

  it('windows: assumed available', () => {
    expect(detectDisplayAvailability({}, 'win32')).toEqual({ available: true });
  });
});
