/**
 * Surface-neutral wire vocabulary shared by the REST server and the SDK
 * client. Route families listed here admit themselves through their own
 * authority (control, operations, application) and never take the generic
 * controlled-mutation envelope: the server's route wrapper skips its
 * admission ticket for them and the SDK does not mint an operation-ID
 * header for them. Both sides consume this one constant, so a new
 * self-admitting family cannot drift between server and client.
 */
export const SELF_ADMITTING_ROUTE_SEGMENTS = Object.freeze([
  '/control',
  '/operations/',
  '/application',
  // TD-BROWSER-16: the cookie handoff is registered safe server-side; its
  // pre-approval call only mints an approval (quota-bounded), and a phantom
  // operation id in the APPROVAL_REQUIRED relay would look reconcilable when
  // it is recorded nowhere.
  '/cookies/handoff',
] as const);
