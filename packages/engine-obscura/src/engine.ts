/**
 * Obscura engine adapter
 *
 * Composes — never forks — the existing CDP path: starts an Obscura
 * server via the launcher and hands its endpoint to
 * PlaywrightChromiumEngine({ cdpEndpoint }), exactly the integration
 * Obscura's own docs prescribe. Engine close() disconnects AND kills
 * the server process (Playwright's close on a connected browser only
 * disconnects, so the launcher owns the kill).
 */

import type { BrowserEngine } from '@agentbrowser/engine';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import type { PlaywrightEngineOptions } from '@agentbrowser/engine-playwright';
import { startObscura } from './launcher.js';
import type { ObscuraLaunchOptions, ObscuraServer } from './launcher.js';

export interface ObscuraEngineOptions {
  /** Launcher options (binary path, port, extra serve args). */
  launch?: ObscuraLaunchOptions;
  /** Egress policy forwarded to the CDP engine. */
  egress?: PlaywrightEngineOptions['egress'];
}

export interface ObscuraEngine {
  /** The BrowserEngine (a CDP-connected Playwright engine). */
  engine: BrowserEngine;
  /** The running Obscura server (endpoint, process, stop). */
  server: ObscuraServer;
  /** Disconnect and kill the Obscura process. */
  shutdown(): Promise<void>;
}

/**
 * Create a BrowserEngine backed by a launched Obscura server.
 */
export async function createObscuraEngine(
  options: ObscuraEngineOptions = {}
): Promise<ObscuraEngine> {
  const server = await startObscura(options.launch);

  const engine = new PlaywrightChromiumEngine({
    cdpEndpoint: server.wsEndpoint,
    ...(options.egress !== undefined ? { egress: options.egress } : {}),
  });

  return {
    engine,
    server,
    async shutdown() {
      await engine.close();
      await server.stop();
    },
  };
}
