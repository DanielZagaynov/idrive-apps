'use strict';
// Tests for the head-unit AirPlay tool. Run on Linux (WSL is fine) with Node 8,
// as the car has:   node tools/daniel-airplay/test/run-tests.js
// Exercises the real static helpers in bin/ (fairplay, airplay-video).
const assert = require('assert');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const spawn = require('child_process').spawn;
const execFileSync = require('child_process').execFileSync;

const ROOT = path.join(__dirname, '..');
const bplist = require('../lib/bplist');
const dns = require('../lib/dns');
const pairing = require('../lib/pairing');
const nacl = pairing.nacl;
const AirPlayReceiver = require('../lib/receiver').AirPlayReceiver;
const VideoSink = require('../lib/video-sink').VideoSink;
const fairplay = require('../lib/fairplay');
const mirror = require('../lib/mirror');

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ok   ' + name); },
    (err) => { failed++; console.log('  FAIL ' + name + '\n       ' + (err && err.stack)); });
}
const waitFor = (em, ev, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout waiting for ' + ev)), ms || 4000);
  em.once(ev, (v) => { clearTimeout(t); resolve(v); });
});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const u8 = (b) => new Uint8Array(b);
const B = (x) => Buffer.from(x.buffer, x.byteOffset, x.byteLength);

/** Minimal RTSP client. */
function Rtsp(port) { this.port = port; this.cseq = 0; this.buf = Buffer.alloc(0); this.waiters = []; }
Rtsp.prototype.connect = function () {
  return new Promise((resolve) => {
    this.sock = net.connect(this.port, '127.0.0.1', resolve);
    this.sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
  });
};
Rtsp.prototype.drain = function () {
  const end = this.buf.indexOf('\r\n\r\n');
  if (end < 0 || !this.waiters.length) return;
  const head = this.buf.toString('utf8', 0, end).split('\r\n');
  const headers = {};
  head.slice(1).forEach((l) => { const i = l.indexOf(':'); headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); });
  const len = parseInt(headers['content-length'] || '0', 10);
  if (this.buf.length < end + 4 + len) return;
  const body = this.buf.slice(end + 4, end + 4 + len);
  this.buf = this.buf.slice(end + 4 + len);
  this.waiters.shift()({ status: parseInt(head[0].split(' ')[1], 10), headers: headers, body: body });
  this.drain();
};
Rtsp.prototype.request = function (method, uri, body, type) {
  body = body || Buffer.alloc(0);
  const cseq = ++this.cseq;
  const head = method + ' ' + uri + ' RTSP/1.0\r\nCSeq: ' + cseq + '\r\nContent-Type: ' + (type || 'application/octet-stream') + '\r\nContent-Length: ' + body.length + '\r\n\r\n';
  return new Promise((resolve) => {
    this.waiters.push((res) => { assert.strictEqual(res.headers.cseq, String(cseq)); resolve(res); });
    this.sock.write(Buffer.concat([Buffer.from(head), body]));
  });
};

/** Annex B -> AVCC access units + SPS/PPS. */
function accessUnits(buf) {
  const nals = [];
  let i = 0; let start = -1;
  while (i + 3 <= buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) { let e = i; while (e > start && buf[e - 1] === 0) e--; nals.push(buf.slice(start, e)); }
      i += 3; start = i;
    } else i++;
  }
  if (start >= 0) nals.push(buf.slice(start));
  let sps = null; let pps = null; let pending = []; const units = [];
  nals.forEach((n) => {
    const t = n[0] & 0x1f;
    if (t === 7 && !sps) sps = n;
    if (t === 8 && !pps) pps = n;
    if (t === 9) return;
    pending.push(n);
    if (t === 1 || t === 5) {
      units.push(Buffer.concat(pending.map((p) => { const l = Buffer.alloc(4); l.writeUInt32BE(p.length, 0); return Buffer.concat([l, p]); })));
      pending = [];
    }
  });
  return { sps: sps, pps: pps, units: units };
}

function readFrameHeader(file) {
  const b = fs.readFileSync(file);
  const w = (i) => b.readUInt32LE(i * 4);
  return { magic: w(0), version: w(1), w: w(2), h: w(3), seq: w(4), slot: w(5), nslot: w(6), format: w(9), buf: b };
}

function main() {
  console.log('node ' + process.version + ' on ' + process.platform);
  return Promise.resolve()
    .then(() => console.log('bplist'))
    .then(() => test('round-trips values incl. UInt64 above 2^63 and negatives', () => {
      const big = new bplist.UInt64(0xf00dbabe, 0xdeadbeef);
      const out = bplist.parse(bplist.build({ s: 'Test’s iPhone', big: big, n: -5, r: new bplist.Real(0.25), d: Buffer.from([1, 2]), a: [1, { b: true }], long: 'x'.repeat(300) }));
      assert.strictEqual(out.s, 'Test’s iPhone');
      assert.ok(out.big instanceof bplist.UInt64);
      assert.strictEqual(out.big.toString(), '17297687072742424303');
      assert.strictEqual(out.n, -5);
      assert.strictEqual(out.r, 0.25);
      assert.deepStrictEqual(out.a, [1, { b: true }]);
      assert.strictEqual(bplist.UInt64.toUnsignedString(-1), '18446744073709551615');
      assert.strictEqual(bplist.UInt64.toUnsignedString(12345), '12345');
    }))
    .then(() => console.log('receiver'))
    .then(() => {
      const seed = pairing.Identity.newSeed();
      const serverPk = new pairing.Identity(seed).publicKey;
      const receiver = new AirPlayReceiver({ name: 'Test Car', identitySeed: seed, pi: 'p', fallbackDeviceId: '02:11:22:33:44:55', port: 0, interfaces: [], width: 1280, height: 720 });
      const videoFile = '/dev/shm/mgu-video-daniel-airplay-test';
      try { fs.unlinkSync(videoFile); } catch (e) { /* none */ }
      const sink = new VideoSink({ file: videoFile, log: () => {} });
      receiver.on('video-config', (c) => sink.config(c));
      receiver.on('video-frame', (f) => sink.frame(f));
      const logs = [];
      receiver.on('log', (m) => logs.push(m));
      let port; let phone; let ecdh; let keyMsg; let ekey; let dataPort; const sid = new bplist.UInt64(0x9abcdef0, 0x12345678);

      return receiver.start().then((r) => { port = r.port; })
        .then(() => test('mDNS answers a unicast PTR query with SRV/TXT/A', () => {
          const q = dgram.createSocket({ type: 'udp4', reuseAddr: true });
          return new Promise((r) => q.bind(0, r)).then(() => new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('no mDNS answer')), 3000);
            q.on('message', (msg) => {
              const res = dns.decodeResponse(msg);
              const srv = res.records.find((x) => x.type === 'SRV' && x.name === 'Test Car._airplay._tcp.local');
              if (!srv) return;
              clearTimeout(t); q.close();
              assert.strictEqual(srv.data.port, port);
              const txt = res.records.find((x) => x.type === 'TXT' && x.name === 'Test Car._airplay._tcp.local');
              assert.ok(txt.data.indexOf('pk=' + serverPk.toString('hex')) >= 0);
              assert.ok(res.records.some((x) => x.type === 'A'));
              resolve();
            });
            const addr = require('../lib/mdns').pickAddresses([])[0];
            if (addr) q.setMulticastInterface(addr.address);
            q.send(dns.encodeQuery(7, [{ name: '_airplay._tcp.local', type: 'PTR' }]), 5353, '224.0.0.251');
          }));
        }))
        .then(() => { phone = new Rtsp(port); return phone.connect(); })
        .then(() => test('GET /info reports name, key and display size', () => phone.request('GET', '/info').then((res) => {
          const info = bplist.parse(res.body);
          assert.strictEqual(info.name, 'Test Car');
          assert.deepStrictEqual(info.pk, serverPk);
          assert.strictEqual(info.displays[0].height, 720);
          assert.strictEqual(info.features, 0x1e * 4294967296 + 0x5a7ffff7);
        })))
        .then(() => test('pair-setup + pair-verify with signatures checked both ways', () => {
          const ed = nacl.sign.keyPair();
          const x = pairing.x25519KeyPair();
          return phone.request('POST', '/pair-setup', B(ed.publicKey)).then((r) => {
            assert.deepStrictEqual(r.body, serverPk);
            return phone.request('POST', '/pair-verify', Buffer.concat([Buffer.from([1, 0, 0, 0]), x.publicKey, B(ed.publicKey)]));
          }).then((r1) => {
            const sx = r1.body.slice(0, 32);
            ecdh = pairing.x25519(x.secret, sx);
            const ctr = crypto.createDecipheriv('aes-128-ctr', pairing.sha512(Buffer.from('Pair-Verify-AES-Key'), ecdh).slice(0, 16), pairing.sha512(Buffer.from('Pair-Verify-AES-IV'), ecdh).slice(0, 16));
            const sig = ctr.update(r1.body.slice(32));
            assert.ok(pairing.ed25519Verify(Buffer.concat([sx, x.publicKey]), sig, serverPk), 'server signature');
            const mine = B(nacl.sign.detached(u8(Buffer.concat([x.publicKey, sx])), ed.secretKey));
            return phone.request('POST', '/pair-verify', Buffer.concat([Buffer.from([0, 0, 0, 0]), ctr.update(mine)]));
          }).then((r2) => assert.strictEqual(r2.status, 200));
        }))
        .then(() => test('fp-setup both steps', () => {
          keyMsg = crypto.randomBytes(164); keyMsg.write('FPLY', 0, 'latin1'); keyMsg[4] = 3; keyMsg[12] = 3; // mode, as a real phone sends
          return phone.request('POST', '/fp-setup', Buffer.from([0x46, 0x50, 0x4c, 0x59, 3, 1, 1, 0, 0, 0, 0, 4, 2, 0, 3, 0xbb]))
            .then((r) => { assert.deepStrictEqual(r.body, fairplay.REPLY_MESSAGES[3]); return phone.request('POST', '/fp-setup', keyMsg); })
            .then((r) => assert.deepStrictEqual(r.body.slice(12), keyMsg.slice(144)));
        }))
        .then(() => test('SETUP #1 (ekey) and #2 (video, fixed ports)', () => {
          ekey = crypto.randomBytes(72);
          const started = waitFor(receiver, 'session-start');
          return phone.request('SETUP', 'rtsp://x/1', bplist.build({ ekey: ekey, eiv: crypto.randomBytes(16), name: 'Test iPhone', model: 'iPhone16,1' }), 'application/x-apple-binary-plist')
            .then((r) => { const p = bplist.parse(r.body); assert.ok(p.eventPort > 0 && p.timingPort > 0); })
            .then(() => phone.request('SETUP', 'rtsp://x/1', bplist.build({ streams: [{ type: 110, streamConnectionID: sid }] }), 'application/x-apple-binary-plist'))
            .then((r) => { dataPort = bplist.parse(r.body).streams[0].dataPort; assert.ok(dataPort > 0); return started; })
            .then((s) => assert.strictEqual(s.deviceName, 'Test iPhone'));
        }))
        .then(() => test('real H.264 is decrypted, decoded by bin/airplay-video and lands in the mgu-render frame file', () => {
          const clip = accessUnits(fs.readFileSync(path.join(__dirname, 'fixtures', 'clip-320x640.h264')));
          const aesKey = Buffer.from(execFileSync(fairplay.helperPath(), [keyMsg.toString('hex'), ekey.toString('hex')], { encoding: 'utf8' }).trim(), 'hex');
          const k = mirror.deriveStreamKeys(aesKey, ecdh, sid.toString());
          const enc = crypto.createCipheriv('aes-128-ctr', k.key, k.iv);
          const header = (type, size, w, h) => {
            const b = Buffer.alloc(128); b.writeUInt32LE(size, 0); b[4] = type;
            b.writeFloatLE(w || 0, 56); b.writeFloatLE(h || 0, 60); return b;
          };
          const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
          const s = clip.sps; const p = clip.pps;
          const avcC = Buffer.concat([Buffer.from([1, s[1], s[2], s[3], 0xff, 0xe1]), u16(s.length), s, Buffer.from([1]), u16(p.length), p]);
          const sock = net.connect(dataPort, '127.0.0.1');
          return new Promise((r) => sock.on('connect', r)).then(() => {
            sock.write(Buffer.concat([header(1, avcC.length, 320, 640), avcC]));
            // Paced at 30 fps, as a phone sends (a burst would trip the sink's anti-lag frame dropping).
            return clip.units.reduce((p, u) => p.then(() => {
              sock.write(Buffer.concat([header(0, u.length), enc.update(u)]));
              return delay(33);
            }), Promise.resolve()).then(() => delay(800));
          }).then(() => {
            const f = readFrameHeader(videoFile);
            assert.strictEqual(f.magic, 0x4656474d, 'magic MGVF');
            assert.strictEqual(f.version, 1);
            assert.strictEqual(f.w, 320);
            assert.strictEqual(f.h, 640);
            assert.strictEqual(f.nslot, 3);
            assert.strictEqual(f.format, 0);
            assert.ok(f.seq >= clip.units.length - 2, 'frames written: ' + f.seq + ' of ' + clip.units.length);
            assert.strictEqual(f.buf.length, 64 + 3 * 320 * 640 * 3 / 2);
            // testsrc2 is colourful: the newest frame's luma must vary
            const y = f.buf.slice(64 + f.slot * 320 * 640 * 3 / 2, 64 + f.slot * 320 * 640 * 3 / 2 + 320 * 640);
            let min = 255; let max = 0;
            for (let i = 0; i < y.length; i += 7) { if (y[i] < min) min = y[i]; if (y[i] > max) max = y[i]; }
            assert.ok(max - min > 100, 'luma range ' + min + '..' + max);
            sock.destroy();
          });
        }))
        .then(() => test('TEARDOWN ends the session', () => {
          const ended = waitFor(receiver, 'session-end');
          return phone.request('TEARDOWN', 'rtsp://x/1', bplist.build({ streams: [{ type: 110 }] }), 'application/x-apple-binary-plist').then(() => ended);
        }))
        .then(() => { if (failed) console.log('--- receiver log ---\n' + logs.join('\n')); sink.stop(); phone.sock.destroy(); return receiver.stop(); });
    })
    .then(() => console.log('airplayd'))
    .then(() => test('service starts, reports status on ctl.sock, renames, stops cleanly', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airplayd-'));
      fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ name: 'Car A', port: 0, ports: { event: 0, data: 0, timing: 0, audioData: 0, audioControl: 0 }, interfaces: ['lo-none'] }));
      const env = Object.assign({}, process.env, {
        DANIEL_AIRPLAY_DATA: tmp, DANIEL_AIRPLAY_RUN: tmp, DANIEL_AIRPLAY_CTL: path.join(tmp, 'ctl.sock'),
        DANIEL_AIRPLAY_VIDEO_FILE: '/dev/shm/mgu-video-daniel-airplay-test2', DANIEL_AIRPLAY_FIREWALL: '0',
      });
      const child = spawn(process.execPath, [path.join(ROOT, 'airplayd.js')], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const statuses = [];
      let client;
      let renamed = false;
      return delay(1500).then(() => new Promise((resolve, reject) => {
        client = net.connect(path.join(tmp, 'ctl.sock'));
        client.setEncoding('utf8');
        let buf = '';
        client.on('error', reject);
        client.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { statuses.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
          const last = statuses[statuses.length - 1];
          if (last.state === 'ready' && last.name === 'Car A' && !renamed) { renamed = true; client.write(JSON.stringify({ cmd: 'rename', name: 'Car B' }) + '\n'); }
          if (last.state === 'ready' && last.name === 'Car B') resolve();
        });
        setTimeout(() => reject(new Error('no status; log:\n' + out)), 6000);
      })).then(() => {
        const st = JSON.parse(fs.readFileSync(path.join(tmp, 'status.json'), 'utf8'));
        assert.strictEqual(st.name, 'Car B');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).name, 'Car B');
        assert.strictEqual(fs.statSync(path.join(tmp, 'ctl.sock')).mode & 0o777, 0o666);
        client.destroy();
        const exited = new Promise((r) => child.on('exit', r));
        child.kill('SIGTERM');
        return exited;
      }).then((code) => assert.strictEqual(code, 0));
    }))
    .then(() => test('firewall rules open only wlan_bridge, TCP + UDP', () => {
      const d = require('../airplayd');
      const rules = d.firewallRules(d.DEFAULTS).map((r) => r.join(' '));
      assert.strictEqual(rules[0], 'iifname wlan_bridge tcp dport { 7100, 7101, 7102 } accept comment "daniel-airplay"');
      assert.strictEqual(rules[1], 'iifname wlan_bridge udp dport { 5353, 7103, 7104, 7105 } accept comment "daniel-airplay"');
    }))
    .then(() => {
      console.log('\n' + passed + ' passed, ' + failed + ' failed');
      process.exit(failed ? 1 : 0);
    });
}

main();
