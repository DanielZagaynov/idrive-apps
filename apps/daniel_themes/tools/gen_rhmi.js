'use strict';
/**
 * Writes the app's screens and texts from the table below, for iDrive 7
 * (package.json mguHmi: iDrive 7 only), so ids, names, widgets and cells stay in step:
 *
 *   package/rhmiData/uiDescriptions/ID7/{application.xml,uiDescription.json}
 *   package/rhmiData/variantGroups/Common/texts/{en_GB,en_US}.json
 *
 * Widgets follow the ones mgu-store's own Store app uses on each head unit
 * (apps/robertn_store/tools/gen_rhmi.js there). Ids share one space across
 * containers, layout groups (100 + 2 * state id, + 1) and components.
 * iDrive 8 states have no ParentState, and its description has the hidden
 * label themesHmiID8 by which src/themes.js knows its widgets.
 *
 *   node tools/gen_rhmi.js
 *
 * To add a page: add a state() to STATES with a parent, give its components
 * new ids, and open it from the app with rhmiApplication.getByName(<name>).
 * Name states ST_<Something> and components themes<Something> (the app's id
 * after its prefix): tools/check.js checks those names against src/.
 */
const fs = require('fs');
const path = require('path');

const PKG = path.join(__dirname, '..', 'package');
const DIR = (hmi) => path.join(PKG, 'rhmiData', 'uiDescriptions', hmi);
const TEXTS = path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'texts');
const PREFIX = 'SID_THEMES_';

/* Kinds: button (one line of text, pressable), label (one line), text (a
 * label wrapped over up to four rows). */
const button = (id, name, text) => ({ id, kind: 'button', name, text, focusable: 3 });
const label = (id, name, text) => ({ id, kind: 'label', name, text: text || '', focusable: 0 });
const text = (id, name, t) => ({ id, kind: 'text', name, text: t || '', focusable: 0 });

const media = (primary) => ({ PrimaryText: primary, FrequencyText: '', FrequencyVisible: false,
    IconVisible: false, ProgressVisible: false, IsPlaying: false });
const WIDGETS = {
    ID7: {
        state: 'LT_State_Wide',
        button: (c) => ({ type: 'button', widget: 'LT_Button_1Row', cells: { Text: c.text } }),
        label: (c) => ({ type: 'label', widget: 'LT_Label_1Row', cells: { Text: c.text } }),
        text: (c) => ({ type: 'label', widget: 'LT_Label_4Row_1TextDyn', cells: { Text: c.text } })
    },
    ID8: {
        state: 'LT_State_Wide_List',
        button: (c) => ({ type: 'button', widget: 'LT_Button_MediaEntry_1Row', cells: media(c.text) }),
        label: (c) => ({ type: 'label', widget: 'LT_ScrollLabel', cells: { Text: c.text } }),
        text: (c) => ({ type: 'label', widget: 'LT_ScrollLabel', cells: { Text: c.text } })
    }
};

/* The string id of English words: SID_THEMES_ and the words in capitals. */
const sid = (words) => PREFIX + words.replace(/\?/g, ' Q').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
const words = (t) => (t ? { value: sid(t), type: 'StringId' } : { value: '', type: 'Text' });

function state(id, name, titleId, title, parent, components) {
    return { id, name, titleId, title, parent, components };
}

/* ---- the app's pages ---- */

const TITLE = 'Cluster Themes';      // the tile's and the main page's title (SID_THEMES_TITLE)

const STATES = [
    state(1, 'ST_Themes_Main', 10, TITLE, null, [
        text(20, 'themesStatus', 'Starting'),
        label(21, 'themesTheme', 'Theme'),
        button(22, 'themesToggle', 'Turn theme off'),
        button(23, 'themesGlow', 'Turn glow off')
    ])
];

function statesFor(hmi) {
    if (hmi === 'ID7') {
        return STATES;
    }
    const states = STATES.map((s) => Object.assign({}, s, { parent: null }));
    states[0] = Object.assign({}, states[0], { components: states[0].components.concat([
        Object.assign(label(70, 'themesHmiID8'), { visible: 0 })]) });
    return states;
}

const titleWords = (s) => (s.title === TITLE ? { value: `${PREFIX}TITLE`, type: 'StringId' } : words(s.title));

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
            Object.keys(w.cells).forEach((k) => {
                const v = w.cells[k];
                cells[k] = typeof v === 'boolean' ? { value: v, type: 'Bool' } : words(v);
            });
            components[c.id] = {
                type: w.type,
                name: c.name,
                properties: { Visible: { value: c.visible === 0 ? 0 : 1, type: 'UInt' }, Focusable: { value: c.focusable, type: 'UInt' } },
                rows: [cells]
            };
        });
        containers[s.id] = Object.assign({ type: 'state', name: s.name },
            s.parent ? { properties: { ParentState: { value: s.parent, type: 'UInt' } } } : {},
            { components });
    });
    return { schemaVersion: '1.3.0', containers };
}

/* The words behind every string id. */
function english() {
    const out = { SID_TEMP_EMPTY: '', [`${PREFIX}TITLE`]: TITLE };
    HMIS.forEach((hmi) => statesFor(hmi).forEach((s) => {
        [s.title].concat(s.components.map((c) => c.text)).filter(Boolean)
            .forEach((t) => { out[sid(t)] = t; });
    }));
    return out;
}

/* The head units the app is for (package.json mguHmi): the whole-cluster
 * target is iDrive 7's alone, so only iDrive 7's screens are written. */
const HMIS = ['ID7'];

/* English only; add more files (de_DE.json, ...) with the same ids for other languages. */
const LANGUAGES = ['en_GB', 'en_US'];

function write() {
    HMIS.forEach((hmi) => {
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
    console.log(`wrote rhmiData uiDescriptions (${HMIS.join(', ')}) and texts`);
}

module.exports = { write, statesFor, DIR, HMIS };
