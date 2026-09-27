/**
 * MCP tool-schema sync gate (foundation-reuse audit S7).
 *
 * Five tools hand-write their input schemas (no protocol schema exists for
 * three of them, and plain protocol spreads would advertise fields the
 * handlers ignore). Until each tool migrates handler+schema together, these
 * assertions pin every hand-written schema to its true surface: a property
 * added to a schema without a handler read - or a handler read dropped from
 * a schema - fails here, and the catalog digest gate fails on the same edit.
 * Each reviewed absence carries its reason inline.
 */

import {
  ObservationRequestSchema,
  ScreenshotRequestSchema,
  SessionRequestSchema,
} from '@agentbrowser/protocol';
import { describe, expect, it } from 'vitest';
import { type McpClient, buildTools } from './mcp-server.js';

const toolSchemas = new Map(
  buildTools({} as McpClient).map((tool) => [tool.name, tool.inputSchema])
);

const propertiesOf = (name: string): Set<string> => {
  const schema = toolSchemas.get(name);
  expect(schema, name).toBeDefined();
  return new Set(Object.keys((schema as { properties: Record<string, unknown> }).properties));
};

describe('MCP tool-schema sync', () => {
  it('browser_session reads exactly the one advertised session identity', () => {
    expect(propertiesOf('browser_session')).toEqual(new Set(['sessionId']));
  });

  it('browser_navigate reads exactly what it advertises', () => {
    // The clean derivation candidate: handler reads url + waitUntil only.
    expect(propertiesOf('browser_navigate')).toEqual(
      new Set(['sessionId', 'pageId', 'url', 'waitUntil'])
    );
  });

  it('browser_pdf reads exactly what it advertises', () => {
    expect(propertiesOf('browser_pdf')).toEqual(
      new Set(['sessionId', 'pageId', 'landscape', 'displayHeaderFooter', 'printBackground'])
    );
  });

  it.each([
    ['browser_observe', ObservationRequestSchema],
    ['browser_screenshot', ScreenshotRequestSchema],
  ] as const)('%s projects the complete canonical request schema', (name, canonical) => {
    const schema = toolSchemas.get(name) as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    const { sessionId, pageId, ...body } = schema.properties;
    expect(body).toEqual(canonical.properties);
    expect(schema.additionalProperties).toBe(false);
  });

  it('browser_create advertises a subset of the session request contract', () => {
    const schema = SessionRequestSchema as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    // The server maps the tool's flat policy-shaped fields (allowServiceWorkers,
    // allowDownloads, ...) onto the protocol's nested `policy` object, so both
    // spellings count as known.
    const sessionProperties = new Set([
      ...Object.keys(schema.properties),
      ...Object.keys(schema.properties.policy?.properties ?? {}),
    ]);
    const advertised = propertiesOf('browser_create');
    advertised.delete('sessionId');
    for (const property of advertised) {
      expect(
        sessionProperties.has(property),
        `browser_create advertises '${property}' but the protocol SessionRequestSchema does not know it`
      ).toBe(true);
    }
  });

  it('browser_observe advertises a subset of the observation contract', () => {
    const observationProperties = new Set(
      Object.keys((ObservationRequestSchema as { properties: Record<string, unknown> }).properties)
    );
    const advertised = propertiesOf('browser_observe');
    advertised.delete('sessionId');
    advertised.delete('pageId');
    // The MCP projection includes the REST diff and pagination vocabulary.
    expect(advertised.has('sinceRevision')).toBe(true);
    for (const property of advertised) {
      expect(
        observationProperties.has(property),
        `browser_observe advertises '${property}' but the protocol ObservationRequestSchema does not know it`
      ).toBe(true);
    }
  });
});
