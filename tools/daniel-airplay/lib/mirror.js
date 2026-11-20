'use strict';
// Screen-mirroring video stream (Node 8): TCP, 128-byte headers + payloads.
// Type 1 = H.264 codec config (avcC, plaintext); type 0 = AES-128-CTR AVCC frame.
const crypto = require('crypto');
const EventEmitter = require('events');
const sha512 = require('./pairing').sha512;
const UInt64 = require('./bplist').UInt64;

const HEADER_SIZE = 128;
const MAX_PAYLOAD = 16 * 1024 * 1024;

/** aesKey: 16 bytes (FairPlay); ecdhSecret: 32 bytes or null; streamConnectionID: number | UInt64 | decimal string. */
function deriveStreamKeys(aesKey, ecdhSecret, streamConnectionID) {
  const base = ecdhSecret ? sha512(aesKey, ecdhSecret).slice(0, 16) : aesKey;
  const id = UInt64.toUnsignedString(streamConnectionID);
  return {
    key: sha512(Buffer.from('AirPlayStreamKey' + id), base).slice(0, 16),
    iv: sha512(Buffer.from('AirPlayStreamIV' + id), base).slice(0, 16),
  };
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }

/** Rebuild a clean avcC record from the codec-config payload. */
function parseCodecPayload(payload) {
  if (payload.length < 11 || payload[0] !== 1) throw new Error('codec payload is not avcC');
  const spsLen = payload.readUInt16BE(6);
  const sps = payload.slice(8, 8 + spsLen);
  const ppsLen = payload.readUInt16BE(8 + spsLen + 1);
  const pps = payload.slice(8 + spsLen + 3, 8 + spsLen + 3 + ppsLen);
  if (sps.length !== spsLen || pps.length !== ppsLen) throw new Error('truncated avcC');
  const avcC = Buffer.concat([Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), u16(spsLen), sps, Buffer.from([1]), u16(ppsLen), pps]);
  const codec = 'avc1.' + [sps[1], sps[2], sps[3]].map((b) => ('0' + b.toString(16)).slice(-2)).join('');
  return { avcC: avcC, codec: codec };
}

function containsKeyframe(avcc) {
  let pos = 0;
  while (pos + 4 < avcc.length) {
    const len = avcc.readUInt32BE(pos);
    if ((avcc[pos + 4] & 0x1f) === 5) return true;
    if (len <= 0) break;
    pos += 4 + len;
  }
  return false;
}

/**
 * One mirroring session's video. The server's fixed video port hands it the
 * phone's connection (attach). Events: 'config', 'frame' {data, keyframe}, 'end'.
 */
class MirrorStream extends EventEmitter {
  constructor(opts) {
    super();
    this.key = opts.key;
    this.iv = opts.iv;
    this.log = opts.log || (() => {});
    this.socket = null;
  }

  attach(sock) {
    if (this.socket) this.socket.destroy();
    this.socket = sock;
    sock.setNoDelay(true);
    this.log('mirror: video connection from ' + sock.remoteAddress);
    const decipher = crypto.createDecipheriv('aes-128-ctr', this.key, this.iv);
    let pending = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= HEADER_SIZE) {
        const size = pending.readUInt32LE(0);
        if (size > MAX_PAYLOAD) { this.log('mirror: bogus payload size, closing'); sock.destroy(); return; }
        if (pending.length < HEADER_SIZE + size) break;
        const header = pending.slice(0, HEADER_SIZE);
        const payload = pending.slice(HEADER_SIZE, HEADER_SIZE + size);
        pending = pending.slice(HEADER_SIZE + size);
        try { this._onPacket(header, payload, decipher); } catch (err) { this.log('mirror: packet error: ' + err.message); }
      }
    });
    sock.on('error', (err) => this.log('mirror: socket error: ' + err.message));
    sock.on('close', () => { if (this.socket === sock) this.socket = null; this.emit('end'); });
  }

  _onPacket(header, payload, decipher) {
    const type = header[4];
    if (type === 0) {
      const data = decipher.update(payload);
      this.emit('frame', { data: data, keyframe: containsKeyframe(data) });
    } else if (type === 1) {
      const c = parseCodecPayload(payload);
      c.width = Math.round(header.readFloatLE(56)) || Math.round(header.readFloatLE(40));
      c.height = Math.round(header.readFloatLE(60)) || Math.round(header.readFloatLE(44));
      this.log('mirror: codec ' + c.codec + ' ' + c.width + 'x' + c.height);
      this.emit('config', c);
    }
  }

  close() {
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }
}

module.exports = { MirrorStream: MirrorStream, deriveStreamKeys: deriveStreamKeys, parseCodecPayload: parseCodecPayload, containsKeyframe: containsKeyframe };
