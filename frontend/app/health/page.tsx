import { redirect } from 'next/navigation';

/**
 * Data quality / health lives on the Catalog's landing (what needs you, then
 * the health overview) since the catalog became the workspace. This route
 * redirects so old links keep working — one door to quality, not two.
 * (Per-source profiling can also be triggered from Sources in Studio.)
 */
export default function HealthPage() {
  redirect('/catalog');
}
