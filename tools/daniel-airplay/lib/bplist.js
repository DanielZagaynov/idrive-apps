'use strict';
// Apple binary property list ("bplist00") reader/writer for Node 8 (no BigInt).
// 64-bit integers that don't fit a JS number come back as UInt64 objects.

function Real(value) { this.value = value; }

/** Unsigned 64-bit integer as two 32-bit halves. */
function UInt64(hi, lo) { this.hi = hi >>> 0; this.lo = lo >>> 0; }
UInt64.prototype.toString = function () {
  // Long division of four 16-bit limbs by 10.
  const limbs = [this.hi >>> 16, this.hi & 0xffff, this.lo >>> 16, this.lo & 0xffff];
  let out = '';
  while (limbs.some((l) => l !== 0)) {
    let rem = 0;
    for (let i = 0; i < 4; i++) {
      const cur = rem * 0x10000 + limbs[i];
      limbs[i] = Math.floor(cur / 10);
      rem = cur % 10;
    }
    out = rem + out;
  }
  return out || '0';
};
/** Any integer-ish value (number, possibly negative two's complement, or UInt64) -> unsigned decimal string. */
UInt64.toUnsignedString = function (v) {
  if (v instanceof UInt64) return v.toString();
  if (typeof v === 'string') return v;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error('not an integer: ' + v);
  if (v >= 0) return String(v);
  // two's complement of a (safe) negative number
  const hi = Math.floor(v / 0x100000000);
  const lo = v - hi * 0x100000000;
  return new UInt64(hi, lo).toString();
};

function parse(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') throw new Error('not a binary plist');
  const t = buf.length - 32;
  const offsetSize = buf[t + 6];
  const refSize = buf[t + 7];
  const readUInt = (pos, size) => { let v = 0; for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i]; return v; };
  const numObjects = readUInt(t + 8, 8);
  const topObject = readUInt(t + 16, 8);
  const tableOffset = readUInt(t + 24, 8);
  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) offsets[i] = readUInt(tableOffset + i * offsetSize, offsetSize);

  const read64 = (pos, signed) => {
    const hi = buf.readUInt32BE(pos);
    const lo = buf.readUInt32BE(pos + 4);
    if (hi < 0x200000) return hi * 0x100000000 + lo; // < 2^53
    if (signed && hi === 0xffffffff && lo >= 0x80000000) return -(0x100000000 - lo);
    return new UInt64(hi, lo);
  };

  const readObject = (ref, depth) => {
    if (depth > 64) throw new Error('bplist nesting too deep');
    let pos = offsets[ref];
    const marker = buf[pos];
    const hi = marker >> 4;
    const lo = marker & 0x0f;
    pos++;
    const readLength = () => {
      if (lo !== 0x0f) return lo;
      const size = 1 << (buf[pos] & 0x0f);
      const len = readUInt(pos + 1, size);
      pos += 1 + size;
      return len;
    };
    switch (hi) {
      case 0x0:
        if (marker === 0x00) return null;
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        throw new Error('unknown bplist marker 0x' + marker.toString(16));
      case 0x1: {
        const size = 1 << lo;
        if (size === 16) return read64(pos + 8, false);
        if (size === 8) return read64(pos, true);
        return readUInt(pos, size);
      }
      case 0x2: return (1 << lo) === 4 ? buf.readFloatBE(pos) : buf.readDoubleBE(pos);
      case 0x3: return new Date((buf.readDoubleBE(pos) + 978307200) * 1000);
      case 0x4: { const len = readLength(); return Buffer.from(buf.slice(pos, pos + len)); }
      case 0x5: { const len = readLength(); return buf.toString('latin1', pos, pos + len); }
      case 0x6: {
        const len = readLength();
        const sw = Buffer.from(buf.slice(pos, pos + len * 2));
        sw.swap16();
        return sw.toString('utf16le');
      }
      case 0x8: return { UID: readUInt(pos, lo + 1) };
      case 0xa: {
        const len = readLength();
        const out = [];
        for (let i = 0; i < len; i++) out.push(readObject(readUInt(pos + i * refSize, refSize), depth + 1));
        return out;
      }
      case 0xd: {
        const len = readLength();
        const out = {};
        for (let i = 0; i < len; i++) {
          const k = readObject(readUInt(pos + i * refSize, refSize), depth + 1);
          out[k] = readObject(readUInt(pos + (len + i) * refSize, refSize), depth + 1);
        }
        return out;
      }
      default:
        throw new Error('unsupported bplist marker 0x' + marker.toString(16));
    }
  };
  return readObject(topObject, 0);
}

function encodeInt(v) {
  if (v instanceof UInt64) {
    if (v.hi < 0x80000000) { const b = Buffer.alloc(9); b[0] = 0x13; b.writeUInt32BE(v.hi, 1); b.writeUInt32BE(v.lo, 5); return b; }
    const b = Buffer.alloc(17); b[0] = 0x14; b.writeUInt32BE(v.hi, 9); b.writeUInt32BE(v.lo, 13); return b;
  }
  if (v >= 0 && v < 0x100) return Buffer.from([0x10, v]);
  if (v >= 0 && v < 0x10000) { const b = Buffer.alloc(3); b[0] = 0x11; b.writeUInt16BE(v, 1); return b; }
  if (v >= 0 && v < 0x100000000) { const b = Buffer.alloc(5); b[0] = 0x12; b.writeUInt32BE(v, 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0x13;
  const hi = Math.floor(v / 0x100000000);
  b.writeInt32BE(hi, 1); b.writeUInt32BE(v - hi * 0x100000000, 5);
  return b;
}

function build(root) {
  const lengthHeader = (h, len) => (len < 15 ? Buffer.from([(h << 4) | len]) : Buffer.concat([Buffer.from([(h << 4) | 0x0f]), encodeInt(len)]));
  const encodeReal = (v) => { const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(v, 1); return b; };
  const nodes = [];
  const add = (value) => {
    const idx = nodes.length;
    nodes.push(null);
    let node;
    if (value === null || value === undefined) node = { buf: Buffer.from([0x00]) };
    else if (value === true) node = { buf: Buffer.from([0x09]) };
    else if (value === false) node = { buf: Buffer.from([0x08]) };
    else if (value instanceof Real) node = { buf: encodeReal(value.value) };
    else if (value instanceof UInt64) node = { buf: encodeInt(value) };
    else if (typeof value === 'number') node = { buf: Number.isInteger(value) ? encodeInt(value) : encodeReal(value) };
    else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const v = Buffer.from(value);
      node = { buf: Buffer.concat([lengthHeader(0x4, v.length), v]) };
    } else if (typeof value === 'string') {
      if (/^[\x00-\x7f]*$/.test(value)) node = { buf: Buffer.concat([lengthHeader(0x5, value.length), Buffer.from(value, 'latin1')]) };
      else { const s = Buffer.from(value, 'utf16le'); s.swap16(); node = { buf: Buffer.concat([lengthHeader(0x6, s.length / 2), s]) }; }
    } else if (Array.isArray(value)) node = { array: value.map(add) };
    else if (typeof value === 'object') {
      const keys = Object.keys(value).filter((k) => value[k] !== undefined);
      const keyRefs = keys.map(add);
      const valRefs = keys.map((k) => add(value[k]));
      node = { keyRefs: keyRefs, valRefs: valRefs };
    } else throw new Error('cannot encode ' + typeof value);
    nodes[idx] = node;
    return idx;
  };
  add(root);

  const refSize = nodes.length < 256 ? 1 : nodes.length < 65536 ? 2 : 4;
  const writeRefs = (refs) => { const b = Buffer.alloc(refs.length * refSize); refs.forEach((r, i) => b.writeUIntBE(r, i * refSize, refSize)); return b; };
  const objects = nodes.map((n) => {
    if (n.buf) return n.buf;
    if (n.array) return Buffer.concat([lengthHeader(0xa, n.array.length), writeRefs(n.array)]);
    return Buffer.concat([lengthHeader(0xd, n.keyRefs.length), writeRefs(n.keyRefs), writeRefs(n.valRefs)]);
  });
  const header = Buffer.from('bplist00', 'latin1');
  const offsets = [];
  let pos = header.length;
  objects.forEach((o) => { offsets.push(pos); pos += o.length; });
  const offsetSize = pos < 256 ? 1 : pos < 65536 ? 2 : 4;
  const table = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((o, i) => table.writeUIntBE(o, i * offsetSize, offsetSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeUInt32BE(nodes.length, 12);
  trailer.writeUInt32BE(0, 20);
  trailer.writeUInt32BE(pos, 28);
  return Buffer.concat([header].concat(objects, [table, trailer]));
}

module.exports = { parse: parse, build: build, Real: Real, UInt64: UInt64 };
