'use strict';
/**
 * tool_link.js - the app's line to the daniel-airplay tool (the receiver,
 * running as a system service): /run/daniel-airplay/ctl.sock, JSON lines.
 *
 *   in:  {"type":"status","state":"ready|connecting|streaming|error|starting",
 *         "name","device","width","height","video","addresses","port","error"}
 *   out: {"cmd":"stop"} | {"cmd":"status"} | {"cmd":"rename","name":"..."}
 *
 * Reconnects every 2 s while the tool is not there (state 'missing').
 */
const net = require('net');
const EventEmitter = require('events');

const SOCKET = process.env.DANIEL_AIRPLAY_CTL || '/run/daniel-airplay/ctl.sock';
const RETRY_MS = 2000;

class ToolLink extends EventEmitter {
    constructor(log, socketPath) {
        super();
        this.log = log;
        this.path = socketPath || SOCKET;
        this.sock = null;
        this.status = { state: 'missing' };
        this.closed = false;
        this.warned = false;
    }

    connect() {
        if (this.closed) return;
        const s = net.connect(this.path);
        let buf = '';
        s.setEncoding('utf8');
        s.on('connect', () => {
            this.sock = s;
            this.warned = false;
            this.log.info('tool: connected');
        });
        s.on('data', (d) => {
            buf += d;
            if (buf.length > 65536) { s.destroy(); return; }
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                let msg = null;
                try { msg = JSON.parse(line); } catch (e) { msg = null; }
                if (msg && msg.type === 'status') {
                    this.status = msg;
                    this.emit('status', msg);
                }
            }
        });
        s.on('error', (e) => {
            if (!this.warned) { this.log.info('tool: not reachable (' + e.code + ')'); this.warned = true; }
        });
        s.on('close', () => {
            if (this.sock === s) this.sock = null;
            if (this.status.state !== 'missing') {
                this.status = { state: 'missing' };
                this.emit('status', this.status);
            }
            if (!this.closed) setTimeout(() => this.connect(), RETRY_MS);
        });
    }

    send(cmd) {
        if (!this.sock) return false;
        this.sock.write(JSON.stringify(cmd) + '\n');
        return true;
    }

    close() {
        this.closed = true;
        if (this.sock) this.sock.destroy();
    }
}

module.exports = { ToolLink, SOCKET };
