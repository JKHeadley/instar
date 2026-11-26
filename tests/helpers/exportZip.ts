/**
 * A minimal zip writer for importer fixtures (docs/specs/import-from-claude-chatgpt.md): stored or
 * deflated entries, with optional hostile fields (a link, a size that lies).
 */
import zlib from 'node:zlib';

export interface ZipFile { name: string; data: string | Buffer; deflate?: boolean; symlink?: boolean; lieSize?: number; dataDescriptor?: boolean }

export interface ZipOptions { comment?: string }

/** A minimal zip writer for fixtures (stored or deflated entries, optional hostile fields). */
export function makeZip(files: ZipFile[], opts: ZipOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const body = f.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = f.deflate ? 8 : 0;
    const name = Buffer.from(f.name);
    const usize = f.lieSize ?? raw.length;
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(f.dataDescriptor ? 0x8 : 0, 6); lh.writeUInt16LE(method, 8);
    if (!f.dataDescriptor) { lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); }
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const dd = f.dataDescriptor ? (() => { const d = Buffer.alloc(16); d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc >>> 0, 4); d.writeUInt32LE(body.length, 8); d.writeUInt32LE(usize, 12); return d; })() : Buffer.alloc(0);
    locals.push(lh, name, body, dd);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(f.dataDescriptor ? 0x8 : 0, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((f.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length + dd.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const comment = Buffer.from(opts.comment ?? '', 'latin1');
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, end, comment]);
}

