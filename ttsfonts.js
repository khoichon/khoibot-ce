// Draws the text of !tts from the font files themselves, using fontkit.
// This is what lets a variable font's axes be set (for example MORF on
// Kablammo). If fontkit is not installed, or a font file cannot be found,
// available() or load() say so and extras.js draws normal SVG text instead.

const { execFileSync } = require("node:child_process");

let fontkit = null;
try {
    fontkit = require("fontkit");
} catch {
    fontkit = null;
}

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy"]);

const matchCache = new Map();
const fontCache = new Map();
const fallbackCache = new Map();
const variationCache = new Map();
const pathCache = new WeakMap();

function available() {
    return fontkit !== null;
}

// Asks fontconfig which font file a pattern like "DejaVu Sans:bold" gives.
function match(pattern) {
    if (matchCache.has(pattern)) {
        return matchCache.get(pattern);
    }
    let entry = null;
    try {
        const output = execFileSync("fc-match", ["-f", "%{file}\n%{postscriptname}\n%{family}", pattern], {
            encoding: "utf8",
            timeout: 5000
        });
        const [file, postscript, family] = output.split("\n");
        if (file) {
            entry = { file, postscript: postscript || undefined, family: family || "" };
        }
    } catch {
        entry = null;
    }
    matchCache.set(pattern, entry);
    return entry;
}

function open(entry) {
    const key = `${entry.file}|${entry.postscript || ""}`;
    if (fontCache.has(key)) {
        return fontCache.get(key);
    }
    let font = null;
    try {
        let opened;
        try {
            opened = fontkit.openSync(entry.file, entry.postscript);
        } catch {
            opened = fontkit.openSync(entry.file);
        }
        font = opened.fonts ? opened.fonts[0] : opened;
    } catch {
        font = null;
    }
    fontCache.set(key, font);
    return font;
}

// families is the font stack, for example ["DejaVu Sans", "sans-serif"].
// A named font only counts if fontconfig really has it, otherwise the next
// one is tried.
function find(families, bold) {
    for (const family of families) {
        const wanted = family.toLowerCase();
        const entry = match(`${family}${bold ? ":bold" : ""}`);
        if (!entry) {
            continue;
        }
        const names = entry.family.toLowerCase().split(",").map(name => name.trim());
        if (!GENERIC.has(wanted) && !names.includes(wanted)) {
            continue;
        }
        const font = open(entry);
        if (font) {
            return font;
        }
    }
    return null;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// Sets the axes of a variable font. Axes the font does not have are ignored.
// Without a wght of its own, a bold request uses wght 700.
function withAxes(font, requested, bold) {
    const axes = font.variationAxes || {};
    const settings = {};
    for (const [tag, value] of Object.entries(requested || {})) {
        if (axes[tag]) {
            settings[tag] = clamp(value, axes[tag].min, axes[tag].max);
        }
    }
    if (bold && axes.wght && settings.wght === undefined) {
        settings.wght = clamp(700, axes.wght.min, axes.wght.max);
    }
    if (Object.keys(settings).length === 0) {
        return font;
    }
    const key = `${font.postscriptName || font.familyName}|${JSON.stringify(settings)}`;
    if (!variationCache.has(key)) {
        variationCache.set(key, font.getVariation(settings));
    }
    return variationCache.get(key);
}

// A font that has the character, for when the chosen font does not.
function fallbackFor(codePoint, bold) {
    const key = `${codePoint}|${bold}`;
    if (fallbackCache.has(key)) {
        return fallbackCache.get(key);
    }
    let font = null;
    const entry = match(`sans-serif${bold ? ":bold" : ""}:charset=${codePoint.toString(16)}`);
    if (entry) {
        const opened = open(entry);
        if (opened && opened.hasGlyphForCodePoint(codePoint)) {
            font = withAxes(opened, {}, bold);
        }
    }
    fallbackCache.set(key, font);
    return font;
}

function commandsOf(font, glyph) {
    let cache = pathCache.get(font);
    if (!cache) {
        cache = new Map();
        pathCache.set(font, cache);
    }
    if (!cache.has(glyph.id)) {
        let commands = [];
        try {
            commands = glyph.path.commands;
        } catch {
            commands = [];
        }
        cache.set(glyph.id, commands);
    }
    return cache.get(glyph.id);
}

// Finds the font for a stack and the requested axes. Returns null when the
// text cannot be drawn this way.
function load(families, requestedAxes, bold) {
    if (!fontkit) {
        return null;
    }
    const base = find(families, bold);
    if (!base) {
        return null;
    }
    // Fonts drawn with COLRv1 paint graphs (Bitcount Ink) have no plain
    // outlines for fontkit to read, so those are left to normal SVG text.
    try {
        if (base.COLR && base.COLR.version >= 1) {
            return null;
        }
    } catch {
        return null;
    }
    return { font: withAxes(base, requestedAxes, bold), bold, axes: Object.keys(base.variationAxes || {}) };
}

// Lays one line out. Positions are in em, so the same layout works at any
// font size. Each glyph has the index of its first character in the line
// (column) so colors and animations can follow the characters.
function layout(loaded, line) {
    const glyphs = [];
    let cursor = 0;
    let column = 0;

    const runs = [];
    for (const character of line) {
        const codePoint = character.codePointAt(0);
        let font = loaded.font;
        if (codePoint > 32 && !font.hasGlyphForCodePoint(codePoint)) {
            font = fallbackFor(codePoint, loaded.bold);
        }
        const last = runs[runs.length - 1];
        if (last && last.font === font) {
            last.text += character;
        } else {
            runs.push({ font, text: character, column });
        }
        column += character.length;
    }

    for (const run of runs) {
        if (!run.font) {
            cursor += 0.5 * run.text.length;
            continue;
        }
        const result = run.font.layout(run.text);
        const unit = 1 / run.font.unitsPerEm;
        let used = 0;
        result.glyphs.forEach((glyph, index) => {
            const position = result.positions[index];
            const consumed = (glyph.codePoints || []).reduce((sum, point) => sum + String.fromCodePoint(point).length, 0) || 1;
            const commands = commandsOf(run.font, glyph);
            if (commands.length > 0) {
                glyphs.push({
                    commands,
                    x: cursor + (position.xOffset || 0) * unit,
                    y: (position.yOffset || 0) * unit,
                    upem: run.font.unitsPerEm,
                    column: run.column + used
                });
            }
            cursor += position.xAdvance * unit;
            used += consumed;
        });
    }

    return { glyphs, width: cursor, length: line.length };
}

// The outline of a glyph as SVG path data, already scaled to the font size
// and moved to x, y (the baseline). Doing this here, instead of with a
// transform on the shape, keeps gradients across the text correct.
function bake(glyph, size, x, y) {
    const scale = size / glyph.upem;
    const fx = value => (x + value * scale).toFixed(2);
    const fy = value => (y - value * scale).toFixed(2);
    const parts = [];
    for (const { command, args } of glyph.commands) {
        if (command === "moveTo") {
            parts.push(`M${fx(args[0])} ${fy(args[1])}`);
        } else if (command === "lineTo") {
            parts.push(`L${fx(args[0])} ${fy(args[1])}`);
        } else if (command === "quadraticCurveTo") {
            parts.push(`Q${fx(args[0])} ${fy(args[1])} ${fx(args[2])} ${fy(args[3])}`);
        } else if (command === "bezierCurveTo") {
            parts.push(`C${fx(args[0])} ${fy(args[1])} ${fx(args[2])} ${fy(args[3])} ${fx(args[4])} ${fy(args[5])}`);
        } else if (command === "closePath") {
            parts.push("Z");
        }
    }
    return parts.join("");
}

module.exports = { available, load, layout, bake };
