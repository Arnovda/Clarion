import { describe, expect, it } from 'vitest';
import { encodeMethodCall, parseMethodResponse, XmlRpcFault } from './xmlrpcCodec';

describe('xmlrpcCodec — encode', () => {
  it('encodes authenticate(db, user, key, {})', () => {
    const xml = encodeMethodCall('authenticate', ['demo', 'me@x.com', 'secret', {}]);
    expect(xml).toContain('<methodName>authenticate</methodName>');
    expect(xml).toContain('<string>demo</string>');
    expect(xml).toContain('<string>me@x.com</string>');
    expect(xml).toContain('<struct></struct>');
  });

  it('encodes scalar types', () => {
    expect(encodeMethodCall('m', [5])).toContain('<int>5</int>');
    expect(encodeMethodCall('m', [3.14])).toContain('<double>3.14</double>');
    expect(encodeMethodCall('m', [true])).toContain('<boolean>1</boolean>');
    expect(encodeMethodCall('m', [false])).toContain('<boolean>0</boolean>');
    expect(encodeMethodCall('m', [null])).toContain('<nil/>');
  });

  it('encodes a domain (array of arrays + string)', () => {
    const xml = encodeMethodCall('m', [[['write_date', '>=', '2026-01-01 00:00:00']]]);
    expect(xml).toContain('<array>');
    expect(xml).toContain('<string>write_date</string>');
    expect(xml).toContain('<string>&gt;=</string>');
  });

  it('escapes XML metacharacters', () => {
    expect(encodeMethodCall('m', ['a & b < c'])).toContain('a &amp; b &lt; c');
  });
});

describe('xmlrpcCodec — decode', () => {
  const wrap = (valueXml: string) =>
    `<?xml version="1.0"?><methodResponse><params><param><value>${valueXml}</value></param></params></methodResponse>`;

  it('decodes an int (authenticate uid)', () => {
    expect(parseMethodResponse(wrap('<int>7</int>'))).toBe(7);
  });

  it('decodes a boolean', () => {
    expect(parseMethodResponse(wrap('<boolean>1</boolean>'))).toBe(true);
    expect(parseMethodResponse(wrap('<boolean>0</boolean>'))).toBe(false);
  });

  it('decodes a struct (fields_get-like)', () => {
    const struct = `<struct>
      <member><name>type</name><value><string>char</string></value></member>
      <member><name>store</name><value><boolean>1</boolean></value></member>
    </struct>`;
    expect(parseMethodResponse(wrap(struct))).toEqual({ type: 'char', store: true });
  });

  it('decodes an array of structs (search_read-like)', () => {
    const row = (id: number, name: string) => `<value><struct>
      <member><name>id</name><value><int>${id}</int></value></member>
      <member><name>name</name><value><string>${name}</string></value></member>
    </struct></value>`;
    const arr = `<array><data>${row(1, 'A')}${row(2, 'B')}</data></array>`;
    expect(parseMethodResponse(wrap(arr))).toEqual([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ]);
  });

  it('decodes a single-element array (parser collapse handled)', () => {
    const arr = `<array><data><value><int>9</int></value></data></array>`;
    expect(parseMethodResponse(wrap(arr))).toEqual([9]);
  });

  it('decodes a many2one [id, label] pair', () => {
    const arr = `<array><data><value><int>42</int></value><value><string>Acme</string></value></data></array>`;
    expect(parseMethodResponse(wrap(arr))).toEqual([42, 'Acme']);
  });

  it('throws XmlRpcFault on a fault response', () => {
    const fault = `<?xml version="1.0"?><methodResponse><fault><value><struct>
      <member><name>faultCode</name><value><int>2</int></value></member>
      <member><name>faultString</name><value><string>Access Denied</string></value></member>
    </struct></value></fault></methodResponse>`;
    expect(() => parseMethodResponse(fault)).toThrow(XmlRpcFault);
    try {
      parseMethodResponse(fault);
    } catch (e) {
      expect((e as XmlRpcFault).faultCode).toBe(2);
      expect((e as XmlRpcFault).message).toContain('Access Denied');
    }
  });
});
