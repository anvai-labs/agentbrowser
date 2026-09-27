import { parseOperatorCdpEndpoint } from '@agentbrowser/engine-playwright';

/** Packaged-service startup only. Never accepts session/request data. */
export function operatorCdpFromEnvironment(env: {
  AGENTBROWSER_CDP_ENDPOINT?: string | undefined;
  AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS?: string | undefined;
}): Readonly<{ endpoint: string; allowUnenforcedEgress: true }> | undefined {
  const endpoint = env.AGENTBROWSER_CDP_ENDPOINT;
  const acknowledgment = env.AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS;
  if (endpoint === undefined && acknowledgment === undefined) return undefined;
  if (!endpoint || acknowledgment !== 'true')
    throw new Error(
      'Operator attachment requires both AGENTBROWSER_CDP_ENDPOINT and AGENTBROWSER_CDP_ALLOW_UNENFORCED_EGRESS=true. Use a dedicated Chrome profile; existing-profile traffic is not contained by AgentBrowser.'
    );
  return Object.freeze({
    endpoint: parseOperatorCdpEndpoint(endpoint),
    allowUnenforcedEgress: true,
  });
}
