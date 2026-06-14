/**
 * Minimal XML-RPC codec for the Odoo XML-RPC fallback transport.
 *
 * Scope is deliberately small — just enough to call Odoo's `common.authenticate`
 * and `object.execute_kw` and decode their responses. We hand-roll the encoder
 * (a few value types) and use the already-bundled `fast-xml-parser` to decode.
 *
 * Why hand-rolled instead of an npm `xmlrpc` dependency: the worker container
 * is isolation-sensitive (every dependency widens the egress/supply-chain
 * surface), `fast-xml-parser` is already present, and the value space we touch
 * is tiny + fully covered by unit tests. The encoder/decoder are pure and
 * round-trip-tested (`xmlrpcCodec.test.ts`) so the fallback isn't shipped blind.
 *
 * Supported value types: string, int, double, boolean, nil, array (list),
 * struct (object). Dates are passed as strings (Odoo's domain filters accept
 * `'YYYY-MM-DD HH:MM:SS'` string literals), so we never emit dateTime.iso8601.
 */

import { XMLParser } from 'fast-xml-parser';

// ─── Encoding ───────────────────────────────────────────────────────────────
export function encodeMethodCall(method: string, params: readonly unknown[]): string {
  const paramXml = params.map((p) => `<param><value>${encodeValue(p)}</value></param>`).join('');
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${paramXml}</params></methodCall>`;
}

function encodeValue(v: unknown): string {
  if (v === null || v === undefined) return '<nil/>';
  if (typeof v === 'boolean') return `<boolean>${v ? 1 : 0}</boolean>`;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '<nil/>';
    return Number.isInteger(v) && Math.abs(v) <= 2147483647
      ? `<int>${v}</int>`
      : `<double>${v}</double>`;
  }
  if (typeof v === 'string') return `<string>${escapeXml(v)}</string>`;
  if (Array.isArray(v)) {
    const items = v.map((item) => `<value>${encodeValue(item)}</value>`).join('');
    return `<array><data>${items}</data></array>`;
  }
  if (typeof v === 'object') {
    const members = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `<member><name>${escapeXml(k)}</name><value>${encodeValue(val)}</value></member>`)
      .join('');
    return `<struct>${members}</struct>`;
  }
  // Fallback: stringify anything exotic.
  return `<string>${escapeXml(String(v))}</string>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── Decoding ───────────────────────────────────────────────────────────────
export class XmlRpcFault extends Error {
  constructor(message: string, public readonly faultCode: number | string) {
    super(message);
    this.name = 'XmlRpcFault';
  }
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // keep everything as strings; we coerce by tag
  trimValues: true,
});

/**
 * Parse an XML-RPC `methodResponse` and return the decoded first param value.
 * Throws `XmlRpcFault` if the response is a `<fault>`.
 */
export function parseMethodResponse(xml: string): unknown {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const resp = doc.methodResponse as Record<string, unknown> | undefined;
  if (!resp) throw new Error('Malformed XML-RPC response: no methodResponse element');

  if (resp.fault) {
    const faultStruct = decodeValue(getValueNode(resp.fault)) as Record<string, unknown>;
    const code = (faultStruct?.faultCode as number | string) ?? 'unknown';
    const str = (faultStruct?.faultString as string) ?? 'XML-RPC fault';
    throw new XmlRpcFault(String(str), code);
  }

  const params = resp.params as Record<string, unknown> | undefined;
  if (!params || params.param == null) return null;
  const param = toArray(params.param)[0] as Record<string, unknown>;
  return decodeValue(getValueNode(param));
}

/** Extract the `value` node from a `{ value: ... }` wrapper (fault / param). */
function getValueNode(node: unknown): unknown {
  if (node && typeof node === 'object' && 'value' in (node as Record<string, unknown>)) {
    return (node as Record<string, unknown>).value;
  }
  return node;
}

/**
 * Decode a parsed `<value>` node into a JS value. A value node is one of:
 *   { int: '5' } | { i4: '5' } | { double: '1.5' } | { boolean: '1' } |
 *   { string: 'x' } | { nil: '' } | { array: { data: { value: [...] } } } |
 *   { struct: { member: [...] } } | 'bare string' (untyped → string)
 */
function decodeValue(node: unknown): unknown {
  if (node == null) return null;
  // Untyped <value>text</value> → string. Numeric-looking bare values stay
  // strings (XML-RPC requires a type tag for non-strings).
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return typeof node === 'string' ? node : String(node);
  }
  const obj = node as Record<string, unknown>;

  if ('nil' in obj) return null;
  if ('string' in obj) return obj.string === '' ? '' : String(obj.string);
  if ('int' in obj) return parseInt(String(obj.int), 10);
  if ('i4' in obj) return parseInt(String(obj.i4), 10);
  if ('i8' in obj) return parseInt(String(obj.i8), 10);
  if ('double' in obj) return parseFloat(String(obj.double));
  if ('boolean' in obj) return String(obj.boolean) === '1';
  if ('dateTime.iso8601' in obj) return String(obj['dateTime.iso8601']);
  if ('base64' in obj) return String(obj.base64);

  if ('array' in obj) {
    const arr = obj.array as Record<string, unknown> | undefined;
    const data = arr?.data as Record<string, unknown> | undefined;
    if (!data || data.value == null) return [];
    return toArray(data.value).map((v) => decodeValue(v));
  }

  if ('struct' in obj) {
    const struct = obj.struct as Record<string, unknown> | undefined;
    const out: Record<string, unknown> = {};
    if (struct && struct.member != null) {
      for (const m of toArray(struct.member)) {
        const member = m as Record<string, unknown>;
        const name = String(member.name);
        out[name] = decodeValue(getValueNode(member));
      }
    }
    return out;
  }

  // Empty <value/> or unknown shape → null.
  return null;
}

/** fast-xml-parser collapses single-element lists to scalars; normalise. */
function toArray<T = unknown>(v: T | T[]): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
