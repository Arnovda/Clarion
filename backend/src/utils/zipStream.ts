/**
 * A streaming ZIP writer (STORE, no compression) for downloads that must not
 * be held in memory — the tenant data export writes every table's rows into
 * one archive and a tenant can hold millions of rows.
 *
 * Dependency-free on purpose (the same house call as xlsxBuilder's zip and
 * the hand-rolled xlsx reader: the npm archivers carry advisories the audit
 * gate would have to allowlist). Each entry uses the DATA DESCRIPTOR form
 * (general-purpose bit 3): the local header carries zero CRC/sizes, the real
 * values follow the entry's bytes, and the central directory at the end
 * carries them again. Every mainstream unzip reads this; it is what any
 * streaming archiver produces. ZIP64 is not implemented: entries and the
 * archive are capped at 4 GiB, checked, and an export past that is refused
 * with a clear error rather than a corrupt file.
 */
import { Crc32 } from './xlsxBuilder';

const MAX32 = 0xFFFFFFFF;

interface Entry { name: Buffer; crc: number; size: number; offset: number; dosTime: number; dosDate: number }

export interface ZipSink {
  write(chunk: Buffer): Promise<void> | void;
}

function dosDateTime(d: Date): { dosTime: number; dosDate: number } {
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { dosTime, dosDate };
}

export class ZipStreamWriter {
  private offset = 0;
  private entries: Entry[] = [];
  private open: { entry: Entry; crc: Crc32 } | null = null;
  private finished = false;

  constructor(private readonly sink: ZipSink) {}

  private async emit(buf: Buffer): Promise<void> {
    await this.sink.write(buf);
    this.offset += buf.length;
    if (this.offset > MAX32) throw new Error('ZIP archive exceeds 4 GiB (ZIP64 not supported)');
  }

  /** Begin an entry. Call `write` for its bytes, then `endEntry`. */
  async beginEntry(name: string, mtime: Date = new Date()): Promise<void> {
    if (this.open) throw new Error('ZipStreamWriter: previous entry not ended');
    if (this.finished) throw new Error('ZipStreamWriter: archive already finished');
    const nameBuf = Buffer.from(name, 'utf8');
    const { dosTime, dosDate } = dosDateTime(mtime);
    const entry: Entry = { name: nameBuf, crc: 0, size: 0, offset: this.offset, dosTime, dosDate };
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);   // local file header
    h.writeUInt16LE(20, 4);           // version needed
    h.writeUInt16LE(0x0808, 6);       // bit 3 = data descriptor, bit 11 = UTF-8 names
    h.writeUInt16LE(0, 8);            // STORE
    h.writeUInt16LE(dosTime, 10);
    h.writeUInt16LE(dosDate, 12);
    h.writeUInt32LE(0, 14);           // crc (in descriptor)
    h.writeUInt32LE(0, 18);           // compressed size (in descriptor)
    h.writeUInt32LE(0, 22);           // uncompressed size (in descriptor)
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);           // extra length
    await this.emit(Buffer.concat([h, nameBuf]));
    this.open = { entry, crc: new Crc32() };
  }

  async write(chunk: Buffer | string): Promise<void> {
    if (!this.open) throw new Error('ZipStreamWriter: no open entry');
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (buf.length === 0) return;
    this.open.crc.update(buf);
    this.open.entry.size += buf.length;
    if (this.open.entry.size > MAX32) throw new Error(`ZIP entry ${this.open.entry.name.toString('utf8')} exceeds 4 GiB`);
    await this.emit(buf);
  }

  async endEntry(): Promise<void> {
    if (!this.open) throw new Error('ZipStreamWriter: no open entry');
    const { entry, crc } = this.open;
    entry.crc = crc.value;
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);   // data descriptor signature
    d.writeUInt32LE(entry.crc, 4);
    d.writeUInt32LE(entry.size, 8);
    d.writeUInt32LE(entry.size, 12);
    await this.emit(d);
    this.entries.push(entry);
    this.open = null;
  }

  /** Convenience: a whole entry from one buffer/string. */
  async addFile(name: string, content: Buffer | string, mtime?: Date): Promise<void> {
    await this.beginEntry(name, mtime);
    await this.write(content);
    await this.endEntry();
  }

  /** Write the central directory. The archive is complete after this. */
  async finish(): Promise<void> {
    if (this.open) throw new Error('ZipStreamWriter: entry still open');
    if (this.finished) return;
    const cdStart = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);         // version made by
      c.writeUInt16LE(20, 6);         // version needed
      c.writeUInt16LE(0x0808, 8);     // flags (descriptor + UTF-8)
      c.writeUInt16LE(0, 10);         // STORE
      c.writeUInt16LE(e.dosTime, 12);
      c.writeUInt16LE(e.dosDate, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt16LE(0, 30);         // extra
      c.writeUInt16LE(0, 32);         // comment
      c.writeUInt16LE(0, 34);         // disk
      c.writeUInt16LE(0, 36);         // internal attrs
      c.writeUInt32LE(0, 38);         // external attrs
      c.writeUInt32LE(e.offset, 42);
      await this.emit(Buffer.concat([c, e.name]));
    }
    const cdSize = this.offset - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    await this.emit(end);
    this.finished = true;
  }
}
