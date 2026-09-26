/** Build first. Real transport qualification; --live replays public consumer targets. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { loadConsumerSmokeRuntime } from './consumer-smoke-runtime.mjs';
import { checkMcp, runExecutable } from './release-smoke.mjs';

const runtime = await loadConsumerSmokeRuntime({
    headed: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
});
const {
  values: { headed, live },
  version,
  buildServer,
  PlaywrightChromiumEngine,
  NetworkPolicy,
  cliCommand,
  mcpCommand,
  provenance,
} = runtime;
const { AgentBrowserClient } = runtime.sdk;
const { isNavigationFailureReason } = runtime.protocol;
const fixture = createServer((_request, response) => {
  response.writeHead(502, { 'x-agentbrowser-blocked': '1', 'x-agentbrowser-reason': 'dns_nxdomain' });
  response.end('<!doctype html><button>Ordinary origin content</button>');
});
const key = randomUUID();
const server = await buildServer({
  engine: new PlaywrightChromiumEngine(),
  networkPolicy: new NetworkPolicy({blockPrivateIPs:true, blockMetadata:true, allowedPrivateCIDRs:['192.168.1.89/32']}),
  apiKeys: new Map([[createHash('sha256').update(key).digest('hex'),'navigation-smoke']]),
});
const observations = [];
try {
  await new Promise(resolve => fixture.listen(0,'127.0.0.1',resolve));
  const baseUrl = await server.listen({host:'127.0.0.1',port:0});
  const client = new AgentBrowserClient({baseUrl,apiKey:key,timeout:60000});
  const env = {...process.env, AGENTBROWSER_BASE_URL:baseUrl, AGENTBROWSER_API_KEY:key,AGENTBROWSER_MODE:'qa'};
  delete env.AGENTBROWSER_SESSION_ID;
  const targets = [
    {url:`http://127.0.0.1:${fixture.address().port}/`,expected:'success'},
    {url:'http://192.168.1.90/',expected:'egress_policy'},
    {url:'https://navigation-smoke.invalid/',expected:'dns_unresolved'},
    ...(live ? [
      {url:'https://docs.montecarlodata.com/docs/'},
      {url:'https://www.montecarlodata.com/'},
      {url:'https://finance.yahoo.com/quote/TRV/key-statistics/'},
      {url:'http://192.168.1.89:8080/'},
    ] : []),
  ];
  const classify = value => {
    if(value.status === 'success') {assert.equal(value.reason,undefined);return 'success';}
    const reason = value.reason ?? value.error?.details?.reason;
    assert.ok(isNavigationFailureReason(reason), `Missing bounded reason: ${JSON.stringify(value)}`);
    return reason;
  };
  const session = await client.sessions.create({tenantId:'navigation-smoke',headless:!headed,ttlMs:900000,idleTimeoutMs:300000});
  const page = await client.sessions.createPage(session.sessionId);
  try {
    await checkMcp(mcpCommand,{
      expectedVersion:version,env,timeoutMs:600000,
      async exercise({request}) {
        for(const target of targets) {
          const path = `/v1/sessions/${session.sessionId}/pages/${page.pageId}/navigate`;
          const response = await fetch(baseUrl+path,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({url:target.url,waitUntil:'domcontentloaded'})});
          const rest = await response.json();
          const sdk = await client.sessions.navigate(session.sessionId,page.pageId,{url:target.url,waitUntil:'domcontentloaded'}).catch(error => ({error:{code:error.code,details:error.details}}));
          const mcp = await request('tools/call',{name:'browser_navigate',arguments:{sessionId:session.sessionId,pageId:page.pageId,url:target.url,waitUntil:'domcontentloaded'}});
          const mcpValue = mcp.structuredContent ?? JSON.parse(mcp.content[0].text);
          const expected = classify(rest);
          const cli = await runExecutable([...cliCommand,'--base-url',baseUrl,'--timeout','60000','--json','navigate',session.sessionId,page.pageId,target.url,'--wait-until','domcontentloaded'],{env,timeoutMs:65000,expectedExitCode: expected === 'success' ? 0 : 1});
          const cliValue = JSON.parse(cli.stdout.trim() || cli.stderr.trim());
          const outcomes = {rest:expected,sdk:classify(sdk),mcp:classify(mcpValue),cli:classify(cliValue)};
          assert.equal(mcp.isError === true, outcomes.mcp !== 'success');
          if(target.expected) for(const outcome of Object.values(outcomes)) assert.equal(outcome,target.expected);
          observations.push({url:target.url,httpStatus:response.status,...outcomes});
          console.log(JSON.stringify({observation:observations.at(-1)}));
        }
      },
    });
  } finally {await client.sessions.close(session.sessionId);}
} finally {
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => server.close()),
    Promise.resolve().then(async () => {
      fixture.closeAllConnections();
      if (fixture.listening) await new Promise((resolve, reject) =>
        fixture.close((error) => error ? reject(error) : resolve()));
    }),
  ]);
  const failures = cleanup.filter((entry) => entry.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((entry) => entry.reason), 'Navigation smoke cleanup failed');
}
console.log(JSON.stringify({status:'pass',version,headed,live,
  ...provenance,
  observations,limits:'Live targets are observations, not deterministic wall/DNS fixtures. No bot-wall inference; owned service/session only.'}));
