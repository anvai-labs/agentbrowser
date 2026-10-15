import type { AuthorizationRequest, Authorizer } from './authorizer.js';

/**
 * TD-BROWSER-15 phase 4: binds one tenant into every request's context before
 * delegating, so a shared authorizer decides per session. A no-keys
 * deployment binds nothing: the authorizer's own default tenant decides
 * (the implicit `Tenant::"local"`), whatever tenantId a caller claims.
 */
export class TenantBindingAuthorizer implements Authorizer {
  readonly version: string;

  constructor(
    private readonly inner: Authorizer,
    private readonly tenantId: string | undefined
  ) {
    this.version = inner.version;
  }

  decide(request: AuthorizationRequest): ReturnType<Authorizer['decide']> {
    if (this.tenantId === undefined) return this.inner.decide(request);
    // The binding always wins: a caller-supplied tenantId is never trusted.
    return this.inner.decide(bindTenant(request, this.tenantId));
  }
}

function bindTenant(request: AuthorizationRequest, tenantId: string): AuthorizationRequest {
  // A switch per branch keeps each context assignable to its own request type.
  switch (request.action) {
    case 'act':
    case 'act.unattended':
      return { action: request.action, context: { ...request.context, tenantId } };
    case 'request.loopback':
    case 'request.private':
      return { action: request.action, context: { ...request.context, tenantId } };
    case 'cookie.handoff':
      // TD-BROWSER-16 phase 6: the domain context rides along; the tenant is
      // bound by the service, never the caller.
      return { action: request.action, context: { ...request.context, tenantId } };
    default:
      return { action: request.action, context: { ...request.context, tenantId } };
  }
}
