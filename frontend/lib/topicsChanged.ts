/**
 * Cross-component signal: "the set of visible topics changed".
 *
 * The Build page dispatches this window event after a build finishes or a
 * show/hide toggle. Since Option A (2026-08-20) the rail no longer renders
 * per-topic rows, so NOTHING listens today — the dispatch is kept because
 * the shell persists across client navigations and any mounted surface
 * showing the topic set (the /subjects hub, if it ever stays mounted) can
 * subscribe without new plumbing. A plain Event on window — no payload,
 * no store — because a listener already knows how to load its own data.
 */
export const TOPICS_CHANGED_EVENT = 'clarion:topics-changed';
