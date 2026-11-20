'use strict';
// FairPlay handshake for AirPlay mirroring (head unit, Node 8).
// Steps 1-2 (/fp-setup) are fixed replies; unwrapping the stream key runs the
// reverse-engineered playfair algorithm in bin/fairplay (static x86-64 Linux).
const execFileSync = require('child_process').execFileSync;
const path = require('path');
const fs = require('fs');

const REPLY_MESSAGES = [
  '46504c59030102000000008202000f9f3f9e0a2521dbdf312ab2bfb29e8d232b6376a8c818701d22ae93d82737feaf9db4fdf41c2dba9d1f49caaabf6591ac1f7bc6f7e0663d21afe01565953eab81f418ceed095adb7c3d0e254909a79831d49c3982973434facb42c63a1cd911a6fe941a8a6d4a743b46c3a7649e44c78955e49d8155009549c4e2f7a3f6d5ba',
  '46504c5903010200000000820201cf32a25714b2524f8aa0ad7af164e37bcf4424e200047efc0ad67afcd95ded1c2730bb591b962ed63a9c4ded88ba8fc78de64d91ccfd5c7b56da88e31f5cceafc7431995a01665a54e1939d25b94db64b9e45d8d063e1e6af07e9656162b0efa404275ea5a44d9591c7256b9fbe6513898b80227721988571650942ad946688a',
  '46504c5903010200000000820202c169a352eeed35b18cdd9c58d64f16c1519a89eb5317bd0d4336cd68f638ff9d016a5b52b7fa9216b2b65482c78444118121a2c7fed83db7119e9182aad7d18c7063e2a457555910af9e0efc76347d164043807f581ee4fbe42ca9dedc1b5eb2a3aa3d2ecd59e7eee70b3629f22afd161d877353ddb99adc8e07006e56f850ce',
  '46504c59030102000000008202039001e1727e0f57f9f5880db104a6257a23f5cfff1abbe1e93045251afb97eb9fc0011ebe0f3a81df5b691d76acb2f7a5c708e3d328f56bb39dbde5f29c8a17f481487e3ae863c678325422e6f78e166d18aa7fd636258bce28726f661f738893ce44311e4be6c0535193e5ef72e8686233729c227d820c999445d89246c8c359',
].map((h) => Buffer.from(h, 'hex'));

const FP_HEADER = Buffer.from('46504c590301040000000014', 'hex');


function helperPath() {
  const candidates = [process.env.DANIEL_AIRPLAY_FAIRPLAY, path.join(__dirname, '..', 'bin', 'fairplay')].filter(Boolean);
  for (let i = 0; i < candidates.length; i++) if (fs.existsSync(candidates[i])) return candidates[i];
  throw new Error('fairplay helper not found (bin/fairplay)');
}

class FairPlay {
  constructor() { this.keyMessage = null; }

  /** First /fp-setup: 16-byte request -> 142-byte reply chosen by the mode byte. */
  setup(req) {
    if (req.length !== 16 || req[4] !== 0x03) throw new Error('unsupported FairPlay setup request');
    const mode = req[14];
    if (mode > 3) throw new Error('unsupported FairPlay mode ' + mode);
    this.keyMessage = null;
    return REPLY_MESSAGES[mode];
  }

  /** Second /fp-setup: 164-byte key message -> 32-byte reply. */
  handshake(req) {
    if (req.length !== 164 || req[4] !== 0x03) throw new Error('unsupported FairPlay handshake');
    // playfair indexes 4-entry tables with byte 12 (the mode): reject anything else
    // rather than let a malformed message crash the helper.
    if (req.toString('latin1', 0, 4) !== 'FPLY' || req[12] > 3) throw new Error('malformed FairPlay key message');
    this.keyMessage = Buffer.from(req);
    return Buffer.concat([FP_HEADER, req.slice(144, 164)]);
  }

  /** Unwrap the 72-byte "ekey" from SETUP into the 16-byte AES session key. */
  decrypt(ekey) {
    if (!this.keyMessage) throw new Error('FairPlay handshake not completed');
    if (ekey.length !== 72) throw new Error('ekey must be 72 bytes');
    const opts = { encoding: 'utf8', timeout: 5000, windowsHide: true };
    if (process.getuid && process.getuid() === 0) { opts.uid = 65534; opts.gid = 65534; } // unprivileged
    const out = execFileSync(helperPath(), [this.keyMessage.toString('hex'), Buffer.from(ekey).toString('hex')], opts).trim();
    if (!/^[0-9a-f]{32}$/.test(out)) throw new Error('fairplay helper returned unexpected output');
    return Buffer.from(out, 'hex');
  }
}

module.exports = { FairPlay: FairPlay, REPLY_MESSAGES: REPLY_MESSAGES, FP_HEADER: FP_HEADER, helperPath: helperPath };
