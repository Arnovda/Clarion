import { redirect } from 'next/navigation';

/**
 * The Build page was folded into the Catalog on 2026-09-26 (owner: "Is there
 * any use to still having the Build pane? Everything is done through catalog,
 * relations and definitions now"). Its four jobs moved rather than vanished:
 * creating a source's subjects and upgrading keys are lines on the catalog's
 * landing, a full rebuild is on the source's ⋯ menu, hide/show on the
 * subject's — see components/catalog/subjectBuilds.tsx. This route redirects
 * so old links keep working: one door, not two.
 */
export default function BuildPage() {
  redirect('/catalog');
}
