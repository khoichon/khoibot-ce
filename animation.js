// Animated stickers: the !tts animation styles, videos and GIFs, and image slideshows.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MAX_BYTES = 480 * 1024;
const FRAME_DELAY_MS = 80;
const VIDEO_MAX_SECONDS = 8;
const VIDEO_MAX_INPUT_BYTES = 20 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 90 * 1000;

const STYLES = ["wave", "bounce", "glitch", "typewriter", "neon", "spin", "appear"];


// ---------- Text animation styles ----------

function frameCount(style, length) {
    if (style === "appear") {
        return 24;
    }
    return style === "typewriter" ? Math.min(32, Math.max(12, length + 8)) : 20;
}

// Starts small, blurred and faint, as if far behind, then comes forward and sharpens.
function appearLook(progress) {
    const eased = 1 - Math.pow(1 - Math.min(1, Math.max(0, progress)), 3);
    return { scale: 0.55 + 0.45 * eased, blur: 14 * (1 - eased), opacity: 0.1 + 0.9 * eased };
}

// Small seeded generator so the glitch frames look the same every time.
function seeded(seed) {
    let value = (seed * 9301 + 49297) % 233280;
    return () => {
        value = (value * 9301 + 49297) % 233280;
        return value / 233280;
    };
}

// What frame `index` of `count` looks like for a style.
// transform: applied to the whole text. blur: glow size. glitch: offsets for the colored copies.
// dy(k) and visible(k): vertical shift and visibility of the k-th character.
function frameState(style, index, count, length) {
    const t = index / count;
    const state = { transform: null, blur: null, glitch: null, dy: null, visible: null, appear: null };

    if (style === "wave") {
        state.dy = k => 18 * Math.sin(2 * Math.PI * t - k * 0.5);
    } else if (style === "bounce") {
        const height = Math.abs(Math.sin(Math.PI * t));
        const squash = 0.1 * (1 - height);
        state.transform = `translate(0 ${-60 * height}) translate(256 256) scale(${1 + squash} ${1 - squash}) translate(-256 -256)`;
    } else if (style === "spin") {
        const cos = Math.cos(2 * Math.PI * t);
        const scale = cos >= 0 ? Math.max(cos, 0.05) : Math.min(cos, -0.05);
        state.transform = `translate(256 0) scale(${scale} 1) translate(-256 0)`;
    } else if (style === "neon") {
        state.blur = 2 + 7 * (0.5 + 0.5 * Math.sin(2 * Math.PI * t));
    } else if (style === "glitch") {
        if (index % 4 !== 0) {
            const random = seeded(index + 1);
            state.glitch = {
                offset: 4 + random() * 8,
                bandY: random() * 400,
                bandHeight: 20 + random() * 60,
                bandShift: (random() < 0.5 ? -1 : 1) * (10 + random() * 30)
            };
        }
    } else if (style === "appear") {
        state.appear = appearLook(index / Math.max(1, count - 9));
    } else if (style === "typewriter") {
        const hold = 6;
        const shown = Math.ceil(length * Math.min(1, index / Math.max(1, count - hold)));
        state.visible = k => k < shown;
    }

    return state;
}


// ---------- Encoding ----------

// Combines PNG frames into one animated webp, lowering the quality until it fits.
async function framesToWebp(frames, delays) {
    const sharp = require("sharp");
    const delay = Array.isArray(delays) ? delays : Array(frames.length).fill(delays);
    let output;
    for (const quality of [70, 55, 40, 30, 20]) {
        output = await sharp(frames, { join: { animated: true } })
            .webp({ quality, loop: 0, delay })
            .toBuffer();
        if (output.length <= MAX_BYTES) {
            return output;
        }
    }
    throw new Error("The sticker is too large even at the lowest quality.");
}

// Images shown one after another, each for `holdMs`.
async function slideshowToWebp(images, holdMs = 700) {
    const sharp = require("sharp");
    const frames = [];
    for (const image of images) {
        frames.push(
            await sharp(image)
                .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .ensureAlpha()
                .png()
                .toBuffer()
        );
    }
    return framesToWebp(frames, holdMs);
}

function run(command, args, timeout) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

// Tries a few settings, from best to smallest, until the file fits.
const VIDEO_ATTEMPTS = [
    { fps: 12, quality: 50, seconds: VIDEO_MAX_SECONDS, size: 512 },
    { fps: 10, quality: 40, seconds: VIDEO_MAX_SECONDS, size: 512 },
    { fps: 8, quality: 30, seconds: 6, size: 448 },
    { fps: 8, quality: 20, seconds: 5, size: 384 }
];

// Returns { buffer, reduced } where reduced says if anything past the first try was needed.
async function videoToWebp(input, { ffmpeg = "ffmpeg" } = {}) {
    if (input.length > VIDEO_MAX_INPUT_BYTES) {
        const error = new Error("The video is too large.");
        error.code = "TOO_LARGE";
        throw error;
    }

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "animsticker-"));
    const source = path.join(dir, "input");
    const target = path.join(dir, "output.webp");

    try {
        await fs.promises.writeFile(source, input);

        for (let attempt = 0; attempt < VIDEO_ATTEMPTS.length; attempt += 1) {
            const { fps, quality, seconds, size } = VIDEO_ATTEMPTS[attempt];
            const base = [
                `fps=${fps}`,
                `scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos`,
                "format=rgba",
                `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black@0`
            ].join(",");

            const args = ["-y", "-v", "error", "-i", source, "-t", String(seconds), "-an", "-vf", base,
                "-c:v", "libwebp_anim", "-lossless", "0", "-quality", String(quality),
                "-compression_level", "4", "-loop", "0", target];

            try {
                await run(ffmpeg, args, FFMPEG_TIMEOUT_MS);
            } catch (error) {
                if (error.code === "ENOENT") {
                    error.code = "NO_FFMPEG";
                }
                throw error;
            }

            const buffer = await fs.promises.readFile(target);
            if (buffer.length <= MAX_BYTES) {
                return { buffer, reduced: attempt > 0 };
            }
        }
        throw new Error("The sticker is too large even at the lowest settings.");
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}


// ---------- One job at a time ----------

let busy = false;

async function exclusive(task) {
    if (busy) {
        const error = new Error("Another sticker is being made.");
        error.code = "BUSY";
        throw error;
    }
    busy = true;
    try {
        return await task();
    } finally {
        busy = false;
    }
}


module.exports = {
    STYLES,
    FRAME_DELAY_MS,
    MAX_BYTES,
    VIDEO_MAX_INPUT_BYTES,
    frameCount,
    frameState,
    framesToWebp,
    slideshowToWebp,
    videoToWebp,
    exclusive
};
