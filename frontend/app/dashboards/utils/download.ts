/**
 * Authenticated file download helper.
 * Used for exporting dashboards to CSV/XLSX/PDF behind the JWT-protected API.
 */

import { getToken } from '@/lib/auth';

export function downloadFile(url: string, filename: string) {
  const token = getToken();
  fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then((r) => {
      if (!r.ok) throw new Error('Export failed');
      return r.blob();
    })
    .then((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch(() => alert('Export failed'));
}
