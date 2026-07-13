/**
 * SSRF guard for user-supplied database hosts.
 *
 * The SQL source connectors (Postgres / MySQL / SQL Server) dial a host and
 * port that come straight from tenant-supplied connection config. Cloud
 * instance-metadata endpoints live on the link-local range (169.254.0.0/16 —
 * e.g. 169.254.169.254 on Azure/AWS, 169.254.170.2 on ECS) and handing a
 * credentialed connection attempt at them can leak instance identity / tokens.
 * They are NEVER a legitimate database host, so we refuse them.
 *
 * We deliberately do NOT block loopback or private RFC-1918 ranges: those are
 * legitimate targets for local dev and on-prem customer databases. This closes
 * the metadata-endpoint hole without breaking real connections. (A hostname
 * that DNS-resolves to a link-local address is a residual rebinding vector;
 * blocking literal link-local hosts + known metadata hostnames covers the
 * direct case.)
 */

export class UnsafeHostError extends Error {
  constructor(host: string) {
    super(`Refused to connect to disallowed host: ${host}`);
    this.name = 'UnsafeHostError';
  }
}

const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
]);

/** Parse a dotted-quad IPv4 string to its four octets, or null. */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host.trim());
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const;
  if (o.some((n) => n > 255)) return null;
  return [o[0], o[1], o[2], o[3]];
}

/** True if the host is a cloud-metadata / link-local address or hostname. */
export function isLinkLocalOrMetadata(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (METADATA_HOSTNAMES.has(h)) return true;

  const v4 = ipv4Octets(h);
  if (v4) {
    // 169.254.0.0/16 — IPv4 link-local (covers all cloud metadata IPs).
    if (v4[0] === 169 && v4[1] === 254) return true;
  }

  // IPv6 link-local (fe80::/10) and the GCP/AWS IPv6 metadata address.
  if (h.startsWith('fe80:') || h === 'fd00:ec2::254') return true;

  return false;
}

/** Throw `UnsafeHostError` if `host` is a metadata/link-local endpoint. */
export function assertSafeDbHost(host: string | undefined | null): void {
  if (!host) return; // empty host → the driver defaults (e.g. localhost); nothing to guard
  if (isLinkLocalOrMetadata(host)) {
    throw new UnsafeHostError(host);
  }
}
