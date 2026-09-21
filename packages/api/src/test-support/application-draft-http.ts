import { type IncomingMessage, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DRAFT_UPLOAD_MAX_BYTES, type createApplicationDraft } from './application-draft.js';

type Draft = ReturnType<typeof createApplicationDraft>;

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of request) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (size > limit) throw new Error('Invalid draft input');
    chunks.push(bytes);
  }
  if (!request.complete) throw new Error('Invalid draft input');
  return Buffer.concat(chunks);
}

/** Cooperative, loopback-only test app; it never exposes a submission operation. */
export async function startDraftFixture(
  draft: Draft,
  options: { brokenUi?: boolean; beforeUploadCommit?: () => Promise<void> } = {}
) {
  const initial = draft.read();
  let submissionAttempts = 0;
  let uploadAttempts = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && request.url === '/submit') {
        submissionAttempts++;
        response.writeHead(403).end('Submission unavailable');
        return;
      }
      if (request.method === 'POST') {
        // Capture identity/version before reading an asynchronous upload body.
        const incarnation = request.headers['x-draft-incarnation'];
        const rawVersion = request.headers['x-draft-version'];
        if (
          incarnation !== initial.incarnation ||
          typeof rawVersion !== 'string' ||
          !/^(0|[1-9][0-9]*)$/.test(rawVersion)
        )
          throw new Error('Invalid draft input');
        const version = Number(rawVersion);
        if (!Number.isSafeInteger(version)) throw new Error('Invalid draft input');
        let result: ReturnType<Draft['read']>;
        if (request.url === '/upload') {
          uploadAttempts++;
          const encodedName = request.headers['x-draft-filename'];
          const type = request.headers['x-draft-filetype'];
          if (typeof encodedName !== 'string' || typeof type !== 'string')
            throw new Error('Invalid draft input');
          const name = decodeURIComponent(encodedName);
          const bytes = await readBody(request, DRAFT_UPLOAD_MAX_BYTES);
          await options.beforeUploadCommit?.();
          result = draft.upload(version, { name, type, bytes });
        } else if (request.url === '/fields') {
          const patch = JSON.parse((await readBody(request, 4096)).toString('utf8'));
          result = draft.update(version, patch);
        } else if (request.url === '/remove') {
          await readBody(request, 0);
          result = draft.remove(version);
        } else {
          response.writeHead(404).end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result));
        return;
      }
      if (request.method !== 'GET' || request.url !== '/') {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><title>Synthetic draft oracle</title>
        <form onsubmit="return false">
          <label>Full name<input id="fullName" data-automation-id="fullName"></label>
          <fieldset><legend>Current employment</legend><label>Company name<input id="currentCompany" data-automation-id="currentCompany"></label></fieldset>
          <fieldset><legend>Previous employment</legend><label>Company name<input id="previousCompany" data-automation-id="previousCompany"></label></fieldset>
          <label>Work preference<select id="preference"><option value="">Choose</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option></select></label>
          <label>Relocation<select id="relocation"><option value="">Unanswered</option><option value="yes">Yes</option><option value="no">No</option></select></label>
          <label>Referral<input id="referral"></label>
          <label>Accept terms<input id="terms" type="checkbox"></label>
          <input id="source" type="hidden" value="direct">
          <label>Resume<input id="resume" type="file" accept="application/pdf"></label>
          <button id="remove" type="button">Remove attachment</button>
          <button id="sync" type="button" disabled></button>
        </form>
        <script>
          let version = ${initial.version}, pending = 0, failed = false;
          let queue = Promise.resolve();
          const incarnation = ${JSON.stringify(initial.incarnation)};
          const status = () => {
            const file = document.getElementById('resume').files[0];
            document.getElementById('sync').textContent = 'Draft sync ' + JSON.stringify({version,pending,failed,
              preference:document.getElementById('preference').value,
              attachment:file ? {name:file.name,type:file.type,size:file.size} : null});
          };
          const enqueue = (path, body, headers = {}) => {
            pending++; status();
            queue = queue.then(async () => {
              if (failed) throw new Error('Prior commit failed');
              const result = await fetch(path, {method:'POST',headers:{'x-draft-incarnation':incarnation,'x-draft-version':String(version),...headers},body});
              if (!result.ok) throw new Error('Draft commit failed');
              version = (await result.json()).version;
            }).catch(() => { failed = true; }).finally(() => { pending--; status(); });
          };
          for (const id of ['fullName','currentCompany','previousCompany','referral','preference','relocation','terms']) {
            const control = document.getElementById(id);
            control.addEventListener(['preference','relocation','terms'].includes(id) ? 'change' : 'input', () => {
              if (${options.brokenUi === true} && id === 'fullName') return;
              const value = id === 'terms' ? control.checked : id === 'relocation' ? (control.value === '' ? null : control.value === 'yes') : control.value;
              enqueue('/fields', JSON.stringify({[id]:value}));
            });
          }
          document.getElementById('resume').addEventListener('change', event => {
            const file = event.target.files[0];
            if (file) enqueue('/upload', file, {'x-draft-filename':encodeURIComponent(file.name),'x-draft-filetype':file.type});
          });
          document.getElementById('remove').addEventListener('click', () => {
            document.getElementById('resume').value = '';
            enqueue('/remove', '');
          });
          status();
        </script>`);
    } catch (error) {
      if (!response.destroyed)
        response
          .writeHead(error instanceof Error && error.message === 'VERSION_CONFLICT' ? 409 : 400)
          .end('Draft request refused');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    submissionAttempts: () => submissionAttempts,
    uploadAttempts: () => uploadAttempts,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
