/**
 * Minimal ZIP writer ("stored", no compression — MP4s are already compressed, so deflate would only cost time).
 * Builds the archive as a Blob from parts, so large videos are never copied into one big buffer.
 * Files must stay under 4 GB each / in total (no ZIP64), which is far above a few short reels.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

async function blobCrc(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  const CHUNK = 8 * 1024 * 1024;
  for (let off = 0; off < blob.size; off += CHUNK) crc = crc32(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()), crc);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export async function createZip(files: { name: string; data: Blob }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  const used = new Set<string>();
  let offset = 0;

  for (const f of files) {
    let name = f.name;
    for (let n = 2; used.has(name); n++) name = f.name.replace(/(\.[^.]*)?$/, (ext) => `-${n}${ext}`);
    used.add(name);
    const nameBytes = enc.encode(name);
    const crc = await blobCrc(f.data);
    const size = f.data.size;
    if (offset + size > 0xfffffff0) throw new Error("The clips are too large to fit in one ZIP. Download them one by one instead.");

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, nameBytes, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    const entry = new Uint8Array(46 + nameBytes.length);
    entry.set(new Uint8Array(cd.buffer), 0);
    entry.set(nameBytes, 46);
    central.push(entry);

    offset += 30 + nameBytes.length + size;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end.buffer], { type: "application/zip" });
}
