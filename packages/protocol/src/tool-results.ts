import { Type } from '@sinclair/typebox';
import { SessionEventsPageSchema } from './event-replay.js';
import { SessionResponseSchema } from './schemas.js';

/**
 * T0 M2: result shapes of MCP tools that previously advertised no outputSchema. MCP clients
 * validate structuredContent against the advertised schema, so these describe the live REST/SDK
 * results exactly where the fields are guaranteed and stay OPEN (additional properties allowed)
 * so an additive server field never breaks an agent. Validated against real results end to end
 * in packages/api/src/mcp-output-schemas.test.ts.
 */

const pageProperties = {
  pageId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  status: Type.String({ description: 'Page lifecycle status as the engine reports it.' }),
  url: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
};

/** A page as the service reports it (create, list). */
export const PageResponseSchema = Type.Object(pageProperties, { $id: 'urn:agentbrowser:page:v1' });

/** MCP `create`: the session plus the page provisioned with it. */
export const SessionCreatedResultSchema = Type.Object(
  {
    ...SessionResponseSchema.properties,
    pageId: Type.String({
      minLength: 1,
      description: 'The initial page created with the session.',
    }),
  },
  { $id: 'urn:agentbrowser:session-created:v1' }
);

/** MCP `pages`. */
export const PageListResultSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    pages: Type.Array(Type.Object(pageProperties)),
  },
  { $id: 'urn:agentbrowser:page-list:v1' }
);

/** MCP `close`. */
export const SessionClosedResultSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1 }),
    closed: Type.Literal(true),
  },
  { $id: 'urn:agentbrowser:session-closed:v1' }
);

/** MCP `events_replay`: the paging envelope (the tool always requests the object form). */
export const SessionEventsPageResultSchema = Type.Object(
  { ...SessionEventsPageSchema.properties },
  { $id: 'urn:agentbrowser:session-events-page:v1' }
);
