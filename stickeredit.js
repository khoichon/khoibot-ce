// The sticker editor behind !edit. It works on a 512x512 sticker and every
// point is x,y in pixels with (0,0) in the top left corner.
//
//   crop 10,10;200,10;100,150     keep only the inside of the shape
//   cut 10,10;200,10;100,150      make the inside of the shape transparent
//   draw 10,10;200,10;100,150     draw a shape or line (-clr, -fill, -w, -open)
//   text 256,256 hello            put text with its middle at the point (-clr, -size)
//   grid [step]                   the image with a coordinate grid, to find points
//
// Several operations can be chained with | and run from left to right.
// parse() turns the command into operations or an error message, render()
// draws the operations on an image, and renderGrid() makes the grid picture.

const SIZE = 512;
const MAX_OPERATIONS = 8;
const MAX_POINTS = 100;
const MAX_TEXT = 100;
const DEFAULT_GRID_STEP = 64;
const MIN_GRID_STEP = 16;

const NAMED_COLORS = new Set([
    "black", "white", "red", "green", "blue", "yellow", "purple", "orange", "pink",
    "gray", "grey", "cyan", "magenta", "lime", "navy", "maroon", "teal", "gold", "silver", "brown"
]);

function normalizeColor(raw) {
    if (!raw) {
        return null;
    }
    let color = raw.trim().toLowerCase();
    if (NAMED_COLORS.has(color)) {
        return color;
    }
    color = color.replace(/^&?#/, "");
    return /^([0-9a-f]{3}|[0-9a-f]{6})$/.test(color) ? `#${color}` : null;
}

function escapeXml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

const POINT = /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/;

// "10,10;200,10" becomes [[10,10],[200,10]], or null if it is not a list of points.
function parsePoints(token) {
    if (!token) {
        return null;
    }
    const parts = token.replace(/;+$/, "").split(";");
    if (parts.length > MAX_POINTS || parts.some(part => !POINT.test(part))) {
        return null;
    }
    return parts.map(part => part.split(",").map(number => clamp(Number(number), 0, SIZE)));
}

// Takes the options out of one operation and returns them with what is left.
function takeOptions(tokens) {
    const options = {};
    const rest = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const lower = token.toLowerCase();
        if (lower === "-open") {
            options.open = true;
        } else if (lower === "-clr" || lower === "-fill" || lower === "-w" || lower === "-size") {
            const value = tokens[index + 1];
            if (value === undefined) {
                return { error: `${lower} needs a value.` };
            }
            options[lower.slice(1)] = value;
            index++;
        } else {
            rest.push(token);
        }
    }
    return { options, rest };
}

function parseColorOption(options, name, fallback) {
    if (options[name] === undefined) {
        return { value: fallback };
    }
    if (options[name].toLowerCase() === "none") {
        return { value: "none" };
    }
    const color = normalizeColor(options[name]);
    return color ? { value: color } : { error: `-${name} must be a color (a name or hex code), or none.` };
}

function parseNumberOption(options, name, fallback, min, max) {
    if (options[name] === undefined) {
        return { value: fallback };
    }
    const number = Number(options[name]);
    if (!Number.isFinite(number) || number < min || number > max) {
        return { error: `-${name} must be a number from ${min} to ${max}.` };
    }
    return { value: number };
}

function parseOperation(chunk) {
    const tokens = chunk.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return { error: "There is an empty operation. Check for a stray |." };
    }
    const name = tokens.shift().toLowerCase();

    if (name === "grid") {
        const step = tokens.length > 0 ? Number(tokens[0]) : DEFAULT_GRID_STEP;
        if (!Number.isInteger(step) || step < MIN_GRID_STEP || step > SIZE) {
            return { error: `The grid step must be a whole number from ${MIN_GRID_STEP} to ${SIZE}.` };
        }
        return { operation: { type: "grid", step } };
    }

    if (name !== "crop" && name !== "cut" && name !== "draw" && name !== "text") {
        return { error: `"${name}" is not an operation. Use crop, cut, draw, text or grid.` };
    }

    const taken = takeOptions(tokens);
    if (taken.error) {
        return { error: taken.error };
    }
    const { options, rest } = taken;

    if (name === "text") {
        const point = rest.shift();
        const position = POINT.test(point || "") ? parsePoints(point)[0] : null;
        if (!position) {
            return { error: "text needs a point first, for example: text 256,256 hello" };
        }
        const words = rest.join(" ");
        if (!words) {
            return { error: "text needs some words after the point." };
        }
        if (words.length > MAX_TEXT) {
            return { error: `The text is too long (${MAX_TEXT} characters maximum).` };
        }
        const color = parseColorOption(options, "clr", "white");
        const size = parseNumberOption(options, "size", 48, 8, 300);
        const failure = color.error || size.error;
        if (failure) {
            return { error: failure };
        }
        return { operation: { type: "text", position, text: words, color: color.value, size: size.value } };
    }

    const points = parsePoints(rest.shift());
    if (!points || rest.length > 0) {
        return { error: `${name} needs points like 10,10;200,10;100,150 (no spaces).` };
    }
    if (name === "draw") {
        if (points.length < 2) {
            return { error: "draw needs at least 2 points." };
        }
        const stroke = parseColorOption(options, "clr", "red");
        const fill = parseColorOption(options, "fill", "none");
        const width = parseNumberOption(options, "w", 4, 1, 40);
        const failure = stroke.error || fill.error || width.error;
        if (failure) {
            return { error: failure };
        }
        const closed = points.length >= 3 && !options.open;
        return { operation: { type: "draw", points, stroke: stroke.value, fill: fill.value, width: width.value, closed } };
    }

    if (points.length < 3) {
        return { error: `${name} needs at least 3 points.` };
    }
    return { operation: { type: name, points } };
}

// text is what comes after the command name.
function parse(text) {
    const body = text.trim();
    if (!body) {
        return { error: "empty" };
    }
    const chunks = body.split("|");
    if (chunks.length > MAX_OPERATIONS) {
        return { error: `That is too many operations (${MAX_OPERATIONS} maximum).` };
    }
    const operations = [];
    for (const chunk of chunks) {
        const result = parseOperation(chunk);
        if (result.error) {
            return { error: result.error };
        }
        operations.push(result.operation);
    }
    const grids = operations.filter(operation => operation.type === "grid");
    if (grids.length > 0 && operations.length > 1) {
        return { error: "grid is used on its own, to find the points. It can't be chained with other operations." };
    }
    return { operations };
}


// ---------- Drawing ----------

function pointsAttribute(points) {
    return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}

function svgFor(operation) {
    let shape;
    if (operation.type === "crop" || operation.type === "cut") {
        shape = `<polygon points="${pointsAttribute(operation.points)}" fill="#000"/>`;
    } else if (operation.type === "draw") {
        const tag = operation.closed ? "polygon" : "polyline";
        const fill = operation.closed ? operation.fill : "none";
        shape = `<${tag} points="${pointsAttribute(operation.points)}" fill="${fill}" stroke="${operation.stroke}" stroke-width="${operation.width}" stroke-linejoin="round" stroke-linecap="round"/>`;
    } else {
        const [x, y] = operation.position;
        const outline = Math.max(2, Math.round(operation.size / 12));
        shape = `<text x="${x}" y="${y}" font-family="sans-serif" font-weight="bold" font-size="${operation.size}" text-anchor="middle" dominant-baseline="central" fill="${operation.color}" stroke="${operation.color === "black" ? "white" : "black"}" stroke-width="${outline}" paint-order="stroke" stroke-linejoin="round">${escapeXml(operation.text)}</text>`;
    }
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">${shape}</svg>`);
}

// The image on a transparent 512x512 canvas.
async function canvasFrom(input) {
    const sharp = require("sharp");
    return sharp(input)
        .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .png()
        .toBuffer();
}

// Returns a PNG with the operations applied.
async function render(input, operations) {
    const sharp = require("sharp");
    let image = await canvasFrom(input);
    for (const operation of operations) {
        const blend = operation.type === "crop" ? "dest-in" : operation.type === "cut" ? "dest-out" : "over";
        image = await sharp(image)
            .composite([{ input: svgFor(operation), blend }])
            .png()
            .toBuffer();
    }
    return image;
}

// The image at twice the size with a grid and the coordinates written on it.
async function renderGrid(input, step) {
    const sharp = require("sharp");
    const base = await canvasFrom(input);
    const lines = [];
    const labels = [];
    for (let value = 0; value <= SIZE; value += step) {
        lines.push(`<line x1="${value}" y1="0" x2="${value}" y2="${SIZE}"/><line x1="0" y1="${value}" x2="${SIZE}" y2="${value}"/>`);
        const textAttributes = `font-family="sans-serif" font-size="9" fill="#fff" stroke="#000" stroke-width="2.5" paint-order="stroke"`;
        labels.push(`<text x="${clamp(value + 2, 0, SIZE - 18)}" y="9" ${textAttributes}>${value}</text>`);
        if (value > 0) {
            labels.push(`<text x="2" y="${clamp(value - 2, 9, SIZE)}" ${textAttributes}>${value}</text>`);
        }
    }
    const overlay = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
        `<g stroke="#ff00cc" stroke-opacity="0.7" stroke-width="0.7">${lines.join("")}</g>${labels.join("")}</svg>`
    );
    // density 144 draws the 512 wide drawing at 1024 pixels, so the labels stay sharp
    const overlayLarge = await sharp(overlay, { density: 144 }).png().toBuffer();
    const background = await sharp(base)
        .resize(SIZE * 2, SIZE * 2, { kernel: "lanczos3" })
        .flatten({ background: "#808080" })
        .png()
        .toBuffer();
    return sharp(background).composite([{ input: overlayLarge }]).png().toBuffer();
}

// A PNG made by render() as a sticker under about 100KB.
async function toSticker(png) {
    const sharp = require("sharp");
    let quality = 80;
    let output;
    do {
        output = await sharp(png).webp({ quality }).toBuffer();
        quality -= 20;
    } while (output.length > 100 * 1024 && quality >= 20);
    return output;
}

module.exports = { parse, render, renderGrid, toSticker, SIZE };
