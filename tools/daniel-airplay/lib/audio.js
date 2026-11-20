'use strict';
// AirPlay audio stream (SETUP stream type 96), Node 8.
//
// The phone sends one RTP packet per audio frame to the audio data port (UDP):
//   12-byte RTP header (byte 1 & 0x7f = payload type 96, seq at 2, timestamp at 4)
//   then the frame, AES-128-CBC encrypted with the session key and the eiv from
//   SETUP #1, the IV starting afresh for every packet. Only whole 16-byte blocks
//   are encrypted; the tail is sent in the clear.
// Resent packets arrive on the control port as type 0x56 with the RTP packet at
// offset 4. Sync packets (0x54) are ignored: audio is played as it comes.
const crypto = require('crypto');
const EventEmitter = require('events');
const sha512 = require('./pairing').sha512;

const REORDER_WINDOW = 8; // packets (~90 ms of AAC-ELD) held while one is missing

/** Session audio key: sha512(aesKey | ecdh secret)[0:16] after pair-verify, else the raw key. */
function audioKey(aesKey, ecdhSecret) {
  return ecdhSecret ? sha512(aesKey, ecdhSecret).slice(0, 16) : aesKey;
}

function cbc(decrypt, key, iv, payload) {
  const whole = payload.length - (payload.length % 16);
  if (!whole) return Buffer.from(payload);
  const c = decrypt ? crypto.createDecipheriv('aes-128-cbc', key, iv) : crypto.createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(payload.slice(0, whole)), c.final(), payload.slice(whole)]);
}
const decryptPayload = (key, iv, payload) => cbc(true, key, iv, payload);
const encryptPayload = (key, iv, payload) => cbc(false, key, iv, payload); // tests, fake phone

const seqDiff = (a, b) => ((a - b + 0x18000) & 0xffff) - 0x8000; // a - b, wrapping at 16 bits

/**
 * Events: 'packet' (Buffer: one decrypted audio frame, in sequence order).
 * opts: { key, iv }
 */
class AudioStream extends EventEmitter {
  constructor(opts) {
    super();
    this.key = opts.key;
    this.iv = opts.iv;
    this.next = -1;
    this.held = new Map();
    this.stats = { packets: 0, late: 0, lost: 0 };
  }

  /** A datagram from the audio data port. */
  data(msg) {
    if (msg.length < 12 || (msg[1] & 0x7f) !== 96) return;
    this._enqueue(msg.readUInt16BE(2), msg.slice(12));
  }

  /** A datagram from the audio control port (only resent packets matter). */
  control(msg) {
    if (msg.length >= 16 && (msg[1] & 0x7f) === 0x56) this.data(msg.slice(4));
  }

  /** The phone flushed (pause, seek): start over at whatever comes next. */
  flush() { this.next = -1; this.held.clear(); }

  _enqueue(seq, payload) {
    if (!payload.length) return;
    if (this.next < 0) this.next = seq;
    const ahead = seqDiff(seq, this.next);
    if (ahead < 0) { this.stats.late++; return; }
    if (ahead > 0x1000) { this.flush(); this.next = seq; } // a jump: the phone restarted the stream
    if (!this.held.has(seq)) this.held.set(seq, payload);
    this._drain();
    if (this.held.size > REORDER_WINDOW) {
      // Give up on the missing packet(s): skip to the oldest one held.
      let oldest = -1;
      this.held.forEach((v, s) => { if (oldest < 0 || seqDiff(s, oldest) < 0) oldest = s; });
      this.stats.lost += seqDiff(oldest, this.next);
      this.next = oldest;
      this._drain();
    }
  }

  _drain() {
    while (this.held.has(this.next)) {
      const p = this.held.get(this.next);
      this.held.delete(this.next);
      this.next = (this.next + 1) & 0xffff;
      this.stats.packets++;
      this.emit('packet', decryptPayload(this.key, this.iv, p));
    }
  }
}

module.exports = { AudioStream: AudioStream, audioKey: audioKey, decryptPayload: decryptPayload, encryptPayload: encryptPayload, seqDiff: seqDiff };
