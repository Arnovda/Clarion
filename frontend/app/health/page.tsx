import { redirect } from 'next/navigation';

/**
 * Data quality / health moved into the Catalog "understand your data" surface
 * as the Trust facet. This route redirects there so old links keep working —
 * one door to quality, not two. (Per-source profiling can also be triggered
 * from Sources in Studio.)
 */
export default function HealthPage() {
  redirect('/catalog?facet=trust');
}
