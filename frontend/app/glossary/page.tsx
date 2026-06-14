import { redirect } from 'next/navigation';

/**
 * Glossary moved into the Catalog "understand your data" surface as a facet.
 * This route now redirects there so old links keep working — there's a single
 * door to the glossary, not two.
 */
export default function GlossaryPage() {
  redirect('/catalog?facet=glossary');
}
