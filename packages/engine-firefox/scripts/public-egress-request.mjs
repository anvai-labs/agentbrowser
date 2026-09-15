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

