/**
 * Cross-component signal: "the set of subjects changed".
 *
 * The catalog's subject builds (components/catalog/subjectBuilds.tsx)
 * dispatch this window event after a build finishes or a subject is hidden
 * or shown; the catalog page listens and reloads its tree. It was the Build
 * page's until that page was folded into the Catalog (2026-09-26). A plain
 * Event on window — no payload, no store — because a listener already knows
 * how to load its own data.
 */
export const TOPICS_CHANGED_EVENT = 'clarion:topics-changed';
