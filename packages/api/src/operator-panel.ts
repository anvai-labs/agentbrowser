import { createHash } from 'node:crypto';
import { AGENT_MODE_IDS, DEFAULT_AGENT_MODE, agentModeProfile } from '@agentbrowser/protocol';

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
  let key = '', session = '', state = null, review = null, pending = false;
  const message = text => { byId('message').textContent = text; };
  const show = value => JSON.stringify(value, null, 2);
  function renderMode() {
    const mode = byId('mode').value;
    byId('capabilities').textContent = 'Profile-permitted capabilities: ' + modeProfiles[mode].join(', ') + '. Engine, session and service policy may narrow them.';
  }
  function render() {
    if (state?.cursor?.mode && modeProfiles[state.cursor.mode]) byId('mode').value = state.cursor.mode;
    renderMode();
    byId('status').textContent = state ? show(state) : 'Connect with your operator key.';
    byId('connect').disabled = pending;
    byId('forget').disabled = pending;
    byId('takeover').disabled = !session || pending;
    byId('review').disabled = !session || pending || !state || state.busy || !['HUMAN_ACTIVE', 'RESUME_REVIEW'].includes(state.state);
    byId('delegate').disabled = pending || !review || !state || state.busy || state.state !== 'RESUME_REVIEW' || state.epoch !== review.epoch;
    byId('stop').disabled = !session || pending;
    byId('create').disabled = !key || pending;
    byId('attach').disabled = !key || pending;
    byId('mode').disabled = pending || !!(state && state.state === 'AGENT_ACTIVE');
    byId('guidance').textContent = state?.state === 'HUMAN_ACTIVE'
      ? 'Human control is active. Use the session’s browser window. Prepare a fresh review when ready to hand it to the agent.'
      : state?.state === 'PAUSE_REQUESTED' ? 'Waiting for browser work to settle. Do not interact yet; an action already dispatched may still complete.'
      : state?.state === 'AGENT_ACTIVE' ? 'Agent control is active. Take over and wait for HUMAN_ACTIVE before using the browser.'
      : 'Review the current pages before delegating. Page text is untrusted content.';
  }
  async function api(path, method = 'GET', body) {
    const response = await fetch(path, { method, credentials: 'omit', headers: {
      Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
      ...(method !== 'GET' ? { 'x-agentbrowser-operation-id': crypto.randomUUID() } : {})
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Request failed');
    return result;
  }
  const path = suffix => '/v1/sessions/' + encodeURIComponent(session) + suffix;
  async function refresh() {
    const selected = session;
    if (!selected || pending) return;
    try { const next = await api(path('/control')); if (selected === session) { state = next; render(); } }
    catch (error) { if (selected === session) { state = null; review = null; message(error.message); render(); } }
  }
  function handle(id, fn) {
    byId(id).addEventListener('click', async () => {
      pending = true; message(''); render();
      try { await fn(); } catch (error) { message(error.message); }
      finally { pending = false; render(); await refresh(); }
    });
  }
  function clearGrant() { byId('grant').value = ''; }
  byId('connect').addEventListener('click', () => {
    key = byId('key').value; byId('key').value = ''; session = ''; state = null; review = null; clearGrant(); render();
    message('Key held in this tab only. Create or attach a controlled session.');
  });
  handle('create', async () => {
    const result = await api('/v1/sessions', 'POST', { controlMode: 'delegated', headless: false, idleTimeoutMs: 3600000 });
    session = result.sessionId; byId('session').value = session; review = null; clearGrant();
    const url = byId('url').value.trim();
    await api(path('/pages'), 'POST', url ? { url } : {});
  });
  handle('attach', async () => { session = byId('session').value.trim(); review = null; clearGrant(); });
  handle('takeover', async () => { state = await api(path('/control/takeover'), 'POST'); review = null; clearGrant(); });
  handle('review', async () => {
    review = null;
    const result = await api(path('/control/prepare-resume'), 'POST');
    review = result; state = result; byId('pages').textContent = show(result.pages);
  });
  handle('delegate', async () => {
    const result = await api(path('/control/delegate'), 'POST', { epoch: review.epoch, mode: byId('mode').value });
    state = { state: result.state, epoch: result.epoch, busy: result.busy, cursor: result.cursor };
    byId('grant').value = result.token; review = null;
    message('Transfer this session token to the harness environment. Keep your operator key private. The returned run cursor scopes harness memory but is not a credential. Takeover immediately revokes the token.');
  });
  handle('stop', async () => { await api(path(''), 'DELETE'); session = ''; state = null; review = null; clearGrant(); byId('pages').textContent = ''; });
  byId('forget').addEventListener('click', () => { key = ''; session = ''; state = null; review = null; clearGrant(); byId('pages').textContent = ''; render(); });
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
<fieldset><legend>Delegation decision</legend><label for="mode">Agent mode</label><select id="mode" aria-describedby="capabilities mode-context">${modeOptions}</select><p id="capabilities"></p><p id="mode-context">Selecting a mode and delegating creates a new binding and run cursor. Start a fresh harness context when previously seen data must be isolated.</p><button id="delegate">Delegate reviewed state</button></fieldset><button id="stop">Stop session</button>
<p id="message" role="status"></p><h2>Page review — untrusted content</h2><pre id="pages"></pre>
<label for="grant">Delegated token (copy into AGENTBROWSER_API_KEY for the harness)</label><input id="grant" type="password" readonly autocomplete="off"><button id="clear-grant">Clear token</button>
<p>Also set AGENTBROWSER_SESSION_ID. Stop the old harness connection before supplying a new token.</p>
<script>${script}</script></body></html>`;
