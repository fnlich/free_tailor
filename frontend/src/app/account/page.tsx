'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The old "Your account" page, now split across Settings.
 *
 * Kept as a redirect because the address may be bookmarked, and each of the
 * page's anchors - #sheet, #credits, #subscription - went to a section that
 * now has a home of its own. The hash never reaches the server, which is why
 * this is a client effect rather than a `redirect()` in config.
 */
function destination(hash: string): string {
  if (hash === '#subscription') return '/settings/subscription';
  if (hash === '#credits') return '/credits';
  // The old page's section was `#sheet`; anything naming a sheet means it.
  if (hash.includes('sheet')) return '/settings/job-sheet';
  return '/settings';
}

export default function AccountRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace(destination(window.location.hash.toLowerCase()));
  }, [router]);

  return null;
}
