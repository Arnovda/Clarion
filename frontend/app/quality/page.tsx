'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The quality UI now lives inside the Definitions page as the "Quality" tab.
 * This route is kept only to redirect any bookmarked links.
 */
export default function QualityRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/semantic'); }, [router]);
  return null;
}
