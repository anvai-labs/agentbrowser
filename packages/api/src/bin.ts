#!/usr/bin/env node
/**
 * Server entrypoint. Port and host can be set via the PORT/HOST environment
 * variables or the ServerOptions defaults (3000 on 0.0.0.0).
 */

import { startServer } from './server.js';

const server = await startServer();

const shutdown = async (signal: string) => {
  await server.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
