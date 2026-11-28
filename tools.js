
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { downloadMediaMessage, normalizeMessageContent } = require("baileys");

const { reply } = require("./utils.js");
const { log } = require("./logging.js");

const execFileAsync = promisify(execFile);

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 60 * 1000;
const REMBG_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_GIF_SECONDS = 10;
const MAX_MP3_SECONDS = 600;

const busy = { togif: false, tomp3: false, removebg: false };

class UserError extends Error { }

function toolsEnabled() {
    return process.env.ENABLE_EXTRA_COMMANDS === "1";
}

const silentLogger = {
    level: "silent",
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return silentLogger; }
};


const MEDIA_KINDS = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["stickerMessage", "sticker"],
    ["audioMessage", "audio"]
];

function repliedMedia(msg) {
    const content = normalizeMessageContent(msg.message);
    const context = content?.extendedTextMessage?.contextInfo;
    const quoted = normalizeMessageContent(context?.quotedMessage);
    if (!quoted) {
        return null;
    }

    for (const [key, kind] of MEDIA_KINDS) {
        if (quoted[key]) {
            return {
                kind,
                info: quoted[key],
                wrapped: {
                    key: { remoteJid: msg.key.remoteJid, id: context.stanzaId, participant: context.participant, fromMe: false },
                    message: { [key]: quoted[key] }
                }
            };
        }
    }
    return null;
}

async function download(sock, media) {
    const length = media.info.fileLength;
    const declared = typeof length?.toNumber === "function" ? length.toNumber() : Number(length);
    if (declared > MAX_INPUT_BYTES) {
        throw new UserError("That file is too big (20 MB maximum).");
    }
    const stream = await downloadMediaMessage(
        media.wrapped,
        "stream",
        {},
        { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
    );
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        total += chunk.length;
        if (total > MAX_INPUT_BYTES) {
            stream.destroy();
            throw new UserError("That file is too big (20 MB maximum).");
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function withTempDir(job) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "khoibot-tools-"));
    try {
        return await job(dir);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}

async function runTool(file, args, timeout, missingMessage) {
    try {
        await execFileAsync(file, args, { timeout, maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
        if (error.code === "ENOENT") {
            throw new UserError(missingMessage);
        }
        if (error.killed) {
            throw new UserError("That took too long. Please try a smaller file.");
        }
        if (/does not contain any stream/.test(error.stderr || "")) {
            throw new UserError("There is no sound in that file.");
        }
        throw error;
    }
}

const runFfmpeg = args => runTool("ffmpeg", ["-y", "-loglevel", "error", ...args], FFMPEG_TIMEOUT_MS, "ffmpeg is not installed on the bot's machine.");

async function handleToImage(sock, msg, ctx) {
    const media = repliedMedia(msg);
    if (!media || media.kind !== "sticker") {
        return reply(sock, msg, `Reply to a sticker with ${ctx.commandPrefix}toimage.`);
    }

    const sharp = require("sharp");
    const source = await download(sock, media);
    const image = await sharp(source).png().toBuffer();
    await sock.sendMessage(msg.key.remoteJid, { image }, { quoted: msg });
}

function isAnimatedWebp(buffer) {
    return buffer.length > 21
        && buffer.toString("ascii", 8, 12) === "WEBP"
        && buffer.toString("ascii", 12, 16) === "VP8X"
        && (buffer[20] & 0x02) !== 0;
}

async function handleToGif(sock, msg, ctx) {
    const media = repliedMedia(msg);
    const isSticker = media?.kind === "sticker";
    if (!media || (media.kind !== "video" && !isSticker)) {
        return reply(sock, msg, `Reply to an animated sticker or a video with ${ctx.commandPrefix}togif.`);
    }
    if (busy.togif) {
        return reply(sock, msg, "I am still making another gif. Please wait a moment.");
    }

    busy.togif = true;
    try {
        const source = await download(sock, media);
        const animatedSticker = isSticker && (media.info.isAnimated || isAnimatedWebp(source));
        if (isSticker && !animatedSticker) {
            return reply(sock, msg, "That sticker is not animated.");
        }
        const video = await withTempDir(async dir => {
            const input = path.join(dir, "input");
            const output = path.join(dir, "output.mp4");

            if (animatedSticker) {
                const sharp = require("sharp");
                await fs.promises.writeFile(input, await sharp(source, { animated: true }).gif().toBuffer());
            } else {
                await fs.promises.writeFile(input, source);
            }

            await runFfmpeg([
                "-i", input,
                "-t", String(MAX_GIF_SECONDS),
                "-an",
                "-vf", "scale='trunc(min(480,iw)/2)*2':-2",
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                output
            ]);
            return fs.promises.readFile(output);
        });

        await sock.sendMessage(msg.key.remoteJid, { video, gifPlayback: true }, { quoted: msg });
    } finally {
        busy.togif = false;
    }
}

async function handleToMp3(sock, msg, ctx) {
    const media = repliedMedia(msg);
    if (!media || (media.kind !== "video" && media.kind !== "audio")) {
        return reply(sock, msg, `Reply to a video or a voice note with ${ctx.commandPrefix}tomp3.`);
    }
    if (busy.tomp3) {
        return reply(sock, msg, "I am still converting another file. Please wait a moment.");
    }

    busy.tomp3 = true;
    try {
        const source = await download(sock, media);
        const audio = await withTempDir(async dir => {
            const input = path.join(dir, "input");
            const output = path.join(dir, "output.mp3");
            await fs.promises.writeFile(input, source);
            await runFfmpeg([
                "-i", input,
                "-t", String(MAX_MP3_SECONDS),
                "-vn",
                "-ac", "2",
                "-b:a", "128k",
                output
            ]);
            return fs.promises.readFile(output);
        });

        await sock.sendMessage(msg.key.remoteJid, { audio, mimetype: "audio/mpeg" }, { quoted: msg });
    } finally {
        busy.tomp3 = false;
    }
}

async function handleRemoveBg(sock, msg, ctx) {
    const media = repliedMedia(msg);
    if (!media || (media.kind !== "image" && media.kind !== "sticker")) {
        return reply(sock, msg, `Reply to a picture with ${ctx.commandPrefix}removebg.`);
    }
    if (busy.removebg) {
        return reply(sock, msg, "I am still working on another picture. Please wait a moment.");
    }

    busy.removebg = true;
    try {
        const sharp = require("sharp");
        const source = await download(sock, media);
        const cutout = await withTempDir(async dir => {
            const input = path.join(dir, "input.png");
            const output = path.join(dir, "output.png");
            await sharp(source)
                .rotate()
                .resize({ width: 1500, height: 1500, fit: "inside", withoutEnlargement: true })
                .png()
                .toFile(input);
            await runTool(process.env.REMBG_PATH || "rembg", ["i", input, output], REMBG_TIMEOUT_MS, "rembg is not installed on the bot's machine yet.");
            return fs.promises.readFile(output);
        });

        await sock.sendMessage(
            msg.key.remoteJid,
            { document: cutout, mimetype: "image/png", fileName: "removebg.png" },
            { quoted: msg }
        );
    } finally {
        busy.removebg = false;
    }
}


const COMMANDS = {
    "!toimage": handleToImage,
    "!togif": handleToGif,
    "!tomp3": handleToMp3,
    "!removebg": handleRemoveBg
};

async function handleCommand(sock, msg, ctx) {
    if (!toolsEnabled()) {
        return false;
    }

    const name = ctx.text.trim().split(/\s+/)[0].toLowerCase();
    if (!Object.hasOwn(COMMANDS, name)) {
        return false;
    }

    try {
        await COMMANDS[name](sock, msg, ctx);
    } catch (error) {
        if (error instanceof UserError) {
            await reply(sock, msg, error.message);
        } else {
            log.error("tools", `${name} failed:`, error);
            await reply(sock, msg, "That did not work. The file may have expired, so please send it again.");
        }
    }
    return true;
}

module.exports = { handleCommand };
