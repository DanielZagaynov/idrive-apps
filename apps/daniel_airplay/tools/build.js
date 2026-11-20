'use strict';
/**
 * Regenerates the screens, checks the folder and packs the source package
 * with mgu-store's own linker, the same code the car's deploy tool runs.
 *
 *   node tools/build.js --mgu-store <mgu-store checkout>                  daniel_airplay@<v>.src.tgz
 *   node tools/build.js --mgu-store <checkout> --sdk <donor .tgz|.js>     and daniel_airplay@<v>.tgz
 *
 * (or MGU_STORE / MGU_SDK_DONOR in the environment). The donor is a stock
 * BMW app's package or javascript/app.js copied off your head unit: it holds
 * BMW's SDK, so keep it outside this repository and never commit it.
 *
 * You do not need this to install the app: the car builds it from the
 * repository by itself. It is for checking that the car's build will
 * accept the folder, and for a USB stick.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const APP = path.join(__dirname, '..');

function arg(flag, env) {
    const argv = process.argv.slice(2);
    const i = argv.indexOf(flag);
    if (i >= 0) {
        if (!argv[i + 1]) throw new Error(`${flag} needs a path`);
        return path.resolve(argv[i + 1]);
    }
    return process.env[env] ? path.resolve(process.env[env]) : null;
}

function main() {
    require('./gen_rhmi.js').write();
    const icon = path.join(APP, 'package', 'rhmiData', 'variantGroups', 'Common', 'images', 'airplay_icon.png');
    if (!fs.existsSync(icon)) require('./make_icon.js');
    const check = cp.spawnSync(process.execPath, [path.join(__dirname, 'check.js')], { stdio: 'inherit' });
    if (check.status !== 0) throw new Error('tools/check.js failed');

    const store = arg('--mgu-store', 'MGU_STORE');
    if (!store) {
        console.log('checked; pass --mgu-store <checkout of github.com/robertnisipeanu/mgu-store> to pack');
        return;
    }
    const link = require(path.join(store, 'tools', 'oap_link.js'));
    const m = link.readManifest(APP);
    const out = { source: `${m.id}@${m.version}.src.tgz` };
    out.sourceFiles = link.packSource(APP, path.join(APP, out.source));
    const donor = arg('--sdk', 'MGU_SDK_DONOR');
    if (donor) {
        const r = link.build(APP, path.join(APP, `${m.id}@${m.version}.tgz`), { donors: [donor] });
        Object.assign(out, { tgz: path.basename(r.file), donor: r.donor, bundleModules: r.moduleCount, bundleBytes: r.bytes });
    }
    console.log(JSON.stringify(out, null, 2));
}

try {
    main();
} catch (e) {
    console.error(`build: ${e.message}`);
    process.exitCode = 1;
}
