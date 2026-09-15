/** Request events can precede completion of page interception setup. */
export async function handlePublicEgressRequest(request, { target, deny, errors, intercepted }) {
  try {
    const url = new URL(request.url());
    const block = deny && url.origin === target && url.pathname.startsWith('/target/');
    if (request.interceptResolutionState().action === 'disabled') {
      if (block) errors.push({ phase: 'interception', message: `Denied request was not paused: ${url.pathname}` });
      return;
    }
    if (block) {
      await request.abort('blockedbyclient');
      const key = url.searchParams.get('run');
      intercepted.set(key, (intercepted.get(key) ?? 0) + 1);
    } else await request.continue();
  } catch (error) { errors.push({ phase: 'interception', message: error.message }); }
}

/** A disappearing popup is failed startup evidence, never successful installation. */
export async function installPublicEgressPage(page, context) {
  const closed = () => context.errors.push({
    phase: 'popup-install', reason: 'target-closed',
    message: 'Target closed before interception setup completed',
  });
  if (page.isClosed()) { closed(); return; }
  page.on('request', request => { void handlePublicEgressRequest(request, context); });
  try { await page.setRequestInterception(true); }
  catch (error) {
    if (page.isClosed() && (error.name === 'TargetCloseError' ||
      error.message === 'Browsing context already closed.' ||
      error.message.startsWith('Protocol error (network.addIntercept): no such frame'))) {
      closed(); return;
    }
    throw error;
  }
}
