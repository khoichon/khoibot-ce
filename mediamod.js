// checks pictures for the anti-badword settings. images, stickers and video thumbnails
// go to the detoxify api, which looks for explicit content and reads any text in the picture.
// everything here fails open, if the api is down the media just stays.

const crypto = require("node:crypto");
const { downloadMediaMessage, normalizeMessageContent } = require("baileys");
const sharp = require("sharp");
const { isImageBad } = require("./moderation.js");

// the vision models eat a lot of ram, so the api only loads them when BADWORD_VISION is 1
// and the bot only sends pictures when the same switch is on
function enabled() {
    return process.env.BADWORD_VISION === "1";
}

const silentLogger = {
    level: "silent",
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return silentLogger; }
};

// anything bigger than this is not worth downloading just to look at it
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_INPUT_PIXELS = 50 * 1000 * 1000;

// the model is slow on the pi, so only a few pictures are checked at the same time.
// when it is busy the extra ones are let through instead of piling up
const MAX_PENDING = 4;
let pending = 0;

// forwarded or reposted pictures have the same hash, so the answer is remembered for a while
const seen = new Map();
const SEEN_LIMIT = 200;

function remember(hash, verdict) {
    if (!hash) {
        return;
    }
    if (seen.size >= SEEN_LIMIT) {
        seen.delete(seen.keys().next().value);
    }
    seen.set(hash, verdict);
}

// finds the picture inside a message, view once and disappearing messages included.
// videos and gifs already carry a tiny preview picture, so those are not downloaded
function findMedia(msg) {
    const content = normalizeMessageContent(msg.message);
    if (!content) {
        return null;
    }
    const wrapped = { key: msg.key, message: content };

    if (content.imageMessage) {
        return { kind: "image", info: content.imageMessage, wrapped, download: true };
    }
    if (content.stickerMessage) {
        return { kind: "sticker", info: content.stickerMessage, wrapped, download: true };
    }
    if (content.videoMessage && content.videoMessage.jpegThumbnail) {
        return { kind: "video", info: content.videoMessage, wrapped, download: false };
    }
    return null;
}

function hashOf(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function downloadCapped(sock, media) {
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
        if (total > MAX_BYTES) {
            stream.destroy();
            return null;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// returns null when there is nothing to check, otherwise { bad, kind, reason, score, text }
async function checkMessage(sock, msg, threshold = 0.9) {
    const media = findMedia(msg);
    if (!media) {
        return null;
    }

    if (pending >= MAX_PENDING) {
        return null;
    }
    pending++;
    try {
        let raw;
        if (media.download) {
            if (Number(media.info.fileLength) > MAX_BYTES) {
                return null;
            }
            raw = await downloadCapped(sock, media);
            if (!raw) {
                return null;
            }
        } else {
            raw = Buffer.from(media.info.jpegThumbnail);
        }

        const hash = hashOf(raw);
        if (seen.has(hash)) {
            return { ...seen.get(hash), kind: media.kind };
        }

        // one flat jpeg that is not huge, animated stickers turn into their first frame
        const picture = await sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS })
            .rotate()
            .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 85 })
            .toBuffer();

        const result = await isImageBad(picture, threshold);
        const verdict = {
            bad: result.bad,
            reason: result.reason,
            score: result.score,
            text: result.text
        };
        remember(hash, verdict);
        return { ...verdict, kind: media.kind };
    } finally {
        pending--;
    }
}

// finds the picture for !ai describeimage. it is either in the message itself (a picture with the command as its caption)
// or in the message that was replied to. gives back { buffer, kind } as a normal sized jpeg, or null when there is no picturet
async function getPicture(sock, msg, ownOnly) {
    const candidates = [msg];

    const content = normalizeMessageContent(msg.message);
    const context = content && (
        (content.extendedTextMessage && content.extendedTextMessage.contextInfo) ||
        (content.imageMessage && content.imageMessage.contextInfo) ||
        (content.videoMessage && content.videoMessage.contextInfo)
    );
    if (!ownOnly && context && context.quotedMessage) {
        candidates.push({
            key: { remoteJid: msg.key.remoteJid, id: context.stanzaId, participant: context.participant, fromMe: false },
            message: context.quotedMessage
        });
    }

    for (const candidate of candidates) {
        const media = findMedia(candidate);
        // videos only carry a tiny blurry preview, that is not enough to describe anything
        if (!media || !media.download) {
            continue;
        }
        if (Number(media.info.fileLength) > MAX_BYTES) {
            return null;
        }
        const raw = await downloadCapped(sock, media);
        if (!raw) {
            return null;
        }
        const buffer = await sharp(raw, { limitInputPixels: MAX_INPUT_PIXELS })
            .rotate()
            .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 85 })
            .toBuffer();
        return { buffer, kind: media.kind };
    }

    return null;
}

module.exports = { enabled, checkMessage, findMedia, getPicture };
