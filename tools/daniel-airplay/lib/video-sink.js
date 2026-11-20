'use strict';
// Feeds the decrypted H.264 stream to bin/airplay-video, which decodes it and
// writes I420 frames to mgu-render's frame file (/dev/shm/mgu-video-<name>).
//
// Pipe protocol (stdin of airplay-video), little-endian:
//   u8 type, u32 length, payload
//   type 1: config  = u16 width, u16 height, avcC bytes
//   type 2: frame   = AVCC (4-byte length-prefixed NAL units)
//   type 3: blank   = (no payload) drop the picture
const spawn = require('child_process').spawn;
const path = require('path');
const fs = require('fs');

function helperPath() {
  const p = process.env.DANIEL_AIRPLAY_VIDEO || path.join(__dirname, '..', 'bin', 'airplay-video');
  if (!fs.existsSync(p)) throw new Error('video helper not found: ' + p);
  return p;
}

function message(type, payload) {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32LE(payload ? payload.length : 0, 1);
  return payload ? Buffer.concat([head, payload]) : head;
}

class VideoSink {
  /** opts: { file: '/dev/shm/mgu-video-...', log } */
  constructor(opts) {
    this.file = opts.file;
    this.log = opts.log || (() => {});
    this.proc = null;
    this.lastConfig = null;
    this.waitingKey = true;
    this.stats = { frames: 0, dropped: 0 };
  }

  _ensure() {
    if (this.proc) return this.proc;
    const opts = { stdio: ['pipe', 'ignore', 'pipe'] };
    if (process.getuid && process.getuid() === 0) {
      // The decoder parses untrusted network data: run it as nobody. mgu-render
      // accepts frame files owned by nobody; remove a stale root-owned one first.
      opts.uid = 65534;
      opts.gid = 65534;
      try { if (fs.lstatSync(this.file).uid !== 65534) fs.unlinkSync(this.file); } catch (e) { /* none */ }
    }
    const proc = spawn(helperPath(), [this.file], opts);
    proc.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => this.log('video: ' + l)));
    proc.on('exit', (code, sig) => {
      this.log('video: helper exited (' + (sig || code) + ')');
      if (this.proc === proc) { this.proc = null; this.waitingKey = true; this.backlogged = false; }
    });
    proc.stdin.on('error', () => {});
    this.proc = proc;
    if (this.lastConfig) proc.stdin.write(this.lastConfig);
    return proc;
  }

  config(c) {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(c.width & 0xffff, 0);
    head.writeUInt16LE(c.height & 0xffff, 2);
    this.lastConfig = message(1, Buffer.concat([head, c.avcC]));
    this.waitingKey = true;
    this._ensure().stdin.write(this.lastConfig);
  }

  frame(f) {
    if (!this.lastConfig) return;
    if (this.waitingKey && !f.keyframe) { this.stats.dropped++; return; }
    this.waitingKey = false;
    const proc = this._ensure();
    // If the decoder falls behind (pipe full: write() said false, no 'drain' yet),
    // skip deltas until the next keyframe rather than building up lag.
    if (this.backlogged && !f.keyframe) { this.stats.dropped++; this.waitingKey = true; return; }
    if (!proc.stdin.write(message(2, f.data))) {
      this.backlogged = true;
      proc.stdin.once('drain', () => { this.backlogged = false; });
    }
    this.stats.frames++;
  }

  blank() {
    this.lastConfig = null;
    if (this.proc) this.proc.stdin.write(message(3, null));
  }

  stop() {
    if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch (e) { /* ignore */ } this.proc = null; }
  }
}

module.exports = { VideoSink: VideoSink, message: message };
