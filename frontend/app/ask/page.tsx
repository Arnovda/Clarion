'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * /ask redirects to /query which now uses the new AppShell layout.
 * This route exists so the icon rail link (/ask) works.
 * Eventually /query will be renamed to /ask and this redirect removed.
 */
export default function AskRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/query'); }, [router]);
  return null;
}
