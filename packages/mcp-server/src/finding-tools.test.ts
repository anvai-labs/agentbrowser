// T10 M3: `finding_check` and `finding_sarif` — offline findings tools, visible only in the
// audit/appsec/bounty modes. The ledger fixture is built with the real chain functions.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENGAGEMENT_GENESIS, engagementChainHash } from '@agentbrowser/core';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { buildMcpServer } from './mcp-server.js';

const dir = mkdtempSync(join(tmpdir(), 'finding-tools-'));
const write = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

function ledgerText() {
  const scope = {
    allowedHosts: ['app.test'],
    pathRules: [],
    identityBindings: [],
    expired: false,
    denials: {},
  };
  const records = [
    {
      type: 'engagement.opened',
      data: { engagementId: 'eng_bbbbbbbbbbbbbbbbbbbbbbbb', scope },
    },
    {
      type: 'request',
      data: { outcome: 'finished', method: 'GET', url: 'https://app.test/api/x', status: 200 },
    },
    { type: 'engagement.closed', data: { records: 2 } },
  ];
  let prev = ENGAGEMENT_GENESIS;
  return `${records
    .map((record, seq) => {
      const at = '2026-10-17T00:00:00.000Z';
      const body = JSON.stringify({ seq, at, type: record.type, data: record.data });
      const hash = engagementChainHash(prev, body);
      const line = JSON.stringify({ seq, at, type: record.type, data: record.data, prev, hash });
      prev = hash;
      return line;
    })
    .join('\n')}\n`;
}

const ledger = write('ledger.jsonl', ledgerText());
const finding = {
  id: 'F-1',
  title: 'Info leak',
  severity: 'medium',
  status: 'confirmed',
  url: 'https://app.test/api/x',
  description: 'Returns another tenant id.',
  ledgerRefs: [1],
  evidence: {
    method: 'independent-reproduction',
    reproducedAt: '2026-10-17T01:00:00Z',
    observation: 'Second account saw the first tenant id.',
    cleanup: { required: false, performed: false, note: 'read-only' },
  },
};

function serverFor(mode: string) {
  const sessions = new Proxy(
    {},
    { get: () => () => Promise.reject(new Error('offline tool: no session access')) }
  );
  const deps: McpDependencies = {
    sessionId: undefined,
    artifactDirectory: undefined,
    createClient: () => ({ sessions }) as unknown as McpClient,
    mode: mode as never,
    toolCallTimeoutMs: 30_000,
  };
  return buildMcpServer(deps);
}

async function advertisedSchemaFor(mode: string, name: string) {
  const server = serverFor(mode);
  // Negotiate the structured protocol first: the legacy path strips outputSchema.
  await server.handle(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    })
  );
  const response = JSON.parse(
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  );
  const tool = response.result.tools.find((tool: { name: string }) => tool.name === name);
  if (tool?.outputSchema === undefined) throw new Error(`no advertised schema for ${name}`);
  const ajv = new Ajv({ strict: false });
  return ajv.compile(tool.outputSchema);
}

async function callTool(mode: string, name: string, args: Record<string, unknown>) {
  const server = serverFor(mode);
  const response = await server.handle(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })
  );
  const parsed = JSON.parse(response);
  // The tools return text content holding their JSON result (no outputSchema on these).
  const content = parsed.result?.content?.[0]?.text;
  return {
    result: content !== undefined ? JSON.parse(content) : parsed.result,
    raw: response,
  };
}

describe('finding tools (T10 M3)', () => {
  it('are visible only in audit/appsec/bounty modes', async () => {
    for (const mode of ['audit', 'appsec', 'bounty']) {
      const server = serverFor(mode);
      const response = JSON.parse(
        await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      );
      const names = response.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain('finding_check');
      expect(names).toContain('finding_sarif');
    }
    const qa = JSON.parse(
      await serverFor('qa').handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    );
    expect(qa.result.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      'finding_check'
    );
  });

  it('finding_check binds a confirmed finding to the ledger', async () => {
    const findings = write('good.json', JSON.stringify([finding]));
    const { result } = await callTool('bounty', 'finding_check', {
      ledger,
      findings,
    });
    const structured = result;
    expect(structured).toMatchObject({
      ok: true,
      engagementId: 'eng_bbbbbbbbbbbbbbbbbbbbbbbb',
      findings: 1,
    });
  });

  it('finding_check refuses an out-of-scope finding with per-finding issues', async () => {
    const bad = write('bad.json', JSON.stringify([{ ...finding, url: 'https://evil.test/x' }]));
    const { result } = await callTool('bounty', 'finding_check', { ledger, findings: bad });
    expect(result.ok).toBe(false);
    expect(result.issues[0].issue).toMatch(/outside the engagement scope/);
  });

  it('finding_sarif writes a 0600 draft and cites the ledger', async () => {
    const good = write('good2.json', JSON.stringify([finding]));
    const out = join(dir, 'report.sarif');
    const { result } = await callTool('bounty', 'finding_sarif', {
      ledger,
      findings: good,
      out,
    });
    const structured = result;
    expect(structured.file).toBe(out);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const sarif = JSON.parse(readFileSync(out, 'utf8'));
    expect(sarif.runs[0].properties).toMatchObject({ draft: true, submission: 'manual' });
  });

  it('both emitted shapes validate against the advertised schema (M: refusal arm)', async () => {
    const schema = await advertisedSchemaFor('bounty', 'finding_sarif');
    const good = write('shape-good.json', JSON.stringify([finding]));
    const success = await callTool('bounty', 'finding_sarif', { ledger, findings: good });
    expect(schema(success.result)).toBe(true);
    const bad = write(
      'shape-bad.json',
      JSON.stringify([{ ...finding, url: 'https://evil.test/x' }])
    );
    const refusal = await callTool('bounty', 'finding_sarif', { ledger, findings: bad });
    expect(refusal.result.ok).toBe(false);
    expect(schema(refusal.result)).toBe(true);
    expect(schema({})).toBe(false);
  });

  it('a tampered ledger is refused', async () => {
    const tampered = write('tampered.jsonl', ledgerText().replace('/api/x', '/api/y'));
    const good = write('good3.json', JSON.stringify([finding]));
    const { result } = await callTool('bounty', 'finding_check', {
      ledger: tampered,
      findings: good,
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0].issue).toMatch(/chain is broken/);
  });
});
