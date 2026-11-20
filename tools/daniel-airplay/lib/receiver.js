'use strict';
// AirPlayReceiver: identity + mDNS + control server (Node 8).
const os = require('os');
const EventEmitter = require('events');
const Identity = require('./pairing').Identity;
const mdns = require('./mdns');
const dns = require('./dns');
const AirPlayServer = require('./server').AirPlayServer;

const FEATURES = '0x5A7FFFF7,0x1E';
const MODEL = 'AppleTV3,2';
const SRCVERS = '220.68';

/** MAC of the first interface we serve (stable per car), else the fallback. */
function pickDeviceId(addresses, fallback) {
  const ifs = os.networkInterfaces();
  for (let i = 0; i < addresses.length; i++) {
    const list = ifs[addresses[i].name] || [];
    for (let j = 0; j < list.length; j++) {
      if (list[j].mac && list[j].mac !== '00:00:00:00:00:00') return list[j].mac.toUpperCase();
    }
  }
  return fallback;
}

class AirPlayReceiver extends EventEmitter {
  /** opts: { name, identitySeed, pi, fallbackDeviceId, port, ports, interfaces, width, height, advertise } */
  constructor(opts) {
    super();
    this.opts = opts;
    this.identity = new Identity(opts.identitySeed);
    this.server = null;
    this.mdns = null;
  }

  start() {
    const o = this.opts;
    const addresses = mdns.pickAddresses(o.interfaces);
    this.deviceId = pickDeviceId(addresses, o.fallbackDeviceId);
    const pk = this.identity.publicKey.toString('hex');
    const airplayTxt = { deviceid: this.deviceId, features: FEATURES, flags: '0x4', model: MODEL, pk: pk, pi: o.pi, srcvers: SRCVERS, vv: '2' };
    const raopTxt = {
      ch: '2', cn: '0,1,2,3', da: 'true', et: '0,3,5', vv: '2', ft: FEATURES, am: MODEL, md: '0,1,2',
      rhd: '5.6.0.0', pw: 'false', sr: '44100', ss: '16', sv: 'false', tp: 'UDP', txtvers: '1', sf: '0x4', vs: SRCVERS, vn: '65537', pk: pk,
    };
    this.server = new AirPlayServer({
      identity: this.identity, name: o.name, deviceId: this.deviceId, txtAirPlay: dns.txtRecordBytes(airplayTxt),
      pi: o.pi, port: o.port, ports: o.ports, width: o.width || 1280, height: o.height || 720,
    });
    ['session-start', 'session-end', 'video-config', 'video-frame', 'log'].forEach((ev) => this.server.on(ev, (a) => this.emit(ev, a)));
    return this.server.listen().then((port) => {
      this.port = port;
      this.mdns = new mdns.MdnsAdvertiser({
        hostname: 'DanielMirror-' + this.deviceId.replace(/:/g, '').slice(-6),
        services: [
          { type: '_airplay._tcp', instance: o.name, port: port, txt: airplayTxt },
          { type: '_raop._tcp', instance: this.deviceId.replace(/:/g, '') + '@' + o.name, port: port, txt: raopTxt },
        ],
        interfaces: o.interfaces,
        log: (m) => this.emit('log', m),
      });
      return o.advertise === false ? null : this.mdns.start();
    }).then(() => ({ port: this.port, addresses: mdns.pickAddresses(o.interfaces).map((a) => a.address) }));
  }

  disconnect() { if (this.server) this.server.disconnect(); }

  stop() {
    const m = this.mdns ? this.mdns.stop() : Promise.resolve();
    return m.then(() => (this.server ? this.server.close() : null)).then(() => { this.mdns = null; this.server = null; });
  }
}

module.exports = { AirPlayReceiver: AirPlayReceiver };
