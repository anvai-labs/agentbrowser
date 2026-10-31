// Owned resources only; each failed close is reported and cannot skip later cleanup.
export async function cleanupStartup({ browser, browserServer, server, sockets, timeoutMs = 2000 }) {
  const errors = [];
  async function attempt(label, action) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs); }),
      ]);
      return true;
    } catch (error) { errors.push(`${label}: ${String(error)}`); return false; }
    finally { clearTimeout(timer); }
  }
  await attempt('browser close', () => browser?.close());
  if (!await attempt('browser process close', () => browserServer?.close())) {
    await attempt('browser process kill', () => browserServer?.kill());
  }
  for (const socket of sockets) socket.destroy();
  await attempt('HTTP server close', () => new Promise((resolve, reject) => {
    server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
  }));
  await new Promise(resolve => setTimeout(resolve, 0));
  return { browserClosed: !browser?.isConnected(), sockets: sockets.size, serverClosed: !server.listening, errors };
}
