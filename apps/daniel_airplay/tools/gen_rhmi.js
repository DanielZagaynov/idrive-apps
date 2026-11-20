'use strict';
/**
 * Writes the app's screens and texts for iDrive 7 from the table below:
 *
 *   package/rhmiData/uiDescriptions/ID7/{application.xml,uiDescription.json}
 *   package/rhmiData/variantGroups/Common/texts/{en_GB,en_US}.json
 *
 * Pages:
 *   ST_Airplay_Main    LT_State_Wide: status, "Show phone screen", "Stop mirroring"
 *   ST_Airplay_Embed   LT_State_A4A_WelcomeApp: mgu-render draws the phone's
 *                      screen into it (embed placement)
 *   ST_Airplay_Layer   LT_State_Wide: the host page while mgu-render draws on its
 *                      own layer instead (no embed template on this unit)
 * The two screen pages hold one empty focusable button each, as the Store's
 * host pages do: the controller has something to focus and BACK closes the page.
 *
 *   node tools/gen_rhmi.js
 */
const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'package');
const DIR = (hmi) => path.join(PKG, 'rhmiData', 'uiDescriptions', hmi);
const TEXTS = path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'texts');
const PREFIX = 'SID_AIRPLAY_';

const button = (id, name, text) => ({ id, kind: 'button', name, text, focusable: 3 });
const text = (id, name, t) => ({ id, kind: 'text', name, text: t || '', focusable: 0 });

const WIDGETS = {
    ID7: {
        state: 'LT_State_Wide',
        button: (c) => ({ type: 'button', widget: 'LT_Button_1Row', cells: { Text: c.text } }),
        text: (c) => ({ type: 'label', widget: 'LT_Label_4Row_1TextDyn', cells: { Text: c.text } })
    }
};

const sid = (words) => PREFIX + words.replace(/\?/g, ' Q').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
const words = (t) => (t ? { value: sid(t), type: 'StringId' } : { value: '', type: 'Text' });

function state(id, name, titleId, title, parent, components, widget) {
    return { id, name, titleId, title, parent, components, widget };
}

/* ---- the app's pages ---- */

const TITLE = 'AirPlay Mirror';   // the tile's and the pages' title (SID_AIRPLAY_TITLE)

const STATES = [
    state(1, 'ST_Airplay_Main', 10, TITLE, null, [
        text(20, 'airplayStatus', 'Starting'),
        button(21, 'airplayShow', 'Show phone screen'),
        button(22, 'airplayStop', 'Stop mirroring')
    ]),
    state(2, 'ST_Airplay_Embed', 11, TITLE, 1, [button(30, 'airplayEmbedFocus', '')], 'LT_State_A4A_WelcomeApp'),
    state(3, 'ST_Airplay_Layer', 12, TITLE, 1, [button(40, 'airplayLayerFocus', '')])
];

function statesFor(hmi) {
    return hmi === 'ID7' ? STATES : [];
}

const titleWords = () => ({ value: `${PREFIX}TITLE`, type: 'StringId' });

function xml(hmi) {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>'];
    statesFor(hmi).forEach((s) => {
        lines.push(`    <container id="${s.id}" type="state" widget="${s.widget || WIDGETS[hmi].state}">`);
        if (s.parent) {
            lines.push(`        <property id="9" value="${s.parent}"/>`);
        }
        lines.push(`        <layoutGroup id="${100 + 2 * s.id}" name="Titlebar">`,
            `            <component id="${s.titleId}" type="title">`,
            '                <property id="2" value="1"/>',
            '            </component>',
            '        </layoutGroup>',
            `        <layoutGroup id="${101 + 2 * s.id}" name="List">`,
            '            <property id="3" value="1"/>');
        s.components.forEach((c) => {
            const w = WIDGETS[hmi][c.kind](c);
            lines.push(`            <component id="${c.id}" type="${w.type}" widget="${w.widget}">`,
                `                <property id="2" value="${c.visible === 0 ? 0 : 1}"/>`,
                `                <property id="3" value="${c.focusable}"/>`,
                '            </component>');
        });
        lines.push('        </layoutGroup>', '    </container>');
    });
    lines.push('</application>', '');
    return lines.join('\n');
}

function uiDescription(hmi) {
    const containers = {};
    statesFor(hmi).forEach((s) => {
        const components = {
            [s.titleId]: {
                type: 'title',
                name: `${s.name}_Title`,
                properties: { Visible: { value: 1, type: 'UInt' } },
                rows: [{ Text: titleWords(s) }]
            }
        };
        s.components.forEach((c) => {
            const w = WIDGETS[hmi][c.kind](c);
            const cells = {};
            Object.keys(w.cells).forEach((k) => { cells[k] = words(w.cells[k]); });
            components[c.id] = {
                type: w.type,
                name: c.name,
                properties: { Visible: { value: 1, type: 'UInt' }, Focusable: { value: c.focusable, type: 'UInt' } },
                rows: [cells]
            };
        });
        containers[s.id] = Object.assign({ type: 'state', name: s.name },
            s.parent ? { properties: { ParentState: { value: s.parent, type: 'UInt' } } } : {},
            { components });
    });
    return { schemaVersion: '1.3.0', containers };
}

function english() {
    const out = { SID_TEMP_EMPTY: '', [`${PREFIX}TITLE`]: TITLE };
    statesFor('ID7').forEach((s) => s.components.map((c) => c.text).filter(Boolean).forEach((t) => { out[sid(t)] = t; }));
    return out;
}

const LANGUAGES = ['en_GB', 'en_US'];

function write() {
    ['ID7'].forEach((hmi) => {
        fs.mkdirSync(DIR(hmi), { recursive: true });
        fs.writeFileSync(path.join(DIR(hmi), 'application.xml'), xml(hmi));
        fs.writeFileSync(path.join(DIR(hmi), 'uiDescription.json'), JSON.stringify(uiDescription(hmi), null, 2) + '\n');
    });
    fs.mkdirSync(TEXTS, { recursive: true });
    const en = JSON.stringify(english(), null, 2) + '\n';
    LANGUAGES.forEach((l) => fs.writeFileSync(path.join(TEXTS, `${l}.json`), en));
}

if (require.main === module) {
    write();
    console.log('wrote rhmiData uiDescriptions (ID7) and texts');
}

module.exports = { write, statesFor, DIR };
