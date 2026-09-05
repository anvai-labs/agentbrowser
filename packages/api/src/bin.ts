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

/** Parse a positive-int env var; undefined when unset or garbage (loud default). */
const envMs = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[agentbrowser] Ignoring ${name}="${raw}" - must be a positive integer of milliseconds.`
    );
    return undefined;
  }
  return parsed;
};

// Operator-level session defaults (per-request values still win).
const defaultTtlMs = envMs('AGENTBROWSER_DEFAULT_TTL_MS');
const defaultIdleTimeoutMs = envMs('AGENTBROWSER_DEFAULT_IDLE_TIMEOUT_MS');
const server = await startServer({
  engine,
  engines,
  metrics,
  logger,
  ...(defaultTtlMs !== undefined ? { defaultTtlMs } : {}),
  ...(defaultIdleTimeoutMs !== undefined ? { defaultIdleTimeoutMs } : {}),
});

// Ensure the browser process goes down with the server.
const shutdown = async () => {
  await server.close(); // onClose shuts the service down, which closes the engine
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
