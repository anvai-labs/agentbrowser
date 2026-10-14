import type { PolicyDecision } from '@agentbrowser/protocol';
import type { AuthorizationRequest, Authorizer } from './authorizer.js';

/**
 * TD-BROWSER-15 phase 4: shadow mode. `AGENTBROWSER_POLICY_SHADOW=1` without
 * a policy file evaluates the generated document in Cedar alongside
 * `LegacyAuthorizer`. Legacy decides; divergences are logged at `warn` with
 * both rule ids. A trap in the shadow marks only the shadow unhealthy — never
 * the legacy decisions — and `/health` exposes the authorizer's health as a
 * boolean only.
 *
 * It runs for at least one release before deprecation warnings start.
 */
export class ShadowAuthorizer implements Authorizer {
  readonly version = 'shadow';

  constructor(
    private readonly deciding: Authorizer,
    private readonly shadow: Authorizer,
    private readonly warn: (message: string) => void = console.warn
  ) {}

  /** The shadow's health only; the deciding authorizer has its own. */
  get shadowHealthy(): boolean {
    const health = (this.shadow as { healthy?: boolean }).healthy;
    return health === undefined ? true : health;
  }

  decide(request: AuthorizationRequest): PolicyDecision {
    const decision = this.deciding.decide(request);
    let shadowDecision: PolicyDecision | undefined;
    try {
      shadowDecision = this.shadow.decide(request);
    } catch (error) {
      this.warn(
        `[agentbrowser] policy shadow threw on ${request.action}: ${(error as Error).message}`
      );
      return decision;
    }
    if (
      shadowDecision.allowed !== decision.allowed ||
      shadowDecision.ruleMatched !== decision.ruleMatched
    ) {
      this.warn(
        `[agentbrowser] policy shadow diverged on ${request.action}: legacy ${decision.allowed}/${decision.ruleMatched}, cedar ${shadowDecision.allowed}/${shadowDecision.ruleMatched}; legacy decided`
      );
    }
    return decision;
  }
}
