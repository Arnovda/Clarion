/**
 * Cross-component signal: "the set of visible topics changed".
 *
 * IconRail fetches the YOUR DATA rows once on mount and the shell layout
 * persists across client-side navigations, so a build finishing or a
 * show/hide toggle on /build would otherwise not reach the rail until a
 * full reload. The Build page dispatches this window event after either;
 * the rail listens and re-fetches. A plain Event on window — no payload,
 * no store — because the rail already knows how to load its own data.
 */
export const TOPICS_CHANGED_EVENT = 'clarion:topics-changed';
