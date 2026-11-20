'use strict';
// mDNS / DNS-SD responder for the head unit. Advertises _airplay._tcp and
// _raop._tcp ONLY on the interfaces given (the car's Wi-Fi hotspot), never on
// the car's internal networks.
const dgram = require('dgram');
const os = require('os');
const dns = require('./dns');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const TTL = 120;

/**
 * IPv4 addresses to serve. `wanted` is a list of interface names and/or address
 * prefixes ("wlan0", "172.16.222."). Empty list = every non-internal IPv4.
 */
function pickAddresses(wanted) {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach((name) => {
    (ifs[name] || []).forEach((a) => {
      if (a.family !== 'IPv4' || a.internal || a.address.indexOf('169.254.') === 0) return;
      const ok = !wanted || !wanted.length || wanted.some((w) => w === name || a.address.indexOf(w) === 0);
      if (ok) out.push({ name: name, address: a.address });
    });
  });
  return out;
}

class MdnsAdvertiser {
  /** opts: { hostname, services: [{type, instance, port, txt}], interfaces: [...], log } */
  constructor(opts) {
    this.hostname = opts.hostname.replace(/[^A-Za-z0-9-]/g, '-') + '.local';
    this.services = opts.services;
    this.wanted = opts.interfaces || [];
    this.log = opts.log || (() => {});
    this.sock = null;
    this.ifaces = [];
    this.timers = [];
  }

  _records(ttl) {
    if (ttl === undefined) ttl = TTL;
    const recs = [];
    this.services.forEach((s) => {
      const typeName = s.type + '.local';
      const fullName = s.instance + '.' + typeName;
      recs.push({ name: '_services._dns-sd._udp.local', type: 'PTR', ttl: ttl, data: typeName });
      recs.push({ name: typeName, type: 'PTR', ttl: ttl, data: fullName });
      recs.push({ name: fullName, type: 'SRV', ttl: ttl, flush: true, data: { port: s.port, target: this.hostname } });
      recs.push({ name: fullName, type: 'TXT', ttl: ttl, flush: true, data: Object.keys(s.txt).map((k) => k + '=' + s.txt[k]) });
    });
    this.ifaces.forEach((i) => recs.push({ name: this.hostname, type: 'A', ttl: ttl, flush: true, data: i.address }));
    return recs;
  }

  start() {
    this.ifaces = pickAddresses(this.wanted);
    if (!this.ifaces.length) {
      this.log('mdns: no matching interface yet (' + (this.wanted.join(', ') || 'any') + '), retrying');
    }
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      sock.on('error', (err) => this.log('mdns: socket error: ' + err.message));
      sock.once('error', reject);
      sock.bind(MDNS_PORT, () => {
        sock.removeListener('error', reject);
        this.sock = sock;
        try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch (e) { /* ignore */ }
        this._join();
        this._announce();
        this.timers.push(setTimeout(() => this._announce(), 1000), setTimeout(() => this._announce(), 3000));
        // Re-check interfaces (the hotspot may come up after us) and re-announce.
        this.timers.push(setInterval(() => this._refresh(), 15000));
        resolve();
      });
    });
  }

  _join() {
    this.ifaces.forEach((i) => {
      try { this.sock.addMembership(MDNS_ADDR, i.address); } catch (e) {
        if (!/EADDRINUSE/.test(e.message)) this.log('mdns: join on ' + i.address + ' failed: ' + e.message);
      }
    });
    this.log('mdns: advertising ' + this.services.map((s) => '"' + s.instance + '" ' + s.type).join(', ') +
      ' as ' + this.hostname + ' on ' + (this.ifaces.map((i) => i.name + ' ' + i.address).join(', ') || 'nothing'));
  }

  _refresh() {
    const now = pickAddresses(this.wanted);
    const key = (l) => l.map((i) => i.address).sort().join(',');
    if (key(now) !== key(this.ifaces)) { this.ifaces = now; this._join(); }
    this._announce();
  }

  _announce() {
    if (this.ifaces.length) this._sendMulticast({ answers: this._records() });
  }

  _sendMulticast(response) {
    const buf = dns.encodeResponse(response);
    this.ifaces.forEach((i) => {
      try { this.sock.setMulticastInterface(i.address); this.sock.send(buf, MDNS_PORT, MDNS_ADDR); } catch (e) {
        this.log('mdns: send on ' + i.address + ' failed: ' + e.message);
      }
    });
  }

  _onMessage(msg, rinfo) {
    const q = dns.decodeQuery(msg);
    if (!q || q.response || !q.questions.length) return;
    // Only answer peers on our interfaces' subnets (/24 match is enough for the hotspot).
    const prefix = (ip) => ip.split('.').slice(0, 3).join('.');
    if (!this.ifaces.some((i) => prefix(i.address) === prefix(rinfo.address))) return;

    const all = this._records();
    const answers = [];
    q.questions.forEach((qq) => {
      const n = qq.name.toLowerCase();
      all.forEach((r) => { if (r.name.toLowerCase() === n && (qq.type === r.type || qq.type === 'ANY') && answers.indexOf(r) < 0) answers.push(r); });
    });
    if (!answers.length) return;
    const wanted = {};
    answers.forEach((a) => {
      if (a.type === 'PTR') wanted[a.data.toLowerCase()] = true;
      if (a.type === 'SRV') wanted[a.data.target.toLowerCase()] = true;
    });
    const additionals = [];
    for (let pass = 0; pass < 2; pass++) {
      all.forEach((r) => {
        if (answers.indexOf(r) >= 0 || additionals.indexOf(r) >= 0 || !wanted[r.name.toLowerCase()]) return;
        additionals.push(r);
        if (r.type === 'SRV') wanted[r.data.target.toLowerCase()] = true;
      });
    }
    const unicast = rinfo.port !== MDNS_PORT || q.questions.some((x) => x.unicast);
    if (unicast) {
      const buf = dns.encodeResponse({ id: q.id, questions: rinfo.port !== MDNS_PORT ? q.questions : [], answers: answers, additionals: additionals });
      this.sock.send(buf, rinfo.port, rinfo.address);
    } else {
      this._sendMulticast({ answers: answers, additionals: additionals });
    }
  }

  stop() {
    this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.timers = [];
    if (!this.sock) return Promise.resolve();
    try { this._sendMulticast({ answers: this._records(0) }); } catch (e) { /* ignore */ }
    return new Promise((r) => setTimeout(() => { try { this.sock.close(); } catch (e) { /* ignore */ } this.sock = null; r(); }, 100));
  }
}

module.exports = { MdnsAdvertiser: MdnsAdvertiser, pickAddresses: pickAddresses };
