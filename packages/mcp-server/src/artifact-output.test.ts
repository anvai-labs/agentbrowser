import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildMcpServer, buildTools, type McpClient } from './mcp-server.js';

function fixture() {
  const bytes = Buffer.alloc(1130000, 97);
  const artifact = {
    artifactId: 'art_fixture',
    type: 'screenshot' as const,
    contentType: 'image/png',
    sizeBytes: bytes.length,
    url: '/signed?token=synthetic-secret',
    inline: { contentBase64: bytes.toString('base64'), byteSize: bytes.length },
  };
  const sessions = {
    screenshot: vi.fn().mockResolvedValue(artifact),
    pdf: vi.fn().mockResolvedValue({ ...artifact, type: 'pdf', contentType: 'application/pdf' }),
    html: vi.fn().mockResolvedValue({ ...artifact, type: 'html', contentType: 'text/html' }),
    artifact: vi
      .fn()
      .mockResolvedValue({ metadata: artifact, contentBase64: artifact.inline.contentBase64 }),
  };
  return { bytes, artifact, sessions, client: { sessions } as unknown as McpClient };
}
describe('reference-first MCP evidence', () => {
  it.each(['screenshot', 'pdf', 'html'])(
    '%s defaults to a small receipt without signed URL or payload',
    async (name) => {
      const { client, sessions } = fixture();
      const tool = buildTools(client).find((tool) => tool.name === name)!;
      const result = await tool.handler({ sessionId: 'ses_1', pageId: 'pg_1' });
      const serialized = JSON.stringify(result);
      expect(serialized.length).toBeLessThan(1024);
      expect(serialized).not.toContain('contentBase64');
      expect(serialized).not.toContain('synthetic-secret');
      expect(sessions.artifact).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['screenshot', '2024-11-05'],
    ['pdf', '2024-11-05'],
    ['screenshot', '2025-06-18'],
    ['pdf', '2025-06-18'],
  ])(
    '%s explicit evidence on %s uses one MCP media block without duplicating bytes in JSON',
    async (name, protocolVersion) => {
      const { client, artifact } = fixture();
      const server = buildMcpServer({ createClient: () => client });
      await server.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: { protocolVersion },
        })
      );
      const response = JSON.parse(
        await server.handle(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: { sessionId: 'ses_1', pageId: 'pg_1', inline: true } },
          })
        )
      );
      if (protocolVersion === '2025-06-18')
        expect(response.result.structuredContent.artifactId).toBe(artifact.artifactId);
      const blocks = response.result.content;
      expect(blocks).toHaveLength(2);
      expect(blocks[0].text).not.toContain('contentBase64');
      expect(JSON.stringify(response.result.structuredContent ?? {})).not.toContain(
        'contentBase64'
      );
      expect(name === 'screenshot' ? blocks[1].data : blocks[1].resource.blob).toBe(
        artifact.inline.contentBase64
      );
      expect(JSON.stringify(response)).not.toContain('synthetic-secret');
    }
  );
  it('honors the configured local cache through the server without exposing content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ab-mcp-artifacts-'));
    try {
      const { client, bytes } = fixture();
      const server = buildMcpServer({ createClient: () => client, artifactDirectory: directory });
      const response = JSON.parse(
        await server.handle(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'screenshot', arguments: { sessionId: 'ses_1', pageId: 'pg_1' } },
          })
        )
      );
      const receipt = JSON.parse(response.result.content[0].text);
      expect((await readFile(receipt.file.path)).equals(bytes)).toBe(true);
      expect(JSON.stringify(response).length).toBeLessThan(1024);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('reads bounded existing bytes by session artifact ID and rejects path/range misuse before retrieval', async () => {
    const { client, sessions, bytes } = fixture();
    const tool = buildTools(client).find((tool) => tool.name === 'artifact')!;
    const result = (await tool.handler({
      sessionId: 'ses_1',
      artifactId: 'art_fixture',
      inline: true,
      offset: 3,
      maxBytes: 11,
    })) as { content: string; nextOffset: number; truncated: boolean };
    expect(Buffer.from(result.content, 'base64').equals(bytes.subarray(3, 14))).toBe(true);
    expect(result.nextOffset).toBe(14);
    expect(result.truncated).toBe(true);
    expect(sessions.artifact).toHaveBeenCalledExactlyOnceWith('ses_1', 'art_fixture');
    expect(sessions.screenshot).not.toHaveBeenCalled();
    for (const extra of [
      { path: '/private-file' },
      { inline: true, maxBytes: 65537 },
      { inline: true, offset: -1 },
      { maxBytes: 1 },
      { inline: 'yes' },
    ]) {
      await expect(
        tool.handler({ sessionId: 'ses_1', artifactId: 'art_fixture', ...extra })
      ).rejects.toThrow();
    }
    expect(sessions.artifact).toHaveBeenCalledTimes(1);
  });
  it('rejects another session on a bound connection before fetching', async () => {
    const { client, sessions } = fixture();
    const server = buildMcpServer({ createClient: () => client, sessionId: 'ses_bound' });
    const response = JSON.parse(
      await server.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'artifact',
            arguments: { sessionId: 'ses_other', artifactId: 'art_fixture', inline: true },
          },
        })
      )
    );
    expect(response.result.isError).toBe(true);
    expect(sessions.artifact).not.toHaveBeenCalled();
  });
});
