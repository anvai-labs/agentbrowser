/**
 * Best-effort detection of whether a headed browser launch can actually reach a
 * display. Headed sessions exist for human-in-the-loop flows, but under a
 * launchd *system* daemon (e.g. the Homebrew `agentbrowser` service) there is no
 * Aqua GUI session, so `headless:false` renders to a null surface and every
 * screenshot comes back blank. We never fail the launch on this - the engine
 * logs a warning and the MCP `browser_create` response surfaces one so callers
 * know a visible window is unavailable and steer to browser_html. Heuristic,
 * not authoritative; AGENTBROWSER_ASSUME_DISPLAY=1 lets a deployment assert a
 * GUI session explicitly.
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

  if (platform === 'linux') {
    if (nonEmpty(env.DISPLAY) || nonEmpty(env.WAYLAND_DISPLAY)) {
      return { available: true };
    }
    return { available: false, reason: 'no-x11-or-wayland-display' };
  }

  if (platform === 'darwin') {
    // launchd sets XPC_SERVICE_NAME to the service label for managed processes;
    // an interactive shell reports "0". A labelled value with no login session
    // is our best signal for a daemon that cannot open a window.
    const xpc = env.XPC_SERVICE_NAME?.trim() ?? '';
    const daemonManaged = xpc !== '' && xpc !== '0';
    if (daemonManaged) {
      return { available: false, reason: 'macos-launchd-no-aqua-session' };
    }
    return { available: true };
  }

  // Windows and anything else: assume a desktop session is present.
  return { available: true };
}
