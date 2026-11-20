'use strict';
// Minimal DNS message codec for mDNS: decode questions, encode responses
// (A, PTR, SRV, TXT). No dependencies; Node 8.

const TYPES = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };
const TYPE_NAMES = {};
Object.keys(TYPES).forEach((k) => { TYPE_NAMES[TYPES[k]] = k; });
const CLASS_IN = 1;
const FLUSH = 0x8000;
const QU = 0x8000;

function readName(msg, pos) {
  const labels = [];
  let jumped = false;
  let end = pos;
  let hops = 0;
  for (;;) {
    if (pos >= msg.length) throw new Error('name past end');
    const len = msg[pos];
    if (len === 0) { if (!jumped) end = pos + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (++hops > 16) throw new Error('compression loop');
      const ptr = ((len & 0x3f) << 8) | msg[pos + 1];
      if (!jumped) end = pos + 2;
      jumped = true;
      pos = ptr;
      continue;
    }
    labels.push(msg.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return { name: labels.join('.'), end: end };
}

/** Decode header + questions. Returns null for anything malformed. */
function decodeQuery(msg) {
  try {
    if (msg.length < 12) return null;
    const flags = msg.readUInt16BE(2);
    const out = { id: msg.readUInt16BE(0), response: !!(flags & 0x8000), questions: [] };
    const qd = msg.readUInt16BE(4);
    let pos = 12;
    for (let i = 0; i < qd; i++) {
      const n = readName(msg, pos);
      pos = n.end;
      const type = msg.readUInt16BE(pos);
      const klass = msg.readUInt16BE(pos + 2);
      pos += 4;
      out.questions.push({ name: n.name, type: TYPE_NAMES[type] || type, unicast: !!(klass & QU) });
    }
    return out;
  } catch (e) {
    return null;
  }
}

function encodeName(name) {
  const parts = name.split('.').filter((p) => p.length);
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, 'utf8');
    if (b.length > 63) throw new Error('label too long: ' + p);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function encodeRData(r) {
  switch (r.type) {
    case 'A': return Buffer.from(r.data.split('.').map(Number));
    case 'PTR': return encodeName(r.data);
    case 'SRV': {
      const b = Buffer.alloc(6);
      b.writeUInt16BE(r.data.priority || 0, 0);
      b.writeUInt16BE(r.data.weight || 0, 2);
      b.writeUInt16BE(r.data.port, 4);
      return Buffer.concat([b, encodeName(r.data.target)]);
    }
    case 'TXT': {
      const items = r.data.length ? r.data : [''];
      return Buffer.concat(items.map((s) => { const t = Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from([t.length]), t]); }));
    }
    default: throw new Error('cannot encode ' + r.type);
  }
}

function encodeRecord(r) {
  const head = Buffer.alloc(10);
  const rdata = encodeRData(r);
  head.writeUInt16BE(TYPES[r.type], 0);
  head.writeUInt16BE(CLASS_IN | (r.flush ? FLUSH : 0), 2);
  head.writeUInt32BE(r.ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(r.name), head, rdata]);
}

/** Encode an authoritative response. opts: { id, questions[], answers[], additionals[] } */
function encodeResponse(opts) {
  const questions = opts.questions || [];
  const answers = opts.answers || [];
  const additionals = opts.additionals || [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(opts.id || 0, 0);
  header.writeUInt16BE(0x8400, 2); // QR + AA
  header.writeUInt16BE(questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additionals.length, 10);
  const q = questions.map((x) => { const t = Buffer.alloc(4); t.writeUInt16BE(TYPES[x.type] || x.type, 0); t.writeUInt16BE(CLASS_IN, 2); return Buffer.concat([encodeName(x.name), t]); });
  return Buffer.concat([header].concat(q, answers.map(encodeRecord), additionals.map(encodeRecord)));
}

/** Encode a query (used by tests). */
function encodeQuery(id, questions, unicast) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(questions.length, 4);
  const q = questions.map((x) => { const t = Buffer.alloc(4); t.writeUInt16BE(TYPES[x.type], 0); t.writeUInt16BE(CLASS_IN | (unicast ? QU : 0), 2); return Buffer.concat([encodeName(x.name), t]); });
  return Buffer.concat([header].concat(q));
}

/** Decode a full response (used by tests): answers + additionals with A/PTR/SRV/TXT data. */
function decodeResponse(msg) {
  const out = { id: msg.readUInt16BE(0), records: [] };
  const counts = [msg.readUInt16BE(4), msg.readUInt16BE(6), msg.readUInt16BE(8), msg.readUInt16BE(10)];
  let pos = 12;
  for (let i = 0; i < counts[0]; i++) { pos = readName(msg, pos).end + 4; }
  const total = counts[1] + counts[2] + counts[3];
  for (let i = 0; i < total; i++) {
    const n = readName(msg, pos);
    pos = n.end;
    const type = TYPE_NAMES[msg.readUInt16BE(pos)];
    const ttl = msg.readUInt32BE(pos + 4);
    const len = msg.readUInt16BE(pos + 8);
    const rd = pos + 10;
    let data = null;
    if (type === 'A') data = [msg[rd], msg[rd + 1], msg[rd + 2], msg[rd + 3]].join('.');
    else if (type === 'PTR') data = readName(msg, rd).name;
    else if (type === 'SRV') data = { priority: msg.readUInt16BE(rd), weight: msg.readUInt16BE(rd + 2), port: msg.readUInt16BE(rd + 4), target: readName(msg, rd + 6).name };
    else if (type === 'TXT') { data = []; let p = rd; while (p < rd + len) { data.push(msg.toString('utf8', p + 1, p + 1 + msg[p])); p += 1 + msg[p]; } }
    out.records.push({ name: n.name, type: type, ttl: ttl, data: data });
    pos = rd + len;
  }
  return out;
}

/** Raw TXT record bytes (length-prefixed key=value strings), as /info's txtAirPlay wants. */
function txtRecordBytes(pairs) {
  return Buffer.concat(Object.keys(pairs).map((k) => {
    const s = Buffer.from(k + '=' + pairs[k], 'utf8');
    return Buffer.concat([Buffer.from([s.length]), s]);
  }));
}

module.exports = { decodeQuery: decodeQuery, encodeResponse: encodeResponse, encodeQuery: encodeQuery, decodeResponse: decodeResponse, txtRecordBytes: txtRecordBytes };
