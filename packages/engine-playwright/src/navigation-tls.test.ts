import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { expect, it } from 'vitest';
import { PlaywrightChromiumEngine } from './index.js';

const pfx = readFileSync(new URL('./test-support/navigation-tls.p12', import.meta.url));

it('classifies a routed self-signed TLS refusal without exposing transport prose', async () => {
  let requests = 0;
  const server = createServer({ pfx, passphrase: 'agentbrowser-test' }, (_request, response) => {
    requests++;
    response.end('must not reach an untrusted TLS origin');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing TLS fixture port');

  const engine = new PlaywrightChromiumEngine({ egress: { async checkRequest() {} } });
  try {
    const page = await (await engine.createSession()).newPage();
    const failure = await page
      .navigate({ url: `https://127.0.0.1:${address.port}/private?token=private` })
      .catch((error) => error);

    expect(failure).toMatchObject({
      code: 'INTERNAL',
      retryable: false,
      details: { reason: 'tls_refused' },
    });
    expect(failure.message).toBe('Navigation failed: tls_refused');
    expect(JSON.stringify(failure)).not.toMatch(/127\.0\.0\.1|private|self.signed/i);
    expect(requests).toBe(0);
  } finally {
    await engine.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
