'use strict';
// AirPlay legacy pairing for Node 8: Ed25519 / X25519 from tweetnacl (public domain),
// AES-128-CTR and SHA-512 from Node's own crypto.
const crypto = require('crypto');
const nacl = require('./nacl');

const buf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

function sha512() {
  const h = crypto.createHash('sha512');
  for (let i = 0; i < arguments.length; i++) h.update(arguments[i]);
  return h.digest();
}

/** Long-lived receiver identity (Ed25519) from a persisted 32-byte seed. */
function Identity(seed) {
  if (!seed || seed.length !== 32) throw new Error('identity seed must be 32 bytes');
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
  this.publicKey = Buffer.from(buf(kp.publicKey));
  this._secret = kp.secretKey;
}
Identity.prototype.sign = function (data) { return Buffer.from(buf(nacl.sign.detached(new Uint8Array(data), this._secret))); };
Identity.newSeed = function () { return crypto.randomBytes(32); };

function x25519KeyPair() {
  const secret = new Uint8Array(crypto.randomBytes(32));
  return { secret: secret, publicKey: Buffer.from(buf(nacl.scalarMult.base(secret))) };
}
function x25519(secret, publicKey) { return Buffer.from(buf(nacl.scalarMult(secret, new Uint8Array(publicKey)))); }
function ed25519Verify(message, signature, publicKey) {
  return nacl.sign.detached.verify(new Uint8Array(message), new Uint8Array(signature), new Uint8Array(publicKey));
}

/** One pairing session per control connection. */
function PairingSession(identity) {
  this.identity = identity;
  this.clientEdPublic = null;
  this.ecdhSecret = null;
  this.verified = false;
}

/** POST /pair-setup: body = client's Ed25519 key; reply with ours. */
PairingSession.prototype.setup = function (body) {
  if (body.length >= 32) this.clientEdPublic = Buffer.from(body.slice(0, 32));
  return this.identity.publicKey;
};

/** POST /pair-verify, step 1 (body[0] == 1) or step 2 (body[0] == 0). */
PairingSession.prototype.verify = function (body) {
  if (body.length < 4 + 64) throw new Error('pair-verify body too short');
  if (body[0] === 1) {
    this.clientXPublic = Buffer.from(body.slice(4, 36));
    this.clientEdPublic = Buffer.from(body.slice(36, 68));
    const kp = x25519KeyPair();
    this.serverXPublic = kp.publicKey;
    this.ecdhSecret = x25519(kp.secret, this.clientXPublic);
    this.aesKey = sha512(Buffer.from('Pair-Verify-AES-Key'), this.ecdhSecret).slice(0, 16);
    this.aesIv = sha512(Buffer.from('Pair-Verify-AES-IV'), this.ecdhSecret).slice(0, 16);
    const signature = this.identity.sign(Buffer.concat([this.serverXPublic, this.clientXPublic]));
    const cipher = crypto.createCipheriv('aes-128-ctr', this.aesKey, this.aesIv);
    return Buffer.concat([this.serverXPublic, cipher.update(signature)]);
  }
  if (!this.ecdhSecret) throw new Error('pair-verify step 2 before step 1');
  const decipher = crypto.createDecipheriv('aes-128-ctr', this.aesKey, this.aesIv);
  decipher.update(Buffer.alloc(64)); // skip the keystream used for our signature
  const clientSignature = decipher.update(body.slice(4, 68));
  if (!ed25519Verify(Buffer.concat([this.clientXPublic, this.serverXPublic]), clientSignature, this.clientEdPublic)) {
    throw new Error('pair-verify: client signature invalid');
  }
  this.verified = true;
  return Buffer.alloc(0);
};

module.exports = { Identity: Identity, PairingSession: PairingSession, sha512: sha512, x25519KeyPair: x25519KeyPair, x25519: x25519, ed25519Verify: ed25519Verify, nacl: nacl };
