import { type EngagementScope, validateEngagementScope } from '@agentbrowser/protocol';
import { requestHeaderIssues } from './scope-request-headers.js';

/** Canonical private configuration, distinct from the redacted runtime status. */
export function parseScopeConfiguration(input: string): EngagementScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Invalid AgentBrowser scope JSON');
  }
  const checked = validateEngagementScope(parsed);
  if (!checked.ok)
    throw new Error(
      `Invalid AgentBrowser scope: ${checked.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`
    );
  const issues = checked.value.requestHeaders
    ? requestHeaderIssues(checked.value.requestHeaders)
    : [];
  if (issues.length) throw new Error(`Invalid AgentBrowser scope: ${issues.join('; ')}`);
  return structuredClone(checked.value);
}

/** Header names only: never expose the binding value in a diagnostic. */
export function scopeIdentityHints(scope: {
  identityBindings?: readonly { header: string }[];
  requestHeaders?: readonly { header: string }[];
}): string[] {
  const injected = new Set((scope.requestHeaders ?? []).map((entry) => entry.header.toLowerCase()));
  const missing = [
    ...new Set((scope.identityBindings ?? []).map((entry) => entry.header.toLowerCase())),
  ].filter((name) => !injected.has(name));
  return missing.length
    ? [
        `identityBindings validates marked traffic but does not inject: ${missing.join(', ')}. Use scope.requestHeaders for supported public research markers.`,
      ]
    : [];
}
