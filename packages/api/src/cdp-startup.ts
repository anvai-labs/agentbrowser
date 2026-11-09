import { parseOperatorCdpEndpoint } from '@agentbrowser/engine-playwright';
import { attachmentHintFromHostname, captureAttachmentHint } from '@agentbrowser/protocol';

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

/**
 * ADR-034: the daemon host identity agents see in the session view's
 * self-identifying `attachment` line — the hostname's first label (operational,
 * non-sensitive). Undefined over an unrepresentable hostname.
 */
export function hostHintFromHostname(hostname: string): string | undefined {
  return attachmentHintFromHostname(hostname);
}

/**
 * ADR-034: the operator profile basename hint (AGENTBROWSER_CDP_PROFILE_HINT).
 * The daemon cannot discover the attached Chrome's profile directory over CDP,
 * so the operator who launched Chrome with `--user-data-dir` names its
 * basename here; a path-like value is refused (hints are never full paths).
 */
export function profileHintFromEnvironment(env: {
  AGENTBROWSER_CDP_PROFILE_HINT?: string | undefined;
}): { profileHint?: string; warning?: string } {
  const raw = env.AGENTBROWSER_CDP_PROFILE_HINT;
  if (raw === undefined) return {};
  const hint = captureAttachmentHint(raw);
  if (hint === undefined)
    return {
      warning:
        'AGENTBROWSER_CDP_PROFILE_HINT must be a short profile basename (letters, digits, dot, dash; no path separators) — the session view will carry no profile hint.',
    };
  return { profileHint: hint };
}
