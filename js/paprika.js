// Writes .paprikarecipes files: a ZIP archive in which every entry is a
// gzip-compressed JSON document describing one recipe.
//
// AnyList's Recipe Import page accepts exactly this format, so it is the most
// reliable way to move a recipe from a phone into an AnyList account without
// hosting the recipe on a public web page first.
//
// Everything here runs in the browser with no dependencies, and is also
// importable from Node so the format can be checked against real unzip/gunzip.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Wraps raw data in a gzip container using stored (uncompressed) deflate
// blocks. Any gzip reader accepts this, so it keeps the app working on Safari
// versions that predate CompressionStream.
function gzipStored(data) {
  const blocks = [];
  const MAX = 65535;
  // A zero-length input still needs one final empty block.
  const count = Math.max(1, Math.ceil(data.length / MAX));
  for (let i = 0; i < count; i++) {
    const chunk = data.subarray(i * MAX, Math.min((i + 1) * MAX, data.length));
    const header = new Uint8Array(5);
    header[0] = i === count - 1 ? 1 : 0; // BFINAL, BTYPE=00 (stored)
    header[1] = chunk.length & 0xff;
    header[2] = (chunk.length >>> 8) & 0xff;
    header[3] = ~chunk.length & 0xff;
    header[4] = (~chunk.length >>> 8) & 0xff;
    blocks.push(header, chunk);
  }

  const deflated = concatBytes(blocks);
  const out = new Uint8Array(10 + deflated.length + 8);
  out.set([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff], 0); // gzip header
  out.set(deflated, 10);

  const view = new DataView(out.buffer);
  view.setUint32(10 + deflated.length, crc32(data), true);
  view.setUint32(10 + deflated.length + 4, data.length >>> 0, true);
  return out;
}

export async function gzip(data) {
  if (typeof CompressionStream === 'function') {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // Fall through to the dependency-free path below.
    }
  }
  return gzipStored(data);
}

function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function dosDateTime(date) {
  // MS-DOS timestamps start at 1980 and store seconds in 2-second units.
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Builds a ZIP archive with every entry stored uncompressed. The entries are
 * already gzipped, so deflating them a second time would only add bytes.
 *
 * @param {{name: string, data: Uint8Array}[]} entries
 * @param {Date} [modified]
 * @returns {Uint8Array}
 */
export function zipStore(entries, modified = new Date()) {
  const encoder = new TextEncoder();
  const { time, day } = dosDateTime(modified);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0x0800, true); // UTF-8 filename flag
    localView.setUint16(8, 0, true); // stored
    localView.setUint16(10, time, true);
    localView.setUint16(12, day, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true); // no extra field
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, day, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true); // offset of matching local header
    central.set(nameBytes, 46);

    locals.push(local, entry.data);
    centrals.push(central);
    offset += local.length + size;
  }

  const centralBytes = concatBytes(centrals);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralBytes.length, true);
  endView.setUint32(16, offset, true);

  return concatBytes([...locals, centralBytes, end]);
}
