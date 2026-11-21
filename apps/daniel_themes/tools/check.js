'use strict';
/**
 * Offline checks of the app folder, before you push:
 *
 *  - mgu-app.json follows the rules the car's deploy tool applies (schema,
 *    id, x.y.z version, tree with package.json, modules, sdk), and
 *    package.json / rhmiData/application.json carry the same id and version;
 *  - package.json says mguHmi;
 *  - each module compiles (node --check) and requires only './<module>',
 *    the names in "sdk" and Node builtins; no syntax Node 8 lacks (?. ??);
 *  - for ID7 and ID8: application.xml and uiDescription.json name the same
 *    containers and components, ids are unique, no ParentState on iDrive 8,
 *    and every state and component name src/*.js uses exists;
 *  - every string id the screens and the tile use has a text in en_GB.json;
 *  - the tile icon is a PNG of at most 128 KiB;
 *  - package.json starts the app with the head unit and ships assets/;
 *  - every SOME/IP field src/car.js reads is in manifest.json;
 *  - each theme in assets/themes.json has its files: a 1920x720 plate, the
 *    needle, both hub caps, glyphs for every readout character, theme.json;
 *    and a plate that is not the render with its painted needles (that
 *    fails unless --allow-render-plate, for trying the app before the
 *    clean plate exists).
 *
 *   node tools/check.js [--allow-render-plate]
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const builtins = require('module').builtinModules;

const APP = path.join(__dirname, '..');
const errors = [];
const fail = (msg) => errors.push(msg);
const readJson = (rel) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(APP, rel), 'utf8'));
    } catch (e) {
        fail(`${rel}: ${e.code === 'ENOENT' ? 'missing' : 'does not parse'}`);
        return null;
    }
};

const m = readJson('mgu-app.json') || {};
if (m.schema !== 1) fail('mgu-app.json: schema is not 1');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.id || '')) fail(`mgu-app.json: bad id ${m.id}`);
if (!/_/.test(m.id || '')) fail(`mgu-app.json: id ${m.id} has no prefix (acme_gauges)`);
if (!/^\d+\.\d+\.\d+$/.test(m.version || '')) fail(`mgu-app.json: version is not x.y.z: ${m.version}`);
const tree = m.tree || 'package';
const pkg = readJson(`${tree}/package.json`) || {};
if (pkg.name !== m.id || pkg.version !== m.version) {
    fail(`${tree}/package.json is ${pkg.name}@${pkg.version}, not ${m.id}@${m.version}`);
}
if (!Array.isArray(pkg.mguHmi) || !pkg.mguHmi.length || !pkg.mguHmi.every((h) => h === 'ID7' || h === 'ID8')) {
    fail(`${tree}/package.json: mguHmi must be ["ID7"], ["ID8"] or both`);
}
if (fs.existsSync(path.join(APP, tree, 'javascript', 'app.js'))) {
    fail(`${tree}/javascript/app.js exists: the build writes it, never commit it`);
}
if (fs.existsSync(path.join(APP, tree, 'node_modules', 'oap-sdk'))) {
    fail(`${tree}/node_modules/oap-sdk exists: the SDK must not be in the repository`);
}
const appJson = readJson(`${tree}/rhmiData/application.json`);
const application = (appJson && appJson.application) || {};
if (application.name !== m.id || application.version !== m.version) {
    fail(`rhmiData/application.json is ${application.name}@${application.version}, not ${m.id}@${m.version}`);
}

/* ---- modules ---- */
const modules = Array.isArray(m.modules) ? m.modules : [];
const sdk = Array.isArray(m.sdk) ? m.sdk : [];
if (!modules.length) fail('mgu-app.json: modules is empty');
if (!sdk.length) fail('mgu-app.json: sdk is empty');
/* The car's linker (mgu-store tools/oap_link.js) names each module
 * ./<file name>.js and takes a relative require only by that exact name. */
const moduleNames = modules.map((f) => `./${path.basename(f)}`);
const sources = {};
modules.forEach((rel) => {
    const file = path.join(APP, rel);
    if (!fs.existsSync(file)) {
        fail(`module ${rel} is missing`);
        return;
    }
    const src = fs.readFileSync(file, 'utf8');
    sources[rel] = src;
    const r = cp.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) fail(`${rel} does not compile:\n${r.stderr}`);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"/g, '""');
    if (/\?\.[^\d]|\?\?/.test(code)) fail(`${rel}: uses ?. or ?? (the head unit runs Node 8)`);
    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let hit;
    while ((hit = re.exec(src))) {
        const name = hit[1];
        const ok = sdk.indexOf(name) >= 0 || builtins.indexOf(name) >= 0 ||
            moduleNames.indexOf(name) >= 0;
        if (!ok) fail(`${rel}: require('${name}') is not a module, an sdk name or a Node builtin`);
    }
});

/* ---- screens ---- */
const texts = readJson(`${tree}/rhmiData/variantGroups/Common/texts/en_GB.json`) || {};
/* Screen names in src: 'ST_...' states and '<name>...' components, <name>
 * being the id after its prefix (daniel_hello: helloStatus). */
const short = String(m.id || '').replace(/^[^_]*_/, '').replace(/[^A-Za-z0-9]/g, '');
const nameRe = new RegExp(`^(ST_\\w+|${short}[A-Z]\\w*)$`);
const used = new Set();
Object.keys(sources).forEach((rel) => {
    (sources[rel].match(/'\w+'/g) || []).map((s) => s.slice(1, -1))
        .filter((n) => nameRe.test(n)).forEach((n) => used.add(n));
});
const hmis = Array.isArray(pkg.mguHmi) ? pkg.mguHmi : [];
const namesByHmi = {};
hmis.forEach((hmi) => {
    const dir = `${tree}/rhmiData/uiDescriptions/${hmi}`;
    const ui = readJson(`${dir}/uiDescription.json`);
    let xml = '';
    try {
        xml = fs.readFileSync(path.join(APP, dir, 'application.xml'), 'utf8');
    } catch (e) {
        fail(`${dir}/application.xml: missing`);
    }
    if (!ui) return;
    const ids = [];
    const names = new Set();
    const xmlIds = new Set((xml.match(/<(?:container|component|layoutGroup) id="(\d+)"/g) || []).map((s) => /"(\d+)"/.exec(s)[1]));
    (xml.match(/<layoutGroup id="(\d+)"/g) || []).forEach((s) => ids.push(/"(\d+)"/.exec(s)[1]));
    Object.keys(ui.containers || {}).forEach((cid) => {
        const c = ui.containers[cid];
        ids.push(cid);
        names.add(c.name);
        if (!xmlIds.has(cid)) fail(`${dir}: container ${cid} (${c.name}) is not in application.xml`);
        if (hmi === 'ID8' && c.properties && c.properties.ParentState) fail(`${dir}: ${c.name} has a ParentState (iDrive 8 refuses it)`);
        Object.keys(c.components || {}).forEach((id) => {
            const comp = c.components[id];
            ids.push(id);
            names.add(comp.name);
            if (!xmlIds.has(id)) fail(`${dir}: component ${id} (${comp.name}) is not in application.xml`);
            if (!Array.isArray(comp.rows) || comp.rows.length !== 1) fail(`${dir}: ${comp.name} must have one row`);
            (comp.rows || []).forEach((row) => Object.keys(row).forEach((cell) => {
                const v = row[cell];
                if (v && v.type === 'StringId' && !Object.prototype.hasOwnProperty.call(texts, v.value)) {
                    fail(`${dir}: ${comp.name}.${cell} uses ${v.value}, which en_GB.json lacks`);
                }
            }));
        });
    });
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) fail(`${dir}: ids used twice: ${[...new Set(dup)].join(', ')}`);
    namesByHmi[hmi] = names;
});
used.forEach((name) => {
    if (!hmis.some((hmi) => namesByHmi[hmi] && namesByHmi[hmi].has(name))) {
        fail(`src uses '${name}', which no uiDescription names`);
    }
});
hmis.forEach((hmi) => {
    if (!namesByHmi[hmi]) return;
    used.forEach((name) => {
        if (!namesByHmi[hmi].has(name) && !/HmiID8$/.test(name)) fail(`uiDescriptions/${hmi} lacks '${name}', which src uses`);
    });
});

/* ---- the tile ---- */
(application.entryPoints || []).forEach((ep) => {
    if (!Object.prototype.hasOwnProperty.call(texts, ep.textId)) fail(`entry point textId ${ep.textId} is not in en_GB.json`);
    const icon = path.join(APP, tree, 'rhmiData', 'variantGroups', 'Common', 'images', ep.icon || '');
    if (!ep.icon || !fs.existsSync(icon)) {
        fail(`entry point icon ${ep.icon} is missing (node tools/make_icon.js)`);
    } else {
        const buf = fs.readFileSync(icon);
        if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') fail(`${ep.icon} is not a PNG`);
        if (buf.length > 128 * 1024) fail(`${ep.icon} is ${buf.length} bytes, over 128 KiB`);
    }
});
if (!(application.entryPoints || []).length) fail('rhmiData/application.json has no entry point (tile)');

/* ---- start, manifest, assets ---- */
if (pkg.mguAppStartType !== 'autostart') fail(`${tree}/package.json: mguAppStartType must be autostart (the theme shows without opening the app)`);
if (!Array.isArray(pkg.files) || pkg.files.indexOf('assets') < 0) fail(`${tree}/package.json: files must list assets`);
const manifest = readJson(`${tree}/manifest.json`) || {};
const proxies = manifest.proxies || {};
const { Car } = require('../src/car.js');
Object.keys(Car.FIELDS).forEach((iface) => {
    const entry = proxies[iface];
    Object.keys(Car.FIELDS[iface]).forEach((field) => {
        const ok = entry === '*' || (entry && entry.attributes && entry.attributes[field] && (entry.instances || []).indexOf('1') >= 0);
        if (!ok) fail(`manifest.json lacks ${iface} instance 1 attribute ${field} (src/car.js reads it)`);
    });
});
const { decode } = require('../src/png.js');
const allowRender = process.argv.indexOf('--allow-render-plate') >= 0;
const warnings = [];
const assetsDir = path.join(APP, tree, 'assets');
const themesList = readJson(`${tree}/assets/themes.json`);
((themesList && themesList.themes) || []).forEach((th) => {
    const dir = path.join(assetsDir, th.id);
    const png = (f, w, h) => {
        try {
            const img = decode(fs.readFileSync(path.join(dir, f)));
            if ((w && img.width !== w) || (h && img.height !== h)) fail(`assets/${th.id}/${f} is ${img.width}x${img.height}, not ${w}x${h}`);
            return img;
        } catch (e) {
            fail(`assets/${th.id}/${f}: ${e.code === 'ENOENT' ? 'missing (node tools/build_assets.js)' : e.message}`);
            return null;
        }
    };
    const t = readJson(`${tree}/assets/${th.id}/theme.json`);
    png('plate.png', 1920, 720);
    png('needle.png');
    if (t) {
        png('hub_speed.png', 2 * t.hubRadius, 2 * t.hubRadius);
        png('hub_rpm.png', 2 * t.hubRadius, 2 * t.hubRadius);
        if (t.plateIsRender) (allowRender ? warnings : errors).push(`assets/${th.id}/plate.png is the render itself, needles and readouts painted in: put the clean plate at ${'themes/' + th.id + '.json'} "plate" and run node tools/build_assets.js`);
        ['speed', 'rpm'].forEach((g) => {
            const sc = t[g];
            if (!sc || !Array.isArray(sc.points) || sc.points.length < 2) { fail(`theme ${th.id}: ${g} needs at least 2 points`); return; }
            sc.points.forEach((p, i) => { if (i && p[0] <= sc.points[i - 1][0]) fail(`theme ${th.id}: ${g} points must rise (${p[0]})`); });
        });
        const fonts = readJson(`${tree}/assets/${th.id}/glyphs.json`) || {};
        const need = { speed: '0123456789', gear: 'PRND123456789', rpm: '0123456789,' };
        Object.keys(t.readouts || {}).forEach((k) => {
            const f = fonts[k];
            if (!f) { fail(`assets/${th.id}/glyphs.json has no ${k}`); return; }
            for (const ch of need[k] || '') if (!f.glyphs[ch]) fail(`assets/${th.id}/glyphs.json ${k} lacks '${ch}'`);
            const b = t.readouts[k].box;
            if (!(b && b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= 1920 && b[1] + b[3] <= 720)) fail(`theme ${th.id}: readout ${k} box is off the cluster`);
        });
    }
});
if (!themesList || !(themesList.themes || []).length) fail('assets/themes.json lists no theme (node tools/build_assets.js)');
warnings.forEach((w) => console.warn(`WARN ${w}`));

if (errors.length) {
    console.error(errors.map((e) => `FAIL ${e}`).join('\n'));
    process.exitCode = 1;
} else {
    console.log(`ok: ${m.id}@${m.version}, ${modules.length} module(s), screens for ${hmis.join(' and ')}`);
}
