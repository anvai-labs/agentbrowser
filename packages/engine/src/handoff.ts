/**
 * TD-BROWSER-16 phase 6 (ADR-025 section 3): the init script injected into a
 * handoff-marked session's live context — every frame (the main document,
 * synchronous about:blank iframes, window.open popups) loses WebRTC's peer
 * connection constructors, so the operator's cookies cannot leak the local
 * network or real IP through a data channel.
 *
 * Shared by the api service (the injector) and the engine suites (the
 * behavioral proof) so both assert the SAME text: a no-op variant here fails
 * the real-browser tests, not just a substring check.
 */
export const HANDOFF_RTC_REMOVAL_INIT_SCRIPT =
  '(() => { const remove = (name) => { try { delete window[name]; } catch {} ' +
  'Object.defineProperty(window, name, { get: () => undefined, configurable: true }); }; ' +
  "remove('RTCPeerConnection'); remove('webkitRTCPeerConnection'); })();";
