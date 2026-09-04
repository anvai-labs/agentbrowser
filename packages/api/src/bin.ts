#!/usr/bin/env node
/**
 * Server entrypoint. Port and host can be set via the PORT/HOST environment
 * variables or the ServerOptions defaults (3000 on 0.0.0.0).
 */

import { MetricsRegistry, StructuredLogger } from '@agentbrowser/core';
import type { BrowserEngine } from '@agentbrowser/engine';
import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { startServer } from './server.js';

const engine = new PlaywrightChromiumEngine();

// TD-BROWSER-7 Phase 2: real Safari via safaridriver, registered for
// per-session routing ({"engine": "safari"}). Sessions created before
// `safaridriver --enable` fail loudly with setup instructions.
const engines: Record<string, BrowserEngine> = {};
if (process.platform === 'darwin') {
  const { SafaridriverEngine } = await import('@agentbrowser/engine-safari');
  engines.safari = new SafaridriverEngine();
}
const metrics = new MetricsRegistry();
const logger = new StructuredLogger({
  level: process.env.AGENTBROWSER_LOG_LEVEL === 'debug' ? 'debug' : 'info',
});

const server = await startServer({ engine, engines, metrics, logger });

// Ensure the browser process goes down with the server.
const shutdown = async () => {
  await server.close(); // onClose shuts the service down, which closes the engine
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
