/** Best-effort display hints, evaluated only by the process launching a browser.
 * An environment hint cannot prove that screenshots will be blank or that a
 * display server is reachable. XPC_SERVICE_NAME alone does not identify the
 * launchd login domain. Operators may explicitly assert availability with
 * AGENTBROWSER_ASSUME_DISPLAY=1 (or absence with 0).
 */
export interface DisplayAvailability {
  available: boolean;
  reason?: string;
}

function nonEmpty(value: string | undefined): boolean {
  return (value?.trim() ?? '') !== '';
}

export function detectDisplayAvailability(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): DisplayAvailability {
  if (env.AGENTBROWSER_ASSUME_DISPLAY?.trim() === '1') {
    return { available: true };
  }

  if (env.AGENTBROWSER_ASSUME_DISPLAY?.trim() === '0')
    return { available: false, reason: 'operator-declared-no-display' };

  if (platform === 'linux') {
    if (nonEmpty(env.DISPLAY) || nonEmpty(env.WAYLAND_DISPLAY)) {
      return { available: true };
    }
    return { available: false, reason: 'no-x11-or-wayland-display' };
  }

  // Windows and anything else: assume a desktop session is present.
  return { available: true };
}

export function headedDisplayWarnings(): string[] {
  const display = detectDisplayAvailability();
  return display.available
    ? []
    : [
        `No display detected on the browser host (${display.reason}); a headed window may be unavailable. Run the browser service in a GUI login session or use headless capture. AGENTBROWSER_ASSUME_DISPLAY=1 overrides this environment hint.`,
      ];
}
