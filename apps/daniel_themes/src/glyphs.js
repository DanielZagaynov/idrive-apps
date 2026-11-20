'use strict';
/**
 * glyphs.js - draws a readout's text into an RGBA buffer (straight alpha)
 * from the glyphs tools/build_assets.js baked for it at its exact size
 * (Barlow SemiBold, OFL): no scaling on the car, only copies and blends.
 *
 * A font file (package/assets/<theme>/glyphs.json) is { <readout>: font },
 * font = { capHeight, shadow: { dx, dy, alpha }, glyphs: { <char>: glyph } },
 * glyph = { w, h, ox, oy, adv, a: base64 alpha, s: { w, h, ox, oy, a } }
 * (ox, oy from the pen at the baseline; s is the blurred shadow).
 */

function unpack(font) {
    Object.keys(font.glyphs).forEach((ch) => {
        const g = font.glyphs[ch];
        if (typeof g.a === 'string') g.a = Buffer.from(g.a, 'base64');
        if (g.s && typeof g.s.a === 'string') g.s.a = Buffer.from(g.s.a, 'base64');
    });
    return font;
}

function rgb(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
}

function width(font, text) {
    let w = 0;
    for (let i = 0; i < text.length; i++) { const g = font.glyphs[text[i]]; if (g) w += g.adv; }
    return w;
}

/* Blends one colour through an alpha map onto img at (x, y): "over", straight alpha. */
function blit(img, iw, ih, map, mw, mh, x, y, color, k) {
    for (let r = 0; r < mh; r++) {
        const py = y + r;
        if (py < 0 || py >= ih) continue;
        for (let c = 0; c < mw; c++) {
            const px = x + c;
            if (px < 0 || px >= iw) continue;
            const sa = map[r * mw + c] * k / 255;
            if (sa <= 0) continue;
            const o = (py * iw + px) * 4, da = img[o + 3] / 255, oa = sa + da * (1 - sa);
            for (let j = 0; j < 3; j++) img[o + j] = Math.round((color[j] * sa + img[o + j] * da * (1 - sa)) / oa);
            img[o + 3] = Math.round(oa * 255);
        }
    }
}

/**
 * Draws text into img (iw x ih RGBA): x is the left, centre or right edge
 * by opts.align, y the middle of the capitals. opts.color is '#rrggbb'.
 */
function draw(img, iw, ih, font, text, x, y, opts) {
    const o = opts || {};
    const w = width(font, text);
    let pen = Math.round(o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x);
    const base = Math.round(y + font.capHeight / 2);
    const col = rgb(o.color || '#ffffff');
    const sh = font.shadow || { dx: 0, dy: 0, alpha: 0 };
    if (sh.alpha > 0) {
        let p = pen;
        for (let i = 0; i < text.length; i++) {
            const g = font.glyphs[text[i]];
            if (!g) continue;
            if (g.s) blit(img, iw, ih, g.s.a, g.s.w, g.s.h, p + g.s.ox + sh.dx, base + g.s.oy + sh.dy, [0, 0, 0], sh.alpha);
            p += g.adv;
        }
    }
    for (let i = 0; i < text.length; i++) {
        const g = font.glyphs[text[i]];
        if (!g) continue;
        blit(img, iw, ih, g.a, g.w, g.h, pen + g.ox, base + g.oy, col, 1);
        pen += g.adv;
    }
}

module.exports = { unpack, width, draw };
