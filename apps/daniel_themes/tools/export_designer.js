'use strict';
/**
 * Makes car themes from the designer's round-gauge presets (designer/index.html):
 * for each one, its plate (assets/<id>_plate.png: everything on the cluster that
 * does not move) and its theme (themes/<id>.json: where the numbers sit, the
 * needle, the level band, the readouts), both drawn by the designer's own code
 * in a headless browser. Then run node tools/build_assets.js.
 *
 *   node tools/export_designer.js [--browser <msedge or chrome>] [<preset id>...]
 *
 * Only for changing a preset: the outputs are committed, the car never runs this.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const APP = path.join(__dirname, '..');
const PRESETS = ['b_classic', 'b_track', 'b_stealth', 'b_sunset', 'b_glacier'];
const argv = process.argv.slice(2);
const bi = argv.indexOf('--browser');
const BROWSERS = [
    bi >= 0 ? argv[bi + 1] : null, process.env.THEMES_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const ids = argv.filter((a, i) => a !== '--browser' && argv[i - 1] !== '--browser');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };

function serve() {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
            const file = path.join(APP, rel);
            if (!file.startsWith(APP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
            fs.createReadStream(file).pipe(res);
        });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

/* Runs the browser without blocking: this process also serves it the page. */
function browser(args) {
    const exe = BROWSERS.find((b) => fs.existsSync(b));
    if (!exe) return Promise.reject(new Error('no Edge or Chrome found: pass --browser <path>'));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'themes-export-'));
    return new Promise((resolve, reject) => {
        const ch = cp.spawn(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
            '--virtual-time-budget=5000', `--user-data-dir=${profile}`].concat(args));
        let out = '';
        const timer = setTimeout(() => { ch.kill(); reject(new Error(`${path.basename(exe)} took over 2 minutes`)); }, 120000);
        ch.stdout.on('data', (d) => { out += d; });
        ch.on('error', (e) => { clearTimeout(timer); reject(e); });
        ch.on('close', () => {
            clearTimeout(timer);
            try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* the browser may still hold it */ }
            resolve(out);
        });
    });
}

/* themes/<id>.json, one point per line */
function themeText(t) {
    return JSON.stringify(t, null, 2).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2, $3]')
        .replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]')
        .replace(/"box": \[\s+([\d.]+),\s+([\d.]+),\s+([\d.]+),\s+([\d.]+)\s+\]/g, '"box": [$1, $2, $3, $4]') + '\n';
}

async function main() {
    const srv = await serve();
    const base = `http://127.0.0.1:${srv.address().port}/designer/index.html`;
    try {
        for (const id of (ids.length ? ids : PRESETS)) {
            const dom = await browser(['--dump-dom', `${base}?export=${id}&json=1`]);
            const m = dom.match(/<pre id="theme">([\s\S]*?)<\/pre>/);
            if (!m) throw new Error(`${id}: the designer gave no theme (${(dom.match(/EXPORT-ERROR[^<]*/) || ['no page'])[0]})`);
            const t = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
            const png = path.join(APP, t.plate);
            if (fs.existsSync(png)) fs.unlinkSync(png);
            await browser([`--screenshot=${png}`, '--window-size=1920,720', `${base}?export=${id}`]);
            const b = fs.existsSync(png) ? fs.readFileSync(png) : null;
            if (!b || b.readUInt32BE(16) !== 1920 || b.readUInt32BE(20) !== 720) throw new Error(`${id}: no 1920x720 screenshot at ${t.plate}`);
            fs.writeFileSync(path.join(APP, 'themes', `${t.id}.json`), themeText(t));
            console.log(`${id}: themes/${t.id}.json, ${t.plate}`);
        }
    } finally {
        srv.close();
    }
}

main().catch((e) => { console.error(`export_designer: ${e.message}`); process.exitCode = 1; });
