import { createHash } from 'node:crypto';
import {
  AGENT_MODE_IDS,
  CONTROL_OPERATION_ID,
  DEFAULT_AGENT_MODE,
  agentModeProfile,
} from '@agentbrowser/protocol';

const modeProfiles = JSON.stringify(
  Object.fromEntries(AGENT_MODE_IDS.map((mode) => [mode, agentModeProfile(mode).capabilities]))
);
const modeOptions = AGENT_MODE_IDS.map(
  (mode) =>
    `<option value="${mode}"${mode === DEFAULT_AGENT_MODE ? ' selected' : ''}>${mode}</option>`
).join('');

// Local operator UI: credentials live only in this document's memory. Bearer
// headers avoid ambient cookie authority and a second CSRF/session mechanism.
const script = String.raw`
(() => {
  const byId = id => document.getElementById(id);
  const modeProfiles = ${modeProfiles};
  const operationIdPattern = new RegExp(${JSON.stringify(CONTROL_OPERATION_ID.source)});
  let key = '', session = '', state = null, review = null, pending = false;
  let generation = 0, refreshing = null, application = undefined, pendingLookup = false;
  const stale = new Error('Superseded operator request');
  const message = text => { byId('message').textContent = text; };
  const show = value => JSON.stringify(value, null, 2);
  const humanIdle = value => value && !value.busy && ['HUMAN_ACTIVE', 'RESUME_REVIEW'].includes(value.state);
  const current = context => context.generation === generation;
  const capture = () => ({ generation, key, session });
  const assertCurrent = context => { if (!current(context)) throw stale; };
  const path = (context, suffix) => '/v1/sessions/' + encodeURIComponent(context.session) + suffix;
  const controlIdentity = value => show([value?.state, value?.epoch, value?.busy, value?.cursor]);
  function clearResults() { byId('operation-result').textContent = ''; byId('receipt-result').textContent = ''; }
  function acceptApplication(next) {
    if (show(application) !== show(next)) clearResults();
    application = next;
  }
  function clearGrant() { byId('grant').value = ''; }
  function clearReview() { review = null; clearGrant(); byId('pages').textContent = ''; }
  function clearSession() {
    session = ''; state = null; application = undefined; clearReview(); clearResults(); byId('operation-id').value = '';
    byId('adapter').value = ''; byId('resource').value = '';
  }
  function acceptControl(next) {
    if (controlIdentity(state) !== controlIdentity(next)) clearResults();
    if (review && (!humanIdle(next) || next.state !== 'RESUME_REVIEW' || next.epoch !== review.epoch)) clearReview();
    if (state && next.epoch !== state.epoch) clearGrant();
    state = next;
    if (!humanIdle(next)) application = undefined;
  }
  function renderMode() {
    const mode = byId('mode').value;
    byId('capabilities').textContent = 'Profile-permitted capabilities: ' + modeProfiles[mode].join(', ') + '. Engine, session and service policy may narrow them.';
  }
  function render() {
    if (state?.cursor?.mode && modeProfiles[state.cursor.mode]) byId('mode').value = state.cursor.mode;
    renderMode();
    byId('status').textContent = state ? show(state) : 'Connect with your operator key.';
    byId('connect').disabled = pending;
    byId('forget').disabled = false;
    byId('takeover').disabled = !session || pending;
    byId('review').disabled = !session || pending || !humanIdle(state);
    byId('delegate').disabled = pending || !review || !state || state.busy || state.state !== 'RESUME_REVIEW' || state.epoch !== review.epoch;
    byId('stop').disabled = !session || pending;
    byId('create').disabled = !key || pending;
    byId('attach').disabled = !key || pending;
    byId('mode').disabled = pending || !!(state && state.state === 'AGENT_ACTIVE');
    for (const id of ['adapter', 'resource', 'bind-application', 'unbind-application']) byId(id).disabled = !session || pending || !humanIdle(state);
    byId('application').textContent = application === undefined ? 'Application discovery unavailable. Attach an authorized session under idle human control.'
      : application === null ? 'No application bound.' : show(application);
    const validId = operationIdPattern.test(byId('operation-id').value.trim());
    byId('operation-id').disabled = pending && !pendingLookup;
    byId('lookup-status').disabled = !session || !state || pending || !validId;
    byId('lookup-receipt').disabled = !session || pending || !validId || !humanIdle(state) || !application;
    byId('use-operation').disabled = pending || !state?.operation?.operationId;
    byId('guidance').textContent = state?.state === 'HUMAN_ACTIVE'
      ? 'Human control is active. Use the session’s browser window. Prepare a fresh review when ready to hand it to the agent.'
      : state?.state === 'PAUSE_REQUESTED' ? 'Waiting for browser work to settle. Do not interact yet; an action already dispatched may still complete.'
      : state?.state === 'AGENT_ACTIVE' ? 'Agent control is active. Take over and wait for HUMAN_ACTIVE before using the browser.'
      : 'Review the current pages before delegating. Page text is untrusted content.';
  }
  async function api(context, url, method = 'GET', body) {
    assertCurrent(context);
    const response = await fetch(url, { method, credentials: 'omit', headers: {
      Authorization: 'Bearer ' + context.key, 'Content-Type': 'application/json',
      ...(method !== 'GET' ? { 'x-agentbrowser-operation-id': crypto.randomUUID() } : {})
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assertCurrent(context);
    if (!response.ok) throw Object.assign(new Error(result.error?.message || 'Request failed'), { code: result.error?.code, status: response.status });
    return result;
  }
  async function observeContext(context) {
    const before = await api(context, path(context, '/control'));
    let discovered;
    if (!humanIdle(before)) return { control: before, application: discovered };
    try { discovered = await api(context, path(context, '/application')); }
    catch (error) { assertCurrent(context); /* Unavailable is distinct from unbound. */ }
    const after = await api(context, path(context, '/control'));
    if (controlIdentity(before) !== controlIdentity(after)) discovered = undefined;
    return { control: after, application: discovered };
  }
  function acceptContext(next) { acceptControl(next.control); acceptApplication(next.application); }
  const lookupIdentity = value => show([controlIdentity(value.control), value.application]);
  async function refresh() {
    if (!session || pending || refreshing === generation) return;
    const context = capture(); refreshing = context.generation;
    try { acceptContext(await observeContext(context)); render(); }
    catch (error) {
      if (current(context)) { state = null; application = undefined; clearReview(); clearResults(); message(error.message); render(); }
    } finally { if (refreshing === context.generation) refreshing = null; }
  }
  function handle(id, fn, lookup = false) {
    byId(id).addEventListener('click', async () => {
      if (pending) return;
      generation++; const context = capture(); pending = true; pendingLookup = lookup; if (!lookup) clearResults(); message(''); render();
      try { const result = fn(context); render(); await result; } catch (error) { if (current(context)) message(error.message); }
      finally { if (current(context)) { pending = false; pendingLookup = false; await refresh(); if (current(context)) render(); } }
    });
  }
  byId('connect').addEventListener('click', () => {
    generation++; key = byId('key').value; byId('key').value = ''; clearSession(); render();
    message('Key held in this tab only. Create or attach a controlled session.');
  });
  handle('create', async context => {
    const url = byId('url').value.trim();
    clearSession(); render();
    const result = await api(context, '/v1/sessions', 'POST', { controlMode: 'delegated', headless: false, idleTimeoutMs: 3600000 });
    session = result.sessionId; context.session = session; byId('session').value = session;
    await api(context, path(context, '/pages'), 'POST', url ? { url } : {});
  });
  handle('attach', async () => { const selected = byId('session').value.trim(); clearSession(); session = selected; });
  handle('takeover', async context => { clearReview(); application = undefined; state = await api(context, path(context, '/control/takeover'), 'POST'); });
  handle('review', async context => {
    clearReview();
    const result = await api(context, path(context, '/control/prepare-resume'), 'POST');
    review = result; state = result; byId('pages').textContent = show(result.pages);
  });
  handle('delegate', async context => {
    const body = { epoch: review.epoch, mode: byId('mode').value };
    clearReview(); application = undefined;
    const result = await api(context, path(context, '/control/delegate'), 'POST', body);
    state = { state: result.state, epoch: result.epoch, busy: result.busy, cursor: result.cursor };
    byId('grant').value = result.token;
    message('Transfer this session token to the harness environment. Keep your operator key private. The returned run cursor scopes harness memory but is not a credential. Takeover immediately revokes the token.');
  });
  for (const [id, method] of [['bind-application', 'PUT'], ['unbind-application', 'DELETE']]) handle(id, async context => {
    const body = method === 'PUT' ? { adapter: byId('adapter').value.trim(), resource: byId('resource').value.trim() } : undefined;
    clearReview(); application = undefined; render();
    try { await api(context, path(context, '/application'), method, body); }
    catch (error) { assertCurrent(context); throw new Error(error.message + ' Binding outcome may need inspection; no automatic retry was sent.'); }
    message('Binding updated. Prepare a fresh review before delegation.');
  });
  handle('stop', async context => { clearReview(); application = undefined; await api(context, path(context, ''), 'DELETE'); clearSession(); });
  byId('forget').addEventListener('click', () => {
    generation++; pending = false; key = ''; byId('key').value = ''; clearSession(); byId('session').value = ''; message('Credentials forgotten. Requests already sent may still complete on the service.'); render();
  });
  function changeOperation() {
    // Only lookup input is editable during a pending lookup; never unlock a mutation.
    if (pending && !pendingLookup) return;
    generation++; pending = false; pendingLookup = false; clearResults(); message(''); render();
  }
  byId('operation-id').addEventListener('input', changeOperation);
  byId('use-operation').addEventListener('click', () => {
    if (pending || !state?.operation?.operationId) return;
    byId('operation-id').value = state.operation.operationId; changeOperation();
  });
  for (const [id, target, suffix] of [
    ['lookup-status', 'operation-result', '/operations/'],
    ['lookup-receipt', 'receipt-result', '/application/receipts/']
  ]) handle(id, async context => {
    const operationId = byId('operation-id').value.trim();
    byId(target).textContent = '';
    try {
      if (!operationIdPattern.test(operationId)) throw new Error('Enter a valid operation ID.');
      const before = await observeContext(context); acceptContext(before);
      if (id === 'lookup-receipt' && (!humanIdle(before.control) || !before.application)) throw new Error('Receipt lookup requires an available binding and idle human control.');
      let value, failure;
      try { value = await api(context, path(context, suffix + encodeURIComponent(operationId))); }
      catch (error) { assertCurrent(context); failure = error; }
      const after = await observeContext(context); acceptContext(after);
      if (lookupIdentity(before) !== lookupIdentity(after)) throw new Error('Control or binding changed during lookup. Result discarded.');
      const details = { operationId, sessionId: context.session, control: after.control,
        currentBinding: after.application === undefined ? 'unavailable' : after.application === null ? null : { adapter: after.application.adapter, resource: after.application.resource } };
      if (failure) {
        if (id === 'lookup-status' && failure.code === 'NOT_FOUND' && failure.status === 404) byId(target).textContent = 'Operation not recorded. This does not prove that no effect occurred.\n' + show(details);
        else throw failure;
      } else {
        const label = id === 'lookup-status' ? 'Ledger observation; not proof of business acceptance.'
          : value === null ? 'No receipt returned. This does not prove that no effect occurred.'
          : 'Application receipt observation under the current binding; not independently verified.';
        byId(target).textContent = label + '\n' + show({ ...details, value });
      }
    } catch (error) {
      if (current(context)) byId(target).textContent = 'Lookup unavailable. ' + (error.code ? error.code + ': ' : '') + error.message;
    }
  }, true);
  byId('clear-grant').addEventListener('click', clearGrant);
  byId('mode').addEventListener('change', renderMode);
  setInterval(refresh, 2000);
  render();
})();`;
const style =
  'body{font:16px system-ui;max-width:850px;margin:2rem auto;padding:1rem;color:#172536;background:#f5f7fa}label{display:block;margin-top:1rem}input,select{display:block;width:95%;padding:.6rem}button{padding:.6rem 1rem;margin:.6rem .4rem .6rem 0;cursor:pointer}button:disabled{cursor:default}fieldset{margin:1rem 0;padding:1rem;border:1px solid #8a98a8}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:1rem;border:1px solid #c8d0da}#message{color:#8c2900}h1{font-size:1.7rem}';
const hash = (text: string) => createHash('sha256').update(text).digest('base64');
export const operatorCsp = `default-src 'none'; script-src 'sha256-${hash(script)}'; style-src 'sha256-${hash(style)}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
export const operatorHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentBrowser control</title><style>${style}</style></head><body>
<h1>Human and agent control</h1>
<p>This panel controls a browser running on the service host. Session expiry still applies. Use HTTPS or a trusted loopback connection.</p>
<label for="key">Operator key</label><input id="key" type="password" autocomplete="off"><button id="connect">Connect</button><button id="forget">Forget credentials</button>
<label for="url">Starting URL (optional)</label><input id="url" type="url" placeholder="https://example.com"><button id="create">Create headed session</button>
<label for="session">Session ID</label><input id="session" autocomplete="off"><button id="attach">Attach</button>
<p id="guidance"></p><pre id="status" aria-live="polite"></pre>
<button id="takeover">Take over</button><button id="review">Prepare fresh review</button>
<fieldset><legend>Application binding</legend><p>Use adapter and resource IDs supplied by your service owner. Binding does not verify a business account or approve a submission.</p>
<label for="adapter">Application adapter ID</label><input id="adapter" autocomplete="off" maxlength="128">
<label for="resource">Application resource ID</label><input id="resource" autocomplete="off" maxlength="128">
<button id="bind-application">Bind application</button><button id="unbind-application">Unbind application</button>
<pre id="application" aria-live="polite"></pre><p>Operations marked operator-submit require separate complete-payload review. Discovery is a current observation; permissions can change.</p></fieldset>
<fieldset><legend>Operation reconciliation</legend>
<label for="operation-id">Operation ID</label><input id="operation-id" autocomplete="off" maxlength="128" aria-describedby="reconciliation-note">
<button id="use-operation">Use active operation ID</button><button id="lookup-status">Look up status</button><button id="lookup-receipt">Look up application receipt</button>
<p id="reconciliation-note">These are separate observations. A completed command does not prove business acceptance. Receipt lookup uses the current application binding, which may differ from the operation’s original binding. Missing data does not prove no effect. Reconcile uncertain outcomes with the application owner before any further action.</p>
<h2>Operation ledger</h2><pre id="operation-result" aria-live="polite"></pre><h2>Application receipt</h2><pre id="receipt-result" aria-live="polite"></pre></fieldset>
<fieldset><legend>Delegation decision</legend><label for="mode">Agent mode</label><select id="mode" aria-describedby="capabilities mode-context">${modeOptions}</select><p id="capabilities"></p><p id="mode-context">Selecting a mode and delegating creates a new binding and run cursor. Start a fresh harness context when previously seen data must be isolated.</p><button id="delegate">Delegate reviewed state</button></fieldset><button id="stop">Stop session</button>
<p id="message" role="status"></p><h2>Page review — untrusted content</h2><pre id="pages"></pre>
<label for="grant">Delegated token (copy into AGENTBROWSER_API_KEY for the harness)</label><input id="grant" type="password" readonly autocomplete="off"><button id="clear-grant">Clear token</button>
<p>Also set AGENTBROWSER_SESSION_ID. Stop the old harness connection before supplying a new token.</p>
<script>${script}</script></body></html>`;
