import { afterEach, expect, it, vi } from 'vitest';
import { AgentBrowserClient } from './client.js';

const event = {
  type: 'scope.denied',
  timestamp: '2026-10-30T00:00:00Z',
  sessionId: 'session',
  data: {
    scope: 'SCOPE_METHOD_DENIED',
    method: 'PUT',
    url: 'https://vinted.test/api',
    hostname: 'vinted.test',
  },
};
afterEach(() => vi.unstubAllGlobals());
function stream(chunks: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const text of chunks) controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
    )
  );
}
it('parses fragmented live frames and explicit completion without replaying requests', async () => {
  const text = `data: ${JSON.stringify(event)}\n\nevent: end\ndata: {"reason":"session-ended"}\n\n`;
  stream([text.slice(0, 12), text.slice(12, 40), text.slice(40)]);
  const client = new AgentBrowserClient();
  const rows = [];
  for await (const value of client.sessions.traceDenials('session')) rows.push(value);
  expect(rows).toEqual([event]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('reports truncated delivery and rejects invalid data instead of silently ending', async () => {
  for (const text of [
    `data: ${JSON.stringify(event)}\n\n`,
    'data: {"secret":"must-not-echo"}\n\n',
  ]) {
    stream([text]);
    const client = new AgentBrowserClient();
    const task = (async () => {
      for await (const _ of client.sessions.traceDenials('session')) {
        /* consume */
      }
    })();
    await expect(task).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  }
});

it('accepts coalesced transport chunks while bounding each incomplete frame', async () => {
  const row = `data: ${JSON.stringify(event)}\n\n`;
  stream([`${row.repeat(400)}event: end\ndata: {"reason":"session-ended"}\n\n`]);
  const rows = [];
  for await (const value of new AgentBrowserClient().sessions.traceDenials('session'))
    rows.push(value);
  expect(rows).toHaveLength(400);
  stream([`data: ${'x'.repeat(65537)}`]);
  await expect(
    (async () => {
      for await (const _ of new AgentBrowserClient().sessions.traceDenials('session')) {
      }
    })()
  ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
