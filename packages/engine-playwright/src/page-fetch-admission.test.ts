import { expect, it, vi } from 'vitest';
import { admitPageFetchResponse } from './page-fetch-admission.js';

const response = (headers: Array<{ name: string; value: string }> = []) => ({
  requestId: 'request',
  method: 'PUT',
  status: 200,
  headers,
});
const owner = (extra = {}) => ({
  signal: new AbortController().signal,
  assertCurrent: () => {},
  ...extra,
});
function transport(chunks = [{ data: 'body', eof: true }]) {
  let next = 0;
  return {
    send: vi.fn(async (method: string) => {
      if (method === 'Fetch.takeResponseBodyAsStream') return { stream: 'body' };
      if (method === 'IO.read') return chunks[next++];
      if (method === 'IO.close') return {};
      throw new Error('Unexpected transport command');
    }),
  } as any;
}

it('checks complete headers before acquiring a body, preserving separate delivery cookies', async () => {
  const headers = [
    ...Array.from({ length: 40 }, (_, i) => ({ name: `x-extra-${i}`, value: 'header' })),
    { name: 'Content-Length', value: '4' },
    { name: 'Set-Cookie', value: 'one=1; HttpOnly' },
    { name: 'set-cookie', value: 'two=2; HttpOnly' },
  ];
  const cdp = transport();
  const checkResponse = vi.fn(async ({ headers: policy }) => {
    expect(cdp.send).not.toHaveBeenCalled();
    expect(policy['content-length']).toBe('4');
    expect(policy['set-cookie']).toContain('one=1');
    // A policy's normalized view cannot corrupt the actual delivery headers.
    policy['set-cookie'] = 'changed';
    headers[0]!.value = 'changed during await';
  });
  const admitted = await admitPageFetchResponse(cdp, response(headers), { checkResponse }, owner());
  expect(admitted.body?.toString()).toBe('body');
  expect(admitted.headers[0]!.value).toBe('header');
  expect(admitted.headers.slice(-2)).toEqual([
    { name: 'Set-Cookie', value: 'one=1; HttpOnly' },
    { name: 'set-cookie', value: 'two=2; HttpOnly' },
  ]);
});

it('refuses a declared size even when it follows the public header truncation boundary', async () => {
  const headers = [
    ...Array.from({ length: 40 }, (_, i) => ({ name: `x-extra-${i}`, value: 'header' })),
    { name: 'Content-Length', value: '9000' },
  ];
  const cdp = transport();
  await expect(
    admitPageFetchResponse(
      cdp,
      response(headers),
      {
        checkResponse: async ({ headers }) => {
          if (Number(headers['content-length']) > 10) throw new Error('header floor');
        },
      },
      owner()
    )
  ).rejects.toThrow('header floor');
  expect(cdp.send).not.toHaveBeenCalled();
});

it.each([
  [
    { name: 'Content-Length', value: '2' },
    { name: 'CONTENT-LENGTH', value: '2' },
  ],
  [{ name: 'Content-Length', value: '2, 2' }],
  [{ name: 'Content-Length', value: '-2' }],
  [{ name: 'Content-Length', value: '9007199254740992' }],
  [
    { name: 'Location', value: '/one' },
    { name: 'location', value: '/two' },
  ],
  [{ name: 'x-bad\nname', value: 'v' }],
  [{ name: 'x-header', value: 'bad\r\nvalue' }],
  [{ name: 'x-large', value: 'é'.repeat(32768) }],
  Array.from({ length: 257 }, () => ({ name: 'x-header', value: 'v' })),
])('refuses ambiguous, malformed or oversized authoritative headers %#', async (...headers) => {
  const cdp = transport();
  await expect(admitPageFetchResponse(cdp, response(headers), {}, owner())).rejects.toThrow(
    'Fetch response headers cannot be admitted'
  );
  expect(cdp.send).not.toHaveBeenCalled();
});

it('checks cumulative decoded bytes, rather than compressed or displayed length', async () => {
  const cdp = transport([
    { data: 'é', eof: false },
    { data: 'abc', eof: true },
  ]);
  const checkBodySize = vi.fn(async (bytes) => {
    if (bytes > 4) throw new Error('actual byte floor');
  });
  await expect(admitPageFetchResponse(cdp, response(), { checkBodySize }, owner())).rejects.toThrow(
    'actual byte floor'
  );
  expect(checkBodySize.mock.calls.map(([bytes]) => bytes)).toEqual([0, 2, 5]);
  expect(cdp.send).toHaveBeenLastCalledWith('IO.close', { handle: 'body' });
  expect(
    cdp.send.mock.calls.every(([method]: [string]) => !method.startsWith('Fetch.continue'))
  ).toBe(true);
});

it.each([
  ['HEAD', 200],
  ['GET', 204],
  ['PUT', 205],
  ['GET', 304],
])('admits %s/%i headers and a zero byte witness without taking a body', async (method, status) => {
  const cdp = transport();
  const checkResponse = vi.fn(async () => {});
  const checkBodySize = vi.fn(async () => {});
  const admitted = await admitPageFetchResponse(
    cdp,
    { ...response(), method, status },
    { checkResponse, checkBodySize },
    owner()
  );
  expect(admitted.body).toBeUndefined();
  expect(checkResponse).toHaveBeenCalledOnce();
  expect(checkBodySize).toHaveBeenCalledExactlyOnceWith(0);
  expect(cdp.send).not.toHaveBeenCalled();
});

it.each([301, 302, 303, 307, 308])(
  'checks %i redirect headers without inventing a body witness',
  async (status) => {
    const cdp = transport();
    const checkResponse = vi.fn(async () => {});
    const checkBodySize = vi.fn(async () => {});
    const admitted = await admitPageFetchResponse(
      cdp,
      {
        ...response([{ name: 'Location', value: '/next' }]),
        status,
      },
      { checkResponse, checkBodySize },
      owner()
    );
    expect(admitted.kind).toBe('redirect');
    expect(checkResponse).toHaveBeenCalledOnce();
    expect(checkBodySize).not.toHaveBeenCalled();
    expect(cdp.send).not.toHaveBeenCalled();
  }
);

it('reads a 302 without Location as a terminal body', async () => {
  const admitted = await admitPageFetchResponse(
    transport(),
    { ...response(), status: 302 },
    {},
    owner()
  );
  expect(admitted.kind).toBe('terminal');
  expect(admitted.body?.toString()).toBe('body');
});

it.each([false, true])(
  'keeps actual redirect classification when policy mutates Location (redirect=%s)',
  async (redirect) => {
    const cdp = transport();
    const checkBodySize = vi.fn(async () => {});
    const admitted = await admitPageFetchResponse(
      cdp,
      {
        ...response(redirect ? [{ name: 'Location', value: '/actual' }] : []),
        status: 302,
      },
      {
        checkBodySize,
        checkResponse: async ({ headers }) => {
          if (redirect) Reflect.deleteProperty(headers, 'location');
          else headers.location = '/invented-by-callback';
        },
      },
      owner()
    );
    expect(admitted.kind).toBe(redirect ? 'redirect' : 'terminal');
    if (redirect) {
      expect(cdp.send).not.toHaveBeenCalled();
      expect(checkBodySize).not.toHaveBeenCalled();
      expect(admitted.headers).toEqual([{ name: 'Location', value: '/actual' }]);
    } else {
      expect(admitted.body?.toString()).toBe('body');
      expect(checkBodySize).toHaveBeenLastCalledWith(4);
    }
  }
);

it('pins response identity and body semantics before asynchronous policy callbacks', async () => {
  const input = response();
  const cdp = transport();
  const checkBodySize = vi.fn(async () => {});
  const admitted = await admitPageFetchResponse(
    cdp,
    input,
    {
      checkBodySize,
      checkResponse: async () => {
        input.method = 'HEAD';
        input.status = 204;
        input.requestId = 'different-response';
      },
    },
    owner()
  );
  expect(admitted.kind).toBe('terminal');
  expect(admitted.body?.toString()).toBe('body');
  expect(cdp.send).toHaveBeenCalledWith('Fetch.takeResponseBodyAsStream', { requestId: 'request' });
  expect(checkBodySize).toHaveBeenLastCalledWith(4);
});

it('bounds a stalled header policy by the overall lifetime and never acquires a stream', async () => {
  vi.useFakeTimers();
  try {
    const cdp = transport();
    const task = admitPageFetchResponse(
      cdp,
      response(),
      {
        checkResponse: () => new Promise(() => {}),
      },
      owner({ timeoutMs: 20 })
    );
    const assertion = expect(task).rejects.toMatchObject({ code: 'ACTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(cdp.send).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('bounds a stalled byte policy after taking the stream and closes it on owner cancellation', async () => {
  const controller = new AbortController();
  const cdp = transport();
  let checked!: () => void;
  const waiting = new Promise<void>((resolve) => {
    checked = resolve;
  });
  const task = admitPageFetchResponse(
    cdp,
    response(),
    {
      checkBodySize: async (bytes) => {
        if (bytes) {
          checked();
          await new Promise(() => {});
        }
      },
    },
    owner({ signal: controller.signal })
  );
  const assertion = expect(task).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
  await waiting;
  controller.abort();
  await assertion;
  // The nested transport wait also observes cancellation and closes its stream.
  await vi.waitFor(() => expect(cdp.send).toHaveBeenLastCalledWith('IO.close', { handle: 'body' }));
});

it('detects guard-only revocation while waiting on header policy', async () => {
  vi.useFakeTimers();
  try {
    let live = true;
    const cdp = transport();
    const task = admitPageFetchResponse(
      cdp,
      response(),
      {
        checkResponse: () => new Promise(() => {}),
      },
      owner({
        assertCurrent: () => {
          if (!live) throw new Error('owner revoked');
        },
      })
    );
    const assertion = expect(task).rejects.toThrow('owner revoked');
    live = false;
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(cdp.send).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
