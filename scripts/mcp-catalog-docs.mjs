#!/usr/bin/env node
/** Project actual MCP tools/list responses; never maintain a second tool registry. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const destination = new URL('../docs/mcp-tool-catalog.md', import.meta.url);
const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderCatalog(catalogs) {
  const canonical = catalogs.map(({ mode, tools }) => ({
    mode, tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
  }));
  const digest = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const lines = [
    '# Generated MCP tool catalog', '',
    'Generated from the built adapter\'s `tools/list` in unbound and delegated modes.',
    'Do not edit by hand. Build the MCP package, then run `node scripts/mcp-catalog-docs.mjs --write`.',
    '`node scripts/mcp-catalog-docs.mjs` checks drift; the existing release-artifact gate runs it.', '',
    'This catalog describes protocol 2025-06-18. Protocol 2024-11-05 retains text results',
    'without output schemas or annotations. Autofill and plan advertise validated',
    'structured output contracts. An absent annotation is not a promise of read-only behavior.',
    'Descriptions and annotations are hints, never authorization. Catalog presence does',
    'not prove a live backend, engine capability or current session grant.', '',
    `Catalog SHA-256 (complete descriptions and schemas): \`${digest}\``, '',
  ];
  for (const { mode, tools } of canonical) {
    lines.push(`## ${mode} (${tools.length} tools)`, '',
      '| Tool | Required arguments | Output contract | Purpose |',
      '| --- | --- | --- | --- |');
    for (const tool of tools) {
      const purpose = tool.description.split(/(?<=\.)\s+/)[0];
      lines.push(`| \`${cell(tool.name)}\` | ${cell((tool.inputSchema.required ?? []).join(', ') || 'none')} | ${cell(tool.outputSchema?.$id ?? 'text JSON')} | ${cell(purpose)} |`);
    }
    lines.push('');
  }
  lines.push('Full nested schemas and complete descriptions are available through `tools/list`.',
    'The digest detects changes even when a summary row stays the same. Tool errors retain',
    'text diagnostics; failed valid reports retain their receipts and set `isError: true`.',
    'Do not retry uncertain writes automatically. See the [MCP package guide](../packages/mcp-server/README.md).', '');
  return lines.join('\n');
}

export async function collectCatalogs() {
  const { buildMcpServer } = await import('../packages/mcp-server/dist/index.js');
  const catalogs = [];
  for (const mode of ['unbound', 'delegated']) {
    const server = buildMcpServer({
      // Discovery is local. Any accidental attempt to execute a tool must fail.
      createClient: () => new Proxy({}, { get() { throw new Error('Catalog generation attempted service access'); } }),
      ...(mode === 'delegated' ? { sessionId: 'catalog-binding' } : {}),
    });
    const exchange = async (method, params = {}) => {
      const response = JSON.parse(await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })));
      if (response.error) throw new Error('Catalog discovery failed');
      return response.result;
    };
    const init = await exchange('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'catalog-docs', version: '1' } });
    if (init.protocolVersion !== '2025-06-18') throw new Error('Build the MCP adapter before generating its catalog');
    const { tools } = await exchange('tools/list');
    catalogs.push({ mode, tools });
  }
  return catalogs;
}

export async function checkCatalogDocument({ write = false, file = destination } = {}) {
  const expected = renderCatalog(await collectCatalogs());
  if (write) await writeFile(file, expected);
  else if (await readFile(file, 'utf8') !== expected)
    throw new Error('MCP catalog documentation is stale. Build, then run node scripts/mcp-catalog-docs.mjs --write');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--write')) throw new Error('usage: mcp-catalog-docs.mjs [--write]');
    await checkCatalogDocument({ write: process.argv.includes('--write') });
    console.log('MCP catalog documentation matches the built adapter.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
