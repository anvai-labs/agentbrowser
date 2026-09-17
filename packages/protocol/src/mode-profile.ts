import { Type } from '@sinclair/typebox';

/** Trusted runtime profiles. Mode names never grant capabilities by themselves. */
export const AGENT_MODE_IDS = Object.freeze([
  'qa',
  'operations',
  'audit',
  'appsec',
  'bounty',
  'forms',
  'application',
] as const);

export type AgentMode = (typeof AGENT_MODE_IDS)[number];
export const DEFAULT_AGENT_MODE: AgentMode = 'qa';
export const AgentModeSchema = Type.Union(AGENT_MODE_IDS.map((mode) => Type.Literal(mode)));

export const AGENT_CAPABILITIES = Object.freeze([
  'session.control',
  'session.manage',
  'page.navigate',
  'page.observe',
  'page.interact',
  'page.form',
  'page.extract',
  'page.capture',
  'application.discover',
  'application.execute',
] as const);

export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export interface AgentModeProfile {
  readonly id: AgentMode;
  readonly revision: 1;
  readonly capabilities: readonly AgentCapability[];
}

// Application capabilities are opt-in per mode, never part of the browser
// baseline: an agent driving pages must stay fenced out of the application
// authority (no browser-click fallback for an application operation).
const APPLICATION_CAPABILITIES: readonly AgentCapability[] = [
  'application.discover',
  'application.execute',
];
const BROWSER_PROFILE = AGENT_CAPABILITIES.filter(
  (capability) => !APPLICATION_CAPABILITIES.includes(capability)
);
const FULL_BROWSER_PROFILE = BROWSER_PROFILE;
const AUDIT_PROFILE = BROWSER_PROFILE.filter((capability) => capability !== 'page.form');
// The application mode drives the application surface only: discovery,
// execution and receipt reads. It never receives browser capabilities.
const APPLICATION_PROFILE = [
  'session.control',
  ...APPLICATION_CAPABILITIES,
] as const satisfies readonly AgentCapability[];

const profiles = Object.freeze({
  qa: profile('qa', FULL_BROWSER_PROFILE),
  operations: profile('operations', FULL_BROWSER_PROFILE),
  audit: profile('audit', AUDIT_PROFILE),
  appsec: profile('appsec', FULL_BROWSER_PROFILE),
  bounty: profile('bounty', FULL_BROWSER_PROFILE),
  forms: profile('forms', FULL_BROWSER_PROFILE),
  application: profile('application', APPLICATION_PROFILE),
} satisfies Record<AgentMode, AgentModeProfile>);

function profile(id: AgentMode, capabilities: readonly AgentCapability[]): AgentModeProfile {
  return Object.freeze({ id, revision: 1, capabilities: Object.freeze([...capabilities]) });
}

export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === 'string' && (AGENT_MODE_IDS as readonly string[]).includes(value);
}

export function agentModeProfile(mode: AgentMode): AgentModeProfile {
  return profiles[mode];
}

export function agentModeAllows(mode: AgentMode, capability: AgentCapability): boolean {
  return agentModeProfile(mode).capabilities.includes(capability);
}
