/** No environment value or endpoint is ever included in a configuration error. */
export function deploymentModeFromEnvironment(env: {
  AGENTBROWSER_HOSTED?: string | undefined;
}): 'local' | 'hosted' {
  const value = env.AGENTBROWSER_HOSTED;
  if (value === undefined || value === '' || value === 'false' || value === '0') return 'local';
  if (value === 'true' || value === '1') return 'hosted';
  throw new Error('AGENTBROWSER_HOSTED must be true, false, 1, or 0');
}
