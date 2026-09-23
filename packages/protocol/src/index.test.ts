/**
 * Barrel surface test.
 *
 * The package's public API is whatever `./index.js` re-exports. Consumers
 * (REST, SDK, MCP, CLI) import from the package root, so this pins that the
 * single sources of truth stay reachable through the barrel - including the
 * compiled-only contract checks (contracts.ts) and the shared wire paths
 * (wire-paths.ts), which no behavioral test imports directly.
 */

import { describe, expect, it } from 'vitest';
import * as protocol from './index.js';

describe('protocol barrel exports', () => {
  it('exposes the schema validation entry points', () => {
    expect(protocol.validate).toBeTypeOf('function');
    expect(protocol.isValid).toBeTypeOf('function');
    expect(protocol.SessionRequestSchema).toBeDefined();
    expect(protocol.ActionSchema).toBeDefined();
    expect(protocol.OutcomeRunReportSchema).toBeDefined();
  });

  it('exposes the compiled request validators', () => {
    expect(protocol.validateSessionRequest).toBeTypeOf('function');
    expect(protocol.validateAction).toBeTypeOf('function');
    expect(protocol.validatePlanStep).toBeTypeOf('function');
  });

  it('exposes the flat wire action vocabulary', () => {
    expect(protocol.decodeWireAction).toBeTypeOf('function');
    expect(protocol.validateWireAction).toBeTypeOf('function');
    expect(protocol.validateWireActionBatch).toBeTypeOf('function');
    expect(protocol.MAX_BATCH_STEPS).toBe(20);
  });

  it('exposes the error taxonomy and helpers', () => {
    expect(protocol.ErrorCode).toBeDefined();
    expect(protocol.createApiError).toBeTypeOf('function');
    expect(protocol.createApiErrorDetail).toBeTypeOf('function');
    expect(protocol.isApiError).toBeTypeOf('function');
    expect(protocol.formatErrorForUser).toBeTypeOf('function');
    expect(protocol.UsageError).toBeTypeOf('function');
  });

  it('exposes the delivered action/wait/observation vocabularies', () => {
    expect(protocol.DELIVERED_ACTION_TYPES).toContain('click');
    expect(protocol.DELIVERED_WAIT_TYPES).toContain('load');
    expect(protocol.DELIVERED_OBSERVATION_MODES).toContain('interactive');
  });

  it('exposes the outcome projection parsers', () => {
    expect(protocol.parseOutcomeProjection).toBeTypeOf('function');
    expect(protocol.parseOutcomeRunReport).toBeTypeOf('function');
    expect(protocol.parseTrustedVerifierDescriptor).toBeTypeOf('function');
    expect(protocol.GROUNDING_LAYERS).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
  });

  it('exposes the control vocabulary', () => {
    expect(protocol.CONTROL_OPERATION_ID).toBeInstanceOf(RegExp);
  });

  it('exposes the shared self-admitting route segments, deep-frozen', () => {
    expect(protocol.SELF_ADMITTING_ROUTE_SEGMENTS).toEqual([
      '/control',
      '/operations/',
      '/application',
    ]);
    expect(Object.isFrozen(protocol.SELF_ADMITTING_ROUTE_SEGMENTS)).toBe(true);
  });

  it('exposes the ADR-015 compiled type-contract markers', () => {
    // These are `null as unknown as ...` markers enforced by the type-check,
    // not runtime values: their contract is that the keys exist on the barrel.
    expect('sessionRequestSchemaMatchesType' in protocol).toBe(true);
    expect('sessionRequestTypeMatchesSchema' in protocol).toBe(true);
    expect('actionSchemaMatchesType' in protocol).toBe(true);
    expect('actionTypeMatchesSchema' in protocol).toBe(true);
  });
});
