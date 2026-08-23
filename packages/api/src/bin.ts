#!/usr/bin/env node
/**
 * Server entrypoint. Port and host can be set via the PORT/HOST environment
 * variables or the ServerOptions defaults (3000 on 0.0.0.0).
 */

import { PlaywrightChromiumEngine } from '@agentbrowser/engine-playwright';
import { startServer } from './server.js';

const engine = new PlaywrightChromiumEngine();
const server = await startServer({ engine });

// Ensure the browser process goes down with the server.
const shutdown = async () => {
  await server.close(); // onClose shuts the service down, which closes the engine
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
