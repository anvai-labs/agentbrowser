#!/usr/bin/env node
/**
 * Write the OpenAPI document to disk.
 *
 * The spec is committed so polyglot clients can be generated without a
 * running server. Regenerate with `pnpm --filter @agentbrowser/api openapi`.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from './openapi.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? resolve(here, '../../../openapi.json');

writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
process.stdout.write(`Wrote ${target}\n`);
