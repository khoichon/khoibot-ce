// Extra commands, all behind ENABLE_EXTRA_COMMANDS=1 (off by default).
//
//   !fact  !joke  !define  !wiki  !translate  !quote  !tts  !sticker  !animsticker  !edit  !roast  !compliment
//   !automute  !autounmute  !mute  !unmute  !ban  !unban  !execute  !add !warn !unwarn !warnings
//
// index.js calls init(sock) once per socket and handleCommand() for every
// command, handleCommand() returns true when it used the message.
// The hot potato and the game hints live in games.js with the other games.

const fs = require("node:fs");
const path = require("node:path");
const { downloadMediaMessage } = require("baileys");

const { getText, reply } = require("./utils.js");
const { log } = require("./logging.js");
const aitools = require("./aitools.js");
const animation = require("./animation.js");
const ttsFonts = require("./ttsfonts.js");
const stickerEdit = require("./stickeredit.js");
const { getGroupSetting, isTrusted, getTrusted } = require("./config.js");

// schedules, bans and warnings are kept here instead of in the config doc, so the storage backends dont need to know about them.
const STATE_FILE = path.join(__dirname, "extras-state.json");


function extraCommandsEnabled() {
    return process.env.ENABLE_EXTRA_COMMANDS === "1";
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


// ============================================================
// Saved state
// ============================================================

let state = {
    // { chatId, action: "mute" | "unmute", time: "HH:MM", mode: "once" | "all", lastFired }
    rules: [],
    // { chatId, until } for a timed !mute
    mutes: [],
    // { chatId, ids, until, jid } for a !ban, until is null for a permanent one,
    // jid is who got banned so the bot can tag them when it runs out
    bans: [],
    // { chatId, ids, jid, times } for !warn, times is when each warning was given and jid is who got warned so the bot can tag them
    warns: [],
    // phone numbers added with !special forceban, the ones from FORCE_BANNED in .env arent kept here
    forceBans: []
};

function loadState() {
    try {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        if (saved && typeof saved === "object") {
            if (Array.isArray(saved.rules)) {
                state.rules = saved.rules.filter(rule =>
                    rule &&
                    typeof rule.chatId === "string" &&
                    (rule.action === "mute" || rule.action === "unmute") &&
                    /^\d\d:\d\d$/.test(rule.time) &&
                    (rule.mode === "once" || rule.mode === "all")
                );
            }
            if (Array.isArray(saved.forceBans)) { state.forceBans = [...new Set(saved.forceBans.map(cleanNumber).filter(Boolean))]; }
            if (Array.isArray(saved.mutes)) { state.mutes = saved.mutes.filter(entry => entry && typeof entry.chatId === "string" && typeof entry.until === "number"); }
            if (Array.isArray(saved.bans)) { state.bans = saved.bans.filter(ban => ban && typeof ban.chatId === "string" && Array.isArray(ban.ids) && (ban.until === null || typeof ban.until === "number")); }
if (Array.isArray(saved.warns)) { state.warns = saved.warns.filter(entry => entry && typeof entry.chatId === "string" && typeof entry.jid === "string" && Array.isArray(entry.ids) && Array.isArray(entry.times)); }
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            log.error("extras", "Could not read extras-state.json, starting fresh:", error);
        }
    }
}

// Write to a temp file first so a crash cant leave half a file behind.
function saveState() {
    try {
        const temp = `${STATE_FILE}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(state, null, 4), "utf8");
        fs.renameSync(temp, STATE_FILE);
    } catch (error) {
        log.error("extras", "Could not save extras-state.json:", error);
    }
}

loadState();


// ============================================================
// Small helpers
// ============================================================

async function fetchJson(url, timeoutMs = 7000) {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": "khoibot (whatsapp bot)" }
    });
    if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

// One retry after a second, these are free APIs and they hiccup.
async function fetchJsonWithRetry(url, timeoutMs = 7000) {
    try {
        return await fetchJson(url, timeoutMs);
    } catch (error) {
        if (error.status === 404) {
            throw error;
        }
        await sleep(1000);
        return fetchJson(url, timeoutMs);
    }
}

// Text after the command, or the text of the message being replied to.
function argsOf(text) {
    return text.trim().replace(/^\S+\s*/, "");
}

function quotedText(msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    return quoted ? (getText(quoted) || quoted.imageMessage?.caption || "").trim() : "";
}

const EMOJI_REGEX = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
function stripEmojis(text) {
    return text.replace(EMOJI_REGEX, "").replace(/\s+/g, " ").trim();
}


// ============================================================
// !fact
// ============================================================

async function handleFact(sock, msg) {
    try {
        const data = await fetchJson("https://uselessfacts.jsph.pl/api/v2/facts/random?language=en", 6000);
        await reply(sock, msg, `Fact: ${data.text}`);
        return;
    } catch {
        // fall through to the backup api
    }

    try {
        const data = await fetchJson("https://catfact.ninja/fact", 6000);
        await reply(sock, msg, `Cat fact: ${data.fact}`);
    } catch {
        await reply(sock, msg, "A fact could not be retrieved at this time. Please try again later.");
    }
}


// ============================================================
// !joke
// ============================================================

async function handleJoke(sock, msg) {
    try {
        const data = await fetchJson(
            "https://v2.jokeapi.dev/joke/Any?blacklistFlags=nsfw,racist,sexist&type=twopart",
            6000
        );
        if (data.setup && data.delivery) {
            await reply(sock, msg, `${data.setup}\n\n_${data.delivery}_`);
        } else if (data.joke) {
            await reply(sock, msg, data.joke);
        } else {
            throw new Error("no joke in response");
        }
    } catch {
        await reply(sock, msg, "A joke could not be retrieved at this time. Please try again later.");
    }
}


// the dictionary api only knows base words, so stuff like cats or running comes back as not found
async function defineFromDictionary(word) {
    let data;
    try {
        data = await fetchJson(
            `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
            4000
        );
    } catch (error) {
        if (error.status === 404) {
            return null;
        }
        throw error;
    }

    const entry = data?.[0];
    if (!entry?.meanings?.length) {
        return null;
    }

    const text = entry.meanings.slice(0, 2).map(meaning => {
        const definition = meaning.definitions[0];
        return `_${meaning.partOfSpeech}:_ ${definition.definition}` +
            (definition.example ? `\n_"${definition.example}"_` : "");
    }).join("\n\n");
    return { title: entry.word, text };
}

// wiktionary sends its definitions as html, so strip the tags
function stripHtml(html) {
    return String(html || "")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}

// wiktionary knows the other forms too (it says things like "plural of cat"), so it's the backup
async function defineFromWiktionary(word) {
    let data;
    try {
        data = await fetchJson(
            `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`,
            4000
        );
    } catch (error) {
        if (error.status === 404) {
            return null;
        }
        throw error;
    }

    const parts = (data?.en || []).slice(0, 2).map(part => {
        const definition = stripHtml(part.definitions?.[0]?.definition);
        const example = stripHtml(part.definitions?.[0]?.examples?.[0]);
        if (!definition) {
            return null;
        }
        return `_${String(part.partOfSpeech).toLowerCase()}:_ ${definition}` +
            (example ? `\n_"${example}"_` : "");
    }).filter(Boolean);

    return parts.length ? { title: word, text: parts.join("\n\n") } : null;
}


// resolves with the first lookup that actually found something, or null if none did.
// the promises passed in must never reject
function firstFound(promises) {
    return new Promise(resolve => {
        let left = promises.length;
        for (const promise of promises) {
            promise.then(found => {
                if (found) {
                    resolve(found);
                } else if (--left === 0) {
                    resolve(null);
                }
            });
        }
    });
}


// ============================================================
// !define <word>
// ============================================================

async function handleDefine(sock, msg, { text, commandPrefix }) {
    const word = argsOf(text).toLowerCase();
    if (!word) {
        await reply(sock, msg, `Usage: ${commandPrefix}define <word>`);
        return;
    }

    // ask both at the same time and use whichever finds the word first, so a slow one doesnt hold us up
    const problems = [];
    const lookups = [defineFromDictionary, defineFromWiktionary].map(async lookup => {
        try {
            return await lookup(word);
        } catch (error) {
            problems.push(`${lookup.name}: ${error.message}`);
            return null;
        }
    });
    const found = await firstFound(lookups);

    if (found) {
        await reply(sock, msg, `*${found.title}*\n\n${found.text}`);
    } else if (problems.length === 2) {
        // both of them fell over, which isnt the same as a word that doesnt exist
        log.warn("extras", `neither dictionary could define "${word}":`, problems.join(" / "));
        await reply(sock, msg, "The dictionary couldn't be reached right now. Try again in a bit.");
    } else {
        // one of them answered and didnt know the word, so thats good enough for us
        await reply(sock, msg, `No definition was found for "${word}".`);
    }
}


// ============================================================
// !wiki <query>
// ============================================================

async function handleWiki(sock, msg, { text, commandPrefix }) {
    const query = argsOf(text);
    if (!query) {
        await reply(sock, msg, `Usage: ${commandPrefix}wiki <query>`);
        return;
    }

    try {
        const data = await fetchJsonWithRetry(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`
        );
        await reply(
            sock,
            msg,
            data.extract ? `*${data.title}*\n\n${data.extract}` : "No Wikipedia article found."
        );
    } catch (error) {
        await reply(
            sock,
            msg,
            error.status === 404
                ? `No Wikipedia article was found for "${query}".`
                : "The Wikipedia lookup failed. Please try again later."
        );
    }
}


// ============================================================
// !translate <language> <text>  (or reply to a message with !translate <language>)
// ============================================================

const LANG_ALIASES = Object.freeze({
    english: "en", spanish: "es", french: "fr", german: "de", chinese: "zh-CN",
    japanese: "ja", korean: "ko", russian: "ru", italian: "it", portuguese: "pt"
});

async function handleTranslate(sock, msg, { text, commandPrefix }) {
    const usage = `Usage: ${commandPrefix}translate <language> <text>\nAlternatively, reply to a message with ${commandPrefix}translate <language>.\nThe language may be a name such as French or a code such as fr.`;
    const [language, ...rest] = argsOf(text).split(/\s+/).filter(Boolean);
    if (!language) {
        await reply(sock, msg, usage);
        return;
    }

    const toTranslate = rest.join(" ") || quotedText(msg);
    if (!toTranslate) {
        await reply(sock, msg, usage);
        return;
    }

    try {
        const code = LANG_ALIASES[language.toLowerCase()] || language.toLowerCase();
        const data = await fetchJsonWithRetry(
            `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(code)}&dt=t&q=${encodeURIComponent(toTranslate)}`
        );
        await reply(sock, msg, data[0].map(part => part[0]).join(""));
    } catch {
        await reply(sock, msg, "The translation failed. Please check the language and try again.");
    }
}


// ============================================================
// Stickers
// ============================================================

// WhatsApp wants a 512x512 webp, and static stickers should stay under about 100KB.
async function toStickerBuffer(input) {
    // loaded here so the bot still starts if sharp is not available
    const sharp = require("sharp");
    let quality = 80;
    let output;
    do {
        output = await sharp(input)
            .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .webp({ quality })
            .toBuffer();
        quality -= 20;
    } while (output.length > 100 * 1024 && quality >= 20);
    return output;
}

const silentLogger = {
    level: "silent",
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return silentLogger; }
};

// !sticker and !animsticker work as a reply to an image, or as the caption of an image or video.
// Captions are not text messages, so index.js asks captionText() for them.
function captionText(message) {
    const caption = message?.imageMessage?.caption ?? message?.videoMessage?.caption;
    return typeof caption === "string" && /^!(sticker|animsticker|edit)(\s|$)/i.test(caption.trim())
        ? caption.trim()
        : null;
}

function findImage(msg) {
    const message = msg.message;
    if (message?.imageMessage) {
        return { image: { key: msg.key, message: { imageMessage: message.imageMessage } } };
    }

    const context = message?.extendedTextMessage?.contextInfo;
    const quoted = context?.quotedMessage;
    if (quoted?.imageMessage) {
        return {
            image: {
                key: {
                    remoteJid: msg.key.remoteJid,
                    id: context.stanzaId,
                    participant: context.participant,
                    fromMe: false
                },
                message: { imageMessage: quoted.imageMessage }
            }
        };
    }

    if (message?.videoMessage || quoted?.videoMessage) {
        return { video: true };
    }

    return null;
}

async function handleSticker(sock, msg, { commandPrefix }) {
    const found = findImage(msg);
    if (!found) {
        await reply(sock, msg, `Reply to an image with ${commandPrefix}sticker, or send an image with ${commandPrefix}sticker as its caption.`);
        return;
    }
    if (found.video) {
        await reply(sock, msg, "Only images are supported by this command. For videos and GIFs, use !animsticker.");
        return;
    }

    try {
        const buffer = await downloadMediaMessage(
            found.image,
            "buffer",
            {},
            { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
        );
        const sticker = await toStickerBuffer(buffer);
        await sock.sendMessage(msg.key.remoteJid, { sticker }, { quoted: msg });
    } catch (error) {
        log.error("extras", "Sticker error:", error);
        await reply(sock, msg, "The sticker could not be created. The image may have expired, so please send it again.");
    }
}

// !edit works on an image or a sticker, as a reply or as the caption of an image.
function findEditSource(msg) {
    const message = msg.message;
    if (message?.imageMessage) {
        return { target: { key: msg.key, message: { imageMessage: message.imageMessage } } };
    }

    const context = message?.extendedTextMessage?.contextInfo;
    const quoted = context?.quotedMessage;
    const kind = quoted?.imageMessage ? "imageMessage" : quoted?.stickerMessage ? "stickerMessage" : null;
    if (!kind) {
        return null;
    }
    if (kind === "stickerMessage" && quoted.stickerMessage.isAnimated) {
        return { animated: true };
    }
    return {
        target: {
            key: {
                remoteJid: msg.key.remoteJid,
                id: context.stanzaId,
                participant: context.participant,
                fromMe: false
            },
            message: { [kind]: quoted[kind] }
        }
    };
}

function editUsage(commandPrefix) {
    return [
        `Sticker editor: reply to an image or sticker with ${commandPrefix}edit and an operation. Points are x,y in pixels on a 512x512 sticker, (0,0) is the top left, and several points are joined with ; (no spaces).`,
        `${commandPrefix}edit crop 256,20;480,200;400,490;110,490;30,200  keeps only the inside of the shape`,
        `${commandPrefix}edit cut 150,150;350,150;350,350;150,350  makes the inside of the shape transparent`,
        `${commandPrefix}edit draw 40,40;470,40;470,470 [-clr red] [-fill blue] [-w 4] [-open]  draws a shape (or a line with 2 points)`,
        `${commandPrefix}edit text 256,256 hello [-clr yellow] [-size 64]  writes text centered on the point`,
        `${commandPrefix}edit grid [step]  sends the picture with a coordinate grid so you can find your points`,
        `Chain operations with |, they run from left to right, for example: ${commandPrefix}edit crop 10,10;500,10;250,500 | text 256,470 hi`
    ].join("\n");
}

async function handleEdit(sock, msg, { text, commandPrefix }) {
    const parsed = stickerEdit.parse(argsOf(text));
    if (parsed.error === "empty") {
        await reply(sock, msg, editUsage(commandPrefix));
        return;
    }
    if (parsed.error) {
        await reply(sock, msg, `${parsed.error}\n\nSend ${commandPrefix}edit on its own to see how it works.`);
        return;
    }

    const source = findEditSource(msg);
    if (!source) {
        await reply(sock, msg, `Reply to an image or a sticker with ${commandPrefix}edit, or send an image with ${commandPrefix}edit as its caption.`);
        return;
    }
    if (source.animated) {
        await reply(sock, msg, "Animated stickers can't be edited. Reply to a normal sticker or an image.");
        return;
    }

    try {
        const buffer = await downloadMediaMessage(
            source.target,
            "buffer",
            {},
            { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
        );
        const [operation] = parsed.operations;
        if (operation.type === "grid") {
            const image = await stickerEdit.renderGrid(buffer, operation.step);
            await sock.sendMessage(
                msg.key.remoteJid,
                { image, caption: `Grid every ${operation.step} pixels. Points are x,y from the top left, on a ${stickerEdit.SIZE}x${stickerEdit.SIZE} sticker.` },
                { quoted: msg }
            );
            return;
        }
        const sticker = await stickerEdit.toSticker(await stickerEdit.render(buffer, parsed.operations));
        await sock.sendMessage(msg.key.remoteJid, { sticker }, { quoted: msg });
    } catch (error) {
        log.error("extras", "Sticker edit error:", error);
        await reply(sock, msg, "The sticker could not be edited. The image may have expired, so please send it again.");
    }
}


// ============================================================
// !animsticker
// A video or GIF becomes an animated sticker (reply to it, or send it with the
// command as the caption). Images can be combined into a slideshow:
//   !animsticker add   (on each image or sticker, 2 to 8)  then  !animsticker done
// Animated text stickers are made with !tts <text> -anim <style>.
// ============================================================

const SLIDESHOW_MAX_IMAGES = 8;
const SLIDESHOW_TTL_MS = 3 * 60 * 1000;
const slideshows = new Map();

// The image or video the message carries or replies to.
function findMedia(msg) {
    const message = msg.message;
    const direct = message?.imageMessage ? "image" : message?.videoMessage ? "video" : null;
    if (direct) {
        const key = direct === "image" ? "imageMessage" : "videoMessage";
        return { kind: direct, size: Number(message[key].fileLength || 0), source: { key: msg.key, message: { [key]: message[key] } } };
    }

    const context = message?.extendedTextMessage?.contextInfo;
    const quoted = context?.quotedMessage;
    // a sticker has no caption, so it only counts when you reply to it
    const quotedKind = quoted?.imageMessage ? "image" : quoted?.videoMessage ? "video" : quoted?.stickerMessage ? "sticker" : null;
    if (quotedKind) {
        const key = quotedKind === "image" ? "imageMessage" : quotedKind === "video" ? "videoMessage" : "stickerMessage";
        return {
            kind: quotedKind,
            size: Number(quoted[key].fileLength || 0),
            source: {
                key: {
                    remoteJid: msg.key.remoteJid,
                    id: context.stanzaId,
                    participant: context.participant,
                    fromMe: false
                },
                message: { [key]: quoted[key] }
            }
        };
    }

    return null;
}

function download(sock, media) {
    return downloadMediaMessage(
        media.source,
        "buffer",
        {},
        { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
    );
}

async function sendAnimated(sock, msg, sticker) {
    await sock.sendMessage(msg.key.remoteJid, { sticker, isAnimated: true }, { quoted: msg });
}

async function handleAnimSticker(sock, msg, { text, commandPrefix }) {
    const usage = [
        `Videos and GIFs: reply to one with ${commandPrefix}animsticker, or send it with ${commandPrefix}animsticker as the caption.`,
        `Slideshow: use ${commandPrefix}animsticker add on 2 to ${SLIDESHOW_MAX_IMAGES} images or stickers (reply to each, or send an image with it as the caption), then ${commandPrefix}animsticker done. Use ${commandPrefix}animsticker cancel to start over.`,
        `Animated text: ${commandPrefix}tts <text> -anim <${animation.STYLES.join("|")}>`
    ].join("\n");

    const action = argsOf(text).split(/\s+/)[0].toLowerCase();
    const sessionKey = `${msg.key.remoteJid}|${msg.key.participant || msg.key.remoteJid}`;

    try {
        if (action === "cancel") {
            slideshows.delete(sessionKey);
            await reply(sock, msg, "The slideshow was cleared.");
            return;
        }

        if (action === "done") {
            const session = slideshows.get(sessionKey);
            if (!session || session.expires < Date.now() || session.images.length < 2) {
                slideshows.delete(sessionKey);
                await reply(sock, msg, `Add at least 2 images first with ${commandPrefix}animsticker add.`);
                return;
            }
            slideshows.delete(sessionKey);
            const sticker = await animation.exclusive(() => animation.slideshowToWebp(session.images));
            await sendAnimated(sock, msg, sticker);
            return;
        }

        const media = findMedia(msg);

        if (action === "add") {
            if (!media || (media.kind !== "image" && media.kind !== "sticker")) {
                await reply(sock, msg, `Reply to an image or a sticker with ${commandPrefix}animsticker add, or send an image with it as the caption.`);
                return;
            }
            let session = slideshows.get(sessionKey);
            if (!session || session.expires < Date.now()) {
                session = { images: [] };
            }
            if (session.images.length >= SLIDESHOW_MAX_IMAGES) {
                await reply(sock, msg, `A slideshow can have at most ${SLIDESHOW_MAX_IMAGES} images. Use ${commandPrefix}animsticker done.`);
                return;
            }
            session.images.push(await download(sock, media));
            session.expires = Date.now() + SLIDESHOW_TTL_MS;
            slideshows.set(sessionKey, session);
            await reply(sock, msg, `Added image ${session.images.length} of ${SLIDESHOW_MAX_IMAGES}. Use ${commandPrefix}animsticker done when you are finished.`);
            return;
        }

        if (!media) {
            await reply(sock, msg, usage);
            return;
        }
        if (media.kind === "sticker") {
            await reply(sock, msg, `That is already a sticker. To combine stickers into a slideshow, use ${commandPrefix}animsticker add on each of them.`);
            return;
        }

        if (media.kind === "image") {
            await reply(sock, msg, `For a single image use ${commandPrefix}sticker. To combine images, use ${commandPrefix}animsticker add on each of them.`);
            return;
        }
        if (media.size > animation.VIDEO_MAX_INPUT_BYTES) {
            await reply(sock, msg, "The video is too large (20 MB maximum).");
            return;
        }

        const { buffer, reduced } = await animation.exclusive(async () => animation.videoToWebp(await download(sock, media)));
        await sendAnimated(sock, msg, buffer);
        if (reduced) {
            await reply(sock, msg, "The video was shortened and its quality lowered so that it fits in a sticker.");
        }
    } catch (error) {
        if (error.code === "BUSY") {
            await reply(sock, msg, "Another sticker is being made. Please try again in a moment.");
        } else if (error.code === "NO_FFMPEG") {
            log.error("extras", "ffmpeg is not installed:", error.message);
            await reply(sock, msg, "Videos cannot be converted because ffmpeg is not installed on the bot's machine.");
        } else if (error.code === "TOO_LARGE") {
            await reply(sock, msg, "The video is too large (20 MB maximum).");
        } else {
            log.error("extras", "Animated sticker error:", error);
            await reply(sock, msg, "The animated sticker could not be created. The file may have expired or be too large, so please send it again.");
        }
    }
}


// ============================================================
// !quote
// ============================================================

const QUOTE_MAX_LENGTH = 1000;

// Quote a replied-to message and mention its author, or quote the text given
// after the command and mention whoever sent the command.
async function handleQuote(sock, msg, { text, commandPrefix }) {
    const context = msg.message?.extendedTextMessage?.contextInfo;
    const replied = quotedText(msg);
    const given = argsOf(text);

    let body;
    let who;
    let label;
    if (context?.quotedMessage && !given) {
        if (!replied) {
            await reply(sock, msg, "The selected message contains no text to quote.");
            return;
        }
        body = replied;
        who = context.participant;
        label = "Quoted from";
    } else if (given) {
        body = given;
        who = msg.key.participant || msg.key.remoteJid;
        label = "Quoted by";
    } else {
        await reply(sock, msg, `Usage: ${commandPrefix}quote <text>, or reply to a message with ${commandPrefix}quote.`);
        return;
    }

    if (body.length > QUOTE_MAX_LENGTH) {
        body = `${body.slice(0, QUOTE_MAX_LENGTH)}…`;
    }
    // Every line needs its own marker or WhatsApp only quotes the first one.
    const quoted = body.split(/\r?\n/).map(line => `> ${line}`).join("\n");

    const mention = who ? `@${who.split("@")[0].split(":")[0]}` : null;
    await sock.sendMessage(
        msg.key.remoteJid,
        {
            text: mention ? `${quoted}\n\n${label} ${mention}` : quoted,
            mentions: who ? [who] : []
        }
    );
}


// ============================================================
// !tts [font] <text> [-bg <color>] [-clr <color>] [-size <number>]
// Draws the text on a 512x512 image and sends it as a sticker.
// The fonts have to be installed on the machine running the bot, if one is
// missing the system falls back to a default font.
// ============================================================

const FONTS = {
    sans: "sans-serif",
    serif: "serif",
    mono: "monospace",
    cursive: '"Z003", cursive',
    fantasy: '"The Whisker", fantasy',

    dejavu: '"DejaVu Sans", sans-serif',
    liberation: '"Liberation Sans", sans-serif',
    arial: '"Arial", "Liberation Sans", sans-serif',
    arialblack: '"Arial Black", "Arial", sans-serif',
    nimbus: '"Nimbus Sans", sans-serif',
    freesans: '"FreeSans", sans-serif',
    nunito: '"Nunito Sans", sans-serif',
    cantarell: '"Cantarell", sans-serif',
    verdana: '"Verdana", sans-serif',
    trebuchet: '"Trebuchet MS", sans-serif',
    ubuntu: '"Ubuntu", sans-serif',

    dejavuserif: '"DejaVu Serif", serif',
    liberationserif: '"Liberation Serif", serif',
    times: '"Times New Roman", "Liberation Serif", serif',
    georgia: '"Georgia", "DejaVu Serif", serif',
    nimbusroman: '"Nimbus Roman", serif',
    freeserif: '"FreeSerif", serif',
    palatino: '"P052", serif',
    schoolbook: '"C059", serif',
    caladea: '"Caladea", serif',
    bookman: '"URW Bookman", serif',

    dejavumono: '"DejaVu Sans Mono", monospace',
    libmono: '"Liberation Mono", monospace',
    courier: '"Liberation Mono", monospace',
    nimbusmono: '"Nimbus Mono PS", monospace',
    freemono: '"FreeMono", monospace',
    notomono: '"Noto Mono", monospace',

    bebas: '"Bebas Neue", sans-serif',
    caveat: '"Caveat", cursive',
    pacifico: '"Pacifico", cursive',
    comic: '"Comic Sans MS", "Comic Neue", cursive',
    impact: '"Impact", sans-serif',
    chancery: '"Z003", cursive',
    gothic: '"URW Gothic", sans-serif',
    didot: '"GFS Didot Classic", serif',

    // Variable fonts. Use -var to set their axes, for example -var MORF=30.
    kablammo: '"Kablammo", cursive',
    bitcountink: '"Bitcount Ink", sans-serif',
    gsflex: '"Google Sans Flex", sans-serif',

    webdings: '"Webdings"',
    dingbats: '"D050000L"',
    symbols: '"Standard Symbols PS"'
};

// The font names of one entry of FONTS, for example ["DejaVu Sans", "sans-serif"].
function fontFamilies(key) {
    return FONTS[key].split(",").map(name => name.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

// Roughly how wide a character is compared to the font size, used to wrap lines.
const WIDTH_RATIO = {
    impact: 0.55, bebas: 0.52, mono: 0.62, dejavumono: 0.62, libmono: 0.62,
    courier: 0.62, nimbusmono: 0.62, freemono: 0.62, notomono: 0.62,
    comic: 0.85, arialblack: 0.85, caveat: 0.9, pacifico: 0.85, chancery: 0.85,
    webdings: 1.0, dingbats: 1.0, symbols: 1.0, didot: 0.8, gothic: 0.78,
    fantasy: 0.85, cursive: 0.8, bookman: 0.78, kablammo: 0.85, bitcountink: 0.8
};

const NAMED_COLORS = new Set([
    "black", "white", "red", "green", "blue", "yellow", "purple", "orange", "pink",
    "gray", "grey", "cyan", "magenta", "lime", "navy", "maroon", "teal", "gold", "silver", "brown"
]);

function normalizeColor(raw) {
    if (!raw) return null;
    let color = raw.trim().toLowerCase();
    if (NAMED_COLORS.has(color)) return color;
    color = color.replace(/^&?#/, "");
    return /^([0-9a-f]{3}|[0-9a-f]{6})$/.test(color) ? `#${color}` : null;
}

// One color is a solid fill, two colors with a comma between them is a gradient.
function parseColorSpec(raw) {
    if (!raw) return null;
    const colors = raw.split(",").map(normalizeColor);
    if (colors.some(color => !color) || colors.length > 2) return null;
    return { type: colors.length === 2 ? "gradient" : "solid", colors };
}

function escapeXml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrapText(text, fontSize, ratio, maxWidth) {
    const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * ratio)));
    const lines = [];
    let current = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
        if (current && (current + " " + word).length > maxChars) {
            lines.push(current);
            current = word;
        } else {
            current = current ? `${current} ${word}` : word;
        }
    }
    if (current) lines.push(current);
    return lines;
}

async function handleTts(sock, msg, { text, commandPrefix }) {
    const usage = [
        `Usage: ${commandPrefix}tts [font] <text> [-bg <color>] [-clr <color>] [-size <number>] [-anim <style>] [-var <axis=value,...>]`,
        `Alternatively, reply to a message with ${commandPrefix}tts.`,
        "Colors may be a hex code such as #112233, a basic color name such as red, or two colors separated by a comma for a gradient (red,blue).",
        `Include &#rrggbb within the text to change the color from that point onward.\nAvailable fonts: ${Object.keys(FONTS).join(", ")}\nAnimations (-anim): ${animation.STYLES.join(", ")}\nVariable fonts (kablammo, bitcountink) take -var with axis=value pairs, for example -var wght=700,MORF=30.`
    ].join("\n");

    let working = argsOf(text);
    let background = { type: "solid", colors: ["#000000"] };
    let foreground = { type: "solid", colors: ["#ffffff"] };
    let manualSize = null;

    const bgMatch = working.match(/-bg\s+(\S+)/i);
    if (bgMatch) {
        const spec = parseColorSpec(bgMatch[1]);
        if (!spec) {
            await reply(sock, msg, `"${bgMatch[1]}" is not a valid -bg color. Use a hex code, a basic color name, or two colors separated by a comma.`);
            return;
        }
        background = spec;
        working = working.replace(bgMatch[0], " ");
    }

    const clrMatch = working.match(/-clr\s+(\S+)/i);
    if (clrMatch) {
        const spec = parseColorSpec(clrMatch[1]);
        if (!spec) {
            await reply(sock, msg, `"${clrMatch[1]}" is not a valid -clr color. Use a hex code, a basic color name, or two colors separated by a comma.`);
            return;
        }
        foreground = spec;
        working = working.replace(clrMatch[0], " ");
    }

    let animStyle = null;
    const animMatch = working.match(/-anim\s+(\S+)/i);
    if (animMatch) {
        animStyle = animMatch[1].toLowerCase();
        if (!animation.STYLES.includes(animStyle)) {
            await reply(sock, msg, `"${animMatch[1]}" is not an animation. Available animations: ${animation.STYLES.join(", ")}`);
            return;
        }
        working = working.replace(animMatch[0], " ");
    }

    const sizeMatch = working.match(/-size\s+(\d+)/i);
    if (sizeMatch) {
        manualSize = Math.max(8, Math.min(200, Number(sizeMatch[1])));
        working = working.replace(sizeMatch[0], " ");
    }

    // Variable font axes, written as four character names with numbers: -var wght=700,MORF=30
    const variationAxes = {};
    const varMatch = working.match(/-var\s+(\S+)/i);
    if (varMatch) {
        const pairs = varMatch[1].split(",");
        for (const pair of pairs) {
            const axis = pair.match(/^([A-Za-z0-9]{4})=(-?\d+(?:\.\d+)?)$/);
            if (!axis || pairs.length > 8) {
                await reply(sock, msg, `"${varMatch[1]}" is not a valid -var value. Use up to 8 axis=value pairs separated by commas, such as wght=700,MORF=30.`);
                return;
            }
            variationAxes[axis[1]] = Number(axis[2]);
        }
        working = working.replace(varMatch[0], " ");
    }

    working = working.replace(/\s+/g, " ").trim();

    let fontKey = "sans";
    let ttsText = working;
    const firstWord = working.split(/\s+/)[0]?.toLowerCase();
    if (firstWord && Object.hasOwn(FONTS, firstWord)) {
        fontKey = firstWord;
        ttsText = working.split(/\s+/).slice(1).join(" ");
    }

    if (!ttsText) {
        ttsText = stripEmojis(quotedText(msg));
    }
    if (!ttsText) {
        await reply(sock, msg, usage);
        return;
    }
    if (ttsText.length > 500) {
        await reply(sock, msg, "The text is too long for a sticker (500 characters maximum).");
        return;
    }

    // Emojis cant be drawn, and everything is one line of single spaces so the
    // wrapping below lines up with the colors.
    ttsText = ttsText.replace(EMOJI_REGEX, "").replace(/\s+/g, " ").trim();
    if (!ttsText) {
        await reply(sock, msg, "There is no text to draw once emojis are removed.");
        return;
    }

    // &#rrggbb markers color everything after them, so build one color per character.
    let coloredChars = null;
    if (/&#[0-9a-fA-F]{6}/.test(ttsText)) {
        let current = foreground.type === "solid" ? foreground.colors[0] : "#ffffff";
        const chars = [];
        const colors = [];
        for (const part of ttsText.split(/(&#[0-9a-fA-F]{6})/g).filter(Boolean)) {
            const marker = part.match(/^&#([0-9a-fA-F]{6})$/);
            if (marker) {
                current = `#${marker[1]}`;
                continue;
            }
            for (const char of part) {
                // dropping the marker can leave two spaces next to each other
                if (char === " " && (!chars.length || chars[chars.length - 1] === " ")) {
                    continue;
                }
                chars.push(char);
                // one color per UTF-16 unit, since the lines are cut by string length
                for (let unit = 0; unit < char.length; unit += 1) {
                    colors.push(current);
                }
            }
        }
        if (chars[chars.length - 1] === " ") {
            chars.pop();
            colors.pop();
        }
        ttsText = chars.join("");
        coloredChars = colors;
        if (!ttsText) {
            await reply(sock, msg, "The message contains only color codes and no text.");
            return;
        }
    }

    try {
        const CANVAS = 512;
        const PADDING = 30;
        const maxWidth = CANVAS - PADDING * 2;
        const maxHeight = CANVAS - PADDING * 2;
        const ratio = WIDTH_RATIO[fontKey] ?? 0.72;

        // Start big and shrink until it fits, unless the user picked a size.
        let fontSize;
        let lines;
        if (manualSize) {
            fontSize = manualSize;
            lines = wrapText(ttsText, fontSize, ratio, maxWidth);
        } else {
            const longest = Math.max(...ttsText.split(/\s+/).filter(Boolean).map(word => word.length), 1);
            fontSize = 160;
            for (; fontSize >= 14; fontSize -= 2) {
                lines = wrapText(ttsText, fontSize, ratio, maxWidth);
                if (fontSize * 1.2 * lines.length <= maxHeight && longest * fontSize * ratio <= maxWidth) {
                    break;
                }
            }
            fontSize = Math.max(10, Math.floor(fontSize * 0.9));
        }

        // Draw the letters from the font file when possible, which is what makes
        // variable font axes work. Otherwise the text is drawn as normal SVG text.
        let glyphLines = null;
        const loaded = ttsFonts.load(fontFamilies(fontKey), variationAxes, true);
        if (loaded) {
            glyphLines = lines.map(line => ttsFonts.layout(loaded, line));
            if (!manualSize) {
                // The estimate above can be a bit off, so shrink the text if a line is too wide.
                const widest = Math.max(...glyphLines.map(line => line.width)) * fontSize;
                if (widest > maxWidth) {
                    fontSize = Math.max(10, Math.floor((fontSize * maxWidth) / widest));
                }
            }
        }

        const lineHeight = fontSize * 1.2;
        const startY = 256 - (lineHeight * lines.length) / 2 + fontSize * 0.8;

        if (glyphLines) {
            glyphLines.forEach((drawn, index) => {
                const left = 256 - (drawn.width * fontSize) / 2;
                const baseline = startY + index * lineHeight;
                for (const glyph of drawn.glyphs) {
                    glyph.shape = ttsFonts.bake(glyph, fontSize, left + glyph.x * fontSize, baseline - glyph.y * fontSize);
                }
            });
        }

        // Lines only break at spaces, so a cursor over the colors works if it skips one char per space.
        let lineColors = null;
        if (coloredChars) {
            lineColors = [];
            let cursor = 0;
            for (const line of lines) {
                lineColors.push(coloredChars.slice(cursor, cursor + line.length));
                cursor += line.length + 1;
            }
        }

        let defs = "";
        const resolveFill = (spec, id) => {
            if (spec.type === "solid") return spec.colors[0];
            defs += `<linearGradient id="${id}" x1="0%" y1="0%" x2="100%" y2="100%">` +
                `<stop offset="0%" stop-color="${spec.colors[0]}"/>` +
                `<stop offset="100%" stop-color="${spec.colors[1]}"/></linearGradient>`;
            return `url(#${id})`;
        };
        const backgroundFill = resolveFill(background, "bgGrad");
        let textFill = null;
        if (!coloredChars) {
            if (glyphLines && foreground.type === "gradient") {
                // Letters are separate shapes, so the gradient has to cover the whole text block.
                const half = (Math.max(...glyphLines.map(line => line.width)) * fontSize) / 2;
                defs += `<linearGradient id="clrGrad" gradientUnits="userSpaceOnUse" x1="${(256 - half).toFixed(1)}" y1="${(startY - fontSize * 0.8).toFixed(1)}" x2="${(256 + half).toFixed(1)}" y2="${(startY + (lines.length - 1) * lineHeight + fontSize * 0.25).toFixed(1)}">` +
                    `<stop offset="0%" stop-color="${foreground.colors[0]}"/>` +
                    `<stop offset="100%" stop-color="${foreground.colors[1]}"/></linearGradient>`;
                textFill = "url(#clrGrad)";
            } else {
                textFill = resolveFill(foreground, "clrGrad");
            }
        }

        const spans = (line, colors) => {
            let out = "";
            let start = 0;
            while (start < line.length) {
                let end = start;
                while (end < line.length && colors[end] === colors[start]) end += 1;
                out += `<tspan fill="${colors[start]}">${escapeXml(line.slice(start, end))}</tspan>`;
                start = end;
            }
            return out;
        };

        // The text for one frame. frame is null for a normal sticker.
        const drawText = (frame, fillOverride) => {
            const perCharacter = Boolean(frame && (frame.dy || frame.visible));
            let offset = 0;
            const elements = lines.map((line, index) => {
                if (glyphLines) {
                    // One shape per letter, placed from the font's own measurements.
                    const drawn = glyphLines[index];
                    const shapes = drawn.glyphs.map(glyph => {
                        const position = offset + glyph.column;
                        const dy = frame?.dy ? frame.dy(position) : 0;
                        const hidden = frame?.visible && !frame.visible(position) ? ' fill-opacity="0"' : "";
                        const fill = fillOverride || (lineColors ? lineColors[index][glyph.column] : textFill);
                        const shape = `<path d="${glyph.shape}" fill="${fill}"${hidden}/>`;
                        return dy ? `<g transform="translate(0 ${dy.toFixed(2)})">${shape}</g>` : shape;
                    }).join("");
                    offset += line.length + 1;
                    return shapes;
                }
                let content;
                if (perCharacter && !fillOverride) {
                    // One tspan per character, each moved relative to the one before it.
                    let previousDy = 0;
                    content = "";
                    for (let column = 0; column < line.length;) {
                        const character = String.fromCodePoint(line.codePointAt(column));
                        const position = offset + column;
                        const dy = frame.dy ? frame.dy(position) : 0;
                        const color = lineColors ? ` fill="${lineColors[index][column]}"` : "";
                        const hidden = frame.visible && !frame.visible(position) ? ' fill-opacity="0"' : "";
                        content += `<tspan dy="${(dy - previousDy).toFixed(2)}"${color}${hidden}>${escapeXml(character)}</tspan>`;
                        previousDy = dy;
                        column += character.length;
                    }
                } else {
                    content = lineColors && !fillOverride ? spans(line, lineColors[index]) : escapeXml(line);
                }
                offset += line.length + 1;
                const fill = fillOverride ? ` fill="${fillOverride}"` : lineColors ? "" : ` fill="${textFill}"`;
                return `<text x="256" y="${startY + index * lineHeight}" font-family='${FONTS[fontKey]}' font-size="${fontSize}" font-weight="bold"${fill} text-anchor="middle"${frame ? ' xml:space="preserve"' : ""}>${content}</text>`;
            }).join("\n");
            return elements;
        };

        const drawFrame = frame => {
            let extraDefs = "";
            let body = drawText(frame);

            if (frame?.transform) {
                body = `<g transform="${frame.transform}">${body}</g>`;
            } else if (frame?.blur) {
                extraDefs = `<filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${frame.blur.toFixed(2)}" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
                body = `<g filter="url(#glow)">${body}</g>`;
            } else if (frame?.appear) {
                const { scale, blur, opacity } = frame.appear;
                if (blur > 0.05) {
                    extraDefs = `<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${blur.toFixed(2)}"/></filter>`;
                }
                body = `<g opacity="${opacity.toFixed(3)}"${blur > 0.05 ? ' filter="url(#soft)"' : ""} transform="translate(256 256) scale(${scale.toFixed(3)}) translate(-256 -256)">${body}</g>`;
            } else if (frame?.glitch) {
                const { offset, bandY, bandHeight, bandShift } = frame.glitch;
                extraDefs = `<clipPath id="band"><rect x="0" y="${bandY.toFixed(1)}" width="512" height="${bandHeight.toFixed(1)}"/></clipPath>`;
                body = `<g opacity="0.8" transform="translate(${offset.toFixed(1)} 0)">${drawText(null, "#ff0044")}</g>` +
                    `<g opacity="0.8" transform="translate(${(-offset).toFixed(1)} 0)">${drawText(null, "#00e5ff")}</g>` +
                    body +
                    `<g clip-path="url(#band)" transform="translate(${bandShift.toFixed(1)} 0)">${body}</g>`;
            }

            return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">` +
                `<defs>${defs}${extraDefs}</defs><rect width="512" height="512" fill="${backgroundFill}"/>${body}</svg>`;
        };

        if (animStyle) {
            const sticker = await animation.exclusive(async () => {
                const sharp = require("sharp");
                const count = animation.frameCount(animStyle, ttsText.length);
                const frames = [];
                for (let index = 0; index < count; index += 1) {
                    const frame = animation.frameState(animStyle, index, count, ttsText.length);
                    frames.push(await sharp(Buffer.from(drawFrame(frame))).png().toBuffer());
                }
                return animation.framesToWebp(frames, animation.FRAME_DELAY_MS);
            });
            await sock.sendMessage(msg.key.remoteJid, { sticker, isAnimated: true }, { quoted: msg });
            return;
        }

        const sticker = await toStickerBuffer(Buffer.from(drawFrame(null)));
        await sock.sendMessage(msg.key.remoteJid, { sticker }, { quoted: msg });
    } catch (error) {
        if (error.code === "BUSY") {
            await reply(sock, msg, "Another sticker is being made. Please try again in a moment.");
            return;
        }
        log.error("extras", "TTS error:", error);
        await reply(sock, msg, "The sticker could not be created. Please check the colors and font and try again.");
    }
}


// ============================================================
// !automute / !autounmute <once|all> <HH:MM>
// Mutes or unmutes a group on a schedule. "Mute" means only admins can send
// messages (the bot has to be a group admin to change that).
// Times use EXTRA_TIMEZONE, which is Asia/Singapore unless you change it.
// ============================================================

function timeZone() {
    const zone = process.env.EXTRA_TIMEZONE || "Asia/Singapore";
    try {
        new Intl.DateTimeFormat("en-CA", { timeZone: zone });
        return zone;
    } catch {
        return "Asia/Singapore";
    }
}

function nowParts() {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timeZone(),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).formatToParts(new Date());
    const get = type => parts.find(part => part.type === type).value;
    return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        time: `${get("hour")}:${get("minute")}`
    };
}

function describeRule(rule) {
    return `${rule.action} at ${rule.time} (${rule.mode === "once" ? "once" : "daily"})`;
}

async function handleAutoMute(sock, msg, { chatId, text, isGroup, trusted, groupAdmin, commandPrefix }) {
    const action = text.trim().split(/\s+/)[0].toLowerCase() === "!automute" ? "mute" : "unmute";
    const command = `${commandPrefix}auto${action}`;

    if (!isGroup) {
        await reply(sock, msg, "This command can only be used in a group.");
        return;
    }
    if (!trusted && !groupAdmin) {
        await reply(sock, msg, "Only group administrators and trusted users may use this command.");
        return;
    }

    const [modeArg, timeArg] = argsOf(text).split(/\s+/).filter(Boolean);
    const mode = (modeArg || "").toLowerCase();
    const mine = state.rules.find(rule => rule.chatId === chatId && rule.action === action);

    // No arguments shows what is scheduled for this group.
    if (!mode) {
        const lines = state.rules
            .filter(rule => rule.chatId === chatId)
            .map(rule => `Scheduled ${describeRule(rule)}`);
        await reply(
            sock,
            msg,
            (lines.length ? lines.join("\n") : "No schedule is set for this group.") +
            `\n\nUsage: ${command} <once|all> <HH:MM> or ${command} off\nTimes use the 24-hour format in ${timeZone()} time.`
        );
        return;
    }

    if (["off", "cancel", "remove", "none"].includes(mode)) {
        if (!mine) {
            await reply(sock, msg, `No ${action} is scheduled for this group.`);
            return;
        }
        state.rules = state.rules.filter(rule => rule !== mine);
        saveState();
        await reply(sock, msg, `The scheduled ${action} has been cancelled.`);
        return;
    }

    const timeMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeArg || "");
    if (!["once", "all"].includes(mode) || !timeMatch) {
        await reply(sock, msg, `Usage: ${command} <once|all> <HH:MM> or ${command} off\nTimes use the 24-hour format, for example 22:00 (${timeZone()} time).`);
        return;
    }

    const time = `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`;
    const rule = { chatId, action, time, mode, lastFired: null };
    // Setting it again replaces the old one instead of stacking.
    state.rules = state.rules.filter(existing => existing !== mine);
    state.rules.push(rule);
    saveState();
    await reply(sock, msg, `The group will be ${action}d at ${time} (${mode === "once" ? "once" : "daily"}). The bot must be a group administrator for this to work.`);
}

let liveSock = null;
let schedulerStarted = false;
let schedulerRunning = false;

async function runRules() {
    if (!liveSock || schedulerRunning || !state.rules.length) {
        return;
    }

    schedulerRunning = true;
    try {
        const { date, time } = nowParts();
        for (const rule of [...state.rules]) {
            if (rule.time !== time || rule.lastFired === date) {
                continue;
            }

            rule.lastFired = date;
            if (rule.mode === "once") {
                state.rules = state.rules.filter(existing => existing !== rule);
            }
            saveState();

            const muting = rule.action === "mute";
            try {
                await liveSock.groupSettingUpdate(rule.chatId, muting ? "announcement" : "not_announcement");
                await liveSock.sendMessage(rule.chatId, {
                    text: muting
                        ? "The group has been muted. Only administrators can send messages. (scheduled)"
                        : "The group has been unmuted. All members can send messages. (scheduled)"
                });
            } catch (error) {
                log.error("extras", `Scheduled ${rule.action} failed for ${rule.chatId}:`, error);
                try {
                    await liveSock.sendMessage(rule.chatId, {
                        text: `The scheduled ${rule.action} could not be applied. The bot must be a group administrator to do this.`
                    });
                } catch {
                    // nothing else to try
                }
            }
        }
    } finally {
        schedulerRunning = false;
    }
}


// ============================================================
// Called from index.js
// ============================================================

// Call this right after the socket is created (it is recreated on reconnect).
function init(sock) {
    if (!extraCommandsEnabled()) {
        return;
    }

    liveSock = sock;

    if (!schedulerStarted) {
        schedulerStarted = true;
        const timer = setInterval(() => {
            runRules().catch(error => log.error("extras", "Schedule check failed:", error));
            runMutes().catch(error => log.error("extras", "Mute check failed:", error));
            purgeBans().catch(error => log.error("extras", "Ban check failed:", error));
        }, 15 * 1000);
        timer.unref?.();
    }
}

// !mute / !unmute
// !mute on its own mutes the group for good. !mute 2h, !mute 120min or
// !mute 1h30min mutes it for that long and unmutes it again by itself.
// muting here is the same as !automute: only admins can send messages, so the
// bot has to be an admin to change it.
// ============================================================

const MIN_MUTE_MS = 60 * 1000;
const MAX_MUTE_MS = 30 * 24 * 60 * 60 * 1000;

// turns "2h", "120min" or "1h30min" into milliseconds. anything that isn't a
// clean run of number + unit pairs gives back null
function parseDuration(input) {
    const unit = "(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)";
    const cleaned = String(input).toLowerCase().replace(/\s+/g, "");
    if (!new RegExp(`^(?:\\d+(?:\\.\\d+)?${unit})+$`).test(cleaned)) {
        return null;
    }

    let total = 0;
    for (const [, amount, name] of cleaned.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)(${unit})`, "g"))) {
        if (name.startsWith("d")) {
            total += Number(amount) * 24 * 60 * 60 * 1000;
        } else if (name.startsWith("h")) {
            total += Number(amount) * 60 * 60 * 1000;
        } else {
            total += Number(amount) * 60 * 1000;
        }
    }
    return Math.round(total);
}

// 150 minutes comes out as "2h 30min"
function describeDuration(ms) {
    const totalMinutes = Math.max(1, Math.round(ms / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}min`].filter(Boolean).join(" ");
}

async function handleMute(sock, msg, { chatId, text, isGroup, trusted, groupAdmin, commandPrefix }) {
    const muting = text.trim().split(/\s+/)[0].toLowerCase() === "!mute";

    if (!isGroup) {
        await reply(sock, msg, "This command can only be used in a group.");
        return;
    }
    if (!trusted && !groupAdmin) {
        await reply(sock, msg, "Only group administrators and trusted users may use this command.");
        return;
    }

    // no time given means a mute for good
    let duration = null;
    const arg = argsOf(text);
    if (muting && arg) {
        duration = parseDuration(arg);
        if (duration === null || duration < MIN_MUTE_MS || duration > MAX_MUTE_MS) {
            await reply(
                sock,
                msg,
                `Use ${commandPrefix}mute on its own to mute for good, or add a time from 1min to 30d, ` +
                `like ${commandPrefix}mute 2h, ${commandPrefix}mute 120min or ${commandPrefix}mute 1h30min.`
            );
            return;
        }
    }

    try {
        await sock.groupSettingUpdate(chatId, muting ? "announcement" : "not_announcement");
    } catch (error) {
        log.error("extras", "Could not change the group mute setting:", error);
        await reply(sock, msg, "I couldn't change the group settings. Make sure I'm a group administrator.");
        return;
    }

    // a new !mute or an !unmute replaces any timer already running for this group
    state.mutes = state.mutes.filter((entry) => entry.chatId !== chatId);
    if (duration) {
        state.mutes.push({ chatId, until: Date.now() + duration });
    }
    saveState();

    if (!muting) {
        await reply(sock, msg, "The group has been unmuted. Everyone can send messages again.");
    } else if (duration) {
        await reply(sock, msg, `The group has been muted for ${describeDuration(duration)}. Only administrators can send messages.`);
    } else {
        await reply(sock, msg, `The group has been muted. Only administrators can send messages until someone runs ${commandPrefix}unmute.`);
    }
}

let mutesRunning = false;

// unmutes any group whose timed mute has run out
async function runMutes() {
    if (!liveSock || mutesRunning || !state.mutes.length) {
        return;
    }

    mutesRunning = true;
    try {
        for (const entry of [...state.mutes]) {
            if (Date.now() < entry.until) {
                continue;
            }

            // drop it first so a failure doesn't make it retry forever
            state.mutes = state.mutes.filter((other) => other !== entry);
            saveState();

            try {
                await liveSock.groupSettingUpdate(entry.chatId, "not_announcement");
                await liveSock.sendMessage(entry.chatId, {
                    text: "The timed mute is over. The group has been unmuted."
                });
            } catch (error) {
                log.error("extras", "Could not unmute after a timed mute:", error);
            }
        }
    } finally {
        mutesRunning = false;
    }
}

// !ban / !unban
// !ban @someone (or reply to them, or give a phone number) makes the bot
// ignore that person in this group. add a time like !ban @someone 2h and
// it wears off by itself, otherwise it lasts until !unban. trusted users
// can't be banned, index.js only checks isBanned() for everyone else.
// ============================================================

// just the number part of a jid, so a lid and a phone number can be compared
function userPart(jid) {
    return String(jid || "").split("@")[0].split(":")[0];
}

// the same person can show up as a lid or as a phone number depending on the
// message, so look them up in the group and keep every id they have
async function idsFor(sock, chatId, jid) {
    const wanted = userPart(jid);
    const ids = new Set([wanted]);
    try {
        const metadata = await sock.groupMetadata(chatId);
        const found = metadata.participants.find(p =>
            [p.id, p.lid, p.phoneNumber, p.jid].some(x => x && userPart(x) === wanted)
        );
        if (found) {
            for (const x of [found.id, found.lid, found.phoneNumber, found.jid]) {
                if (x) {
                    ids.add(userPart(x));
                }
            }
        }
    } catch (error) {
        log.error("extras", "Could not look up the group members:", error);
    }
    return [...ids];
}

// true when this person is banned in this group right now. index.js asks this
// for every message, so bail out early when nobody is banned
function isBanned(chatId, jids) {
    if (!extraCommandsEnabled() || state.bans.length === 0) {
        return false;
    }
    const parts = jids.filter(Boolean).map(userPart);
    const now = Date.now();
    return state.bans.some(ban =>
        ban.chatId === chatId &&
        (ban.until === null || ban.until > now) &&
        ban.ids.some(id => parts.includes(id))
    );
}

// force banned numbers come from FORCE_BANNED in .env or from !special forceban, and they count in every chat
// keeps just the digits and gives back null if it doesnt look like a phone number (7 to 15 digits)
function cleanNumber(input) {
    const digits = String(input || "").replace(/[+\s-]/g, "");
    return /^\d{7,15}$/.test(digits) ? digits : null;
}

// the .env list only gets parsed again if the variable changes
let envForceCache = { raw: null, numbers: [] };
function envForceBans() {
    const raw = process.env.FORCE_BANNED || "";
    if (envForceCache.raw !== raw) {
        const numbers = raw.split(/[\s,]+/).map(cleanNumber).filter(Boolean);
        envForceCache = { raw, numbers: [...new Set(numbers)] };
    }
    return envForceCache.numbers;
}

function isForceBanned(jids) {
    const fromEnv = envForceBans();
    if (!fromEnv.length && !state.forceBans.length) return false;
    return (jids || []).some(jid => {
        const number = userPart(jid);
        return number && (fromEnv.includes(number) || state.forceBans.includes(number));
    });
}

function forceBanCommand(args) {
    const usage = "Usage: !special forceban <add|remove|list> [number]. The number needs the country code and digits only, for example 6512345678.";
    const action = String(args[0] || "").toLowerCase();
    if (action === "list") {
        const lines = [];
        const fromEnv = envForceBans();
        if (fromEnv.length) lines.push(`Force banned numbers (from .env): ${fromEnv.join(", ")}`);
        if (state.forceBans.length) lines.push(`Force banned numbers (added with !special forceban): ${state.forceBans.join(", ")}`);
        return lines.length ? lines.join("\n") : "No numbers are force banned.";
    }
    if (action !== "add" && action !== "remove") return usage;
    const number = cleanNumber(args.slice(1).join(""));
    if (!number) return usage;
    if (action === "add") {
        if (envForceBans().includes(number) || state.forceBans.includes(number)) return `${number} is already force banned.`;
        if ((getTrusted() || []).some(id => userPart(id) === number)) return "Trusted users can't be force banned.";
        state.forceBans.push(number);
        saveState();
        return `Force banned ${number}. They can no longer use the bot in any chat.`;
    }
    if (state.forceBans.includes(number)) {
        state.forceBans = state.forceBans.filter(n => n !== number);
        saveState();
        return `Removed ${number} from the force banned list.`;
    }
    if (envForceBans().includes(number)) return `${number} is set in .env, so it has to be removed from FORCE_BANNED there.`;
    return `${number} is not force banned.`;
}

let bansRunning = false;

// drops bans that ran out and tells the group, runs on the same timer as the mutes
async function purgeBans() {
    const now = Date.now();
    if (bansRunning || !state.bans.some(ban => ban.until !== null && ban.until <= now)) {
        return;
    }

    bansRunning = true;
    try {
        const expired = state.bans.filter(ban => ban.until !== null && ban.until <= now);

        // drop them first so a failed message doesn't make it retry forever
        state.bans = state.bans.filter(ban => !expired.includes(ban));
        saveState();

        if (!liveSock) {
            return;
        }

        for (const ban of expired) {
            try {
                // older bans saved before jid existed just get a plain message
                if (ban.jid) {
                    await liveSock.sendMessage(ban.chatId, {
                        text: `The ban on @${userPart(ban.jid)} is over. The bot will listen to them again.`,
                        mentions: [ban.jid]
                    });
                } else {
                    await liveSock.sendMessage(ban.chatId, { text: "A timed ban is over. The bot will listen to them again." });
                }
            } catch (error) {
                log.error("extras", "Could not announce that a ban ran out:", error);
            }
        }
    } finally {
        bansRunning = false;
    }
}

async function handleBan(sock, msg, { chatId, text, isGroup, trusted, groupAdmin, commandPrefix }) {
    const banning = text.trim().split(/\s+/)[0].toLowerCase() === "!ban";

    if (!isGroup) {
        await reply(sock, msg, "This command can only be used in a group.");
        return;
    }
    if (!trusted && !groupAdmin) {
        await reply(sock, msg, "Only group administrators and trusted users may use this command.");
        return;
    }

    const context = msg.message?.extendedTextMessage?.contextInfo;

    // @mentions show up as @number in the text, so skip those words here
    const words = argsOf(text).split(/\s+/).filter(word => word && !word.startsWith("@"));

    // a bare phone number counts as the target, so pull it out of the words
    const phoneAt = words.findIndex(word => /^\+?\d{7,15}$/.test(word));
    const phone = phoneAt === -1 ? null : words.splice(phoneAt, 1)[0].replace("+", "");

    // mention first, then a phone number, then whoever got replied to
    let target = null;
    if (context?.mentionedJid?.[0]) {
        target = context.mentionedJid[0];
    } else if (phone) {
        target = `${phone}@s.whatsapp.net`;
    } else if (context?.participant) {
        target = context.participant;
    }

    if (!target) {
        await reply(sock, msg, banning
            ? `Say who to ban: ${commandPrefix}ban @user [time], reply to them with ${commandPrefix}ban [time], or ${commandPrefix}ban <phone number> [time].`
            : `Say who to unban: ${commandPrefix}unban @user, reply to them with ${commandPrefix}unban, or ${commandPrefix}unban <phone number>.`);
        return;
    }

    // no time means banned for good
    let duration = null;
    if (banning && words.length > 0) {
        duration = parseDuration(words.join(""));
        if (duration === null || duration < MIN_MUTE_MS || duration > MAX_MUTE_MS) {
            await reply(sock, msg, `I couldn't read that time. Try something like ${commandPrefix}ban @user 2h, 90min or 1h30min (1 minute to 30 days).`);
            return;
        }
    }

    const ids = await idsFor(sock, chatId, target);

    const me = [sock.user?.id, sock.user?.lid].filter(Boolean).map(userPart);
    if (ids.some(id => me.includes(id))) {
        await reply(sock, msg, "I can't ban myself.");
        return;
    }

    // drop any older ban for the same person, a new one replaces it
    const before = state.bans.length;
    state.bans = state.bans.filter(ban => !(ban.chatId === chatId && ban.ids.some(id => ids.includes(id))));
    const wasBanned = state.bans.length !== before;

    if (!banning) {
        saveState();
        await reply(sock, msg, wasBanned ? "Unbanned. The bot will listen to them again." : "That person isn't banned.");
        return;
    }

    state.bans.push({ chatId, ids, until: duration ? Date.now() + duration : null, jid: target });
    saveState();

    await reply(sock, msg, duration
        ? `Banned from using the bot for ${describeDuration(duration)}.`
        : `Banned from using the bot until someone runs ${commandPrefix}unban.`);
}

// !execute
// !execute @someone (or reply to them, or give a phone number) kicks them out
// of the group and announces it. the bot has to be a group admin, and it can't
// remove other admins.
// ============================================================

async function handleExecute(sock, msg, { chatId, text, isGroup, trusted, groupAdmin, commandPrefix }) {
    if (!isGroup) {
        await reply(sock, msg, "This command can only be used in a group.");
        return;
    }
    if (!trusted && !groupAdmin) {
        await reply(sock, msg, "Only group administrators and trusted users may use this command.");
        return;
    }

    const context = msg.message?.extendedTextMessage?.contextInfo;

    // @mentions show up as @number in the text, so skip those words here
    const words = argsOf(text).split(/\s+/).filter(word => word && !word.startsWith("@"));
    const phone = words.find(word => /^\+?\d{7,15}$/.test(word))?.replace("+", "");

    // mention first, then a phone number, then whoever got replied to
    let target = null;
    if (context?.mentionedJid?.[0]) {
        target = context.mentionedJid[0];
    } else if (phone) {
        target = `${phone}@s.whatsapp.net`;
    } else if (context?.participant) {
        target = context.participant;
    }

    if (!target) {
        await reply(sock, msg, `Say who to execute: ${commandPrefix}execute @user, reply to them with ${commandPrefix}execute, or ${commandPrefix}execute <phone number>.`);
        return;
    }

    // find them in the group so we remove them with the id the group knows them by
    let member = null;
    try {
        const metadata = await sock.groupMetadata(chatId);
        const wanted = userPart(target);
        member = metadata.participants.find(p =>
            [p.id, p.lid, p.phoneNumber, p.jid].some(x => x && userPart(x) === wanted)
        );
    } catch (error) {
        log.error("extras", "Could not look up the group members:", error);
    }

    if (!member) {
        await reply(sock, msg, "I couldn't find that person in this group.");
        return;
    }

    const me = [sock.user?.id, sock.user?.lid].filter(Boolean).map(userPart);
    if ([member.id, member.lid, member.phoneNumber, member.jid].some(x => x && me.includes(userPart(x)))) {
        await reply(sock, msg, "I'm not executing myself.");
        return;
    }

    try {
        const results = await sock.groupParticipantsUpdate(chatId, [member.id], "remove");
        const status = String(results?.[0]?.status || "200");
        if (status !== "200") {
            throw new Error(`status ${status}`);
        }
    } catch (error) {
        log.error("extras", "Could not remove the member:", error);
        await reply(sock, msg, "I couldn't remove them. Make sure I'm a group administrator and they aren't one too.");
        return;
    }

    // tagging them makes whatsapp show their name
    await sock.sendMessage(chatId, {
        text: `BANG! @${userPart(member.id)} was executed.`,
        mentions: [member.id]
    });
}

// !add
// !add <phone number> adds that person to the group. the bot has to be a group
// admin. whatsapp refuses if their privacy settings don't let anyone add them.
// ============================================================

async function handleAdd(sock, msg, { chatId, text, isGroup, trusted, groupAdmin, commandPrefix }) {
    if (!isGroup) {
        await reply(sock, msg, "This command can only be used in a group.");
        return;
    }
    if (!trusted && !groupAdmin) {
        await reply(sock, msg, "Only group administrators and trusted users may use this command.");
        return;
    }

    // keep just the digits so "+65 9123 4567" works too
    const digits = argsOf(text).replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) {
        await reply(sock, msg, `Usage: ${commandPrefix}add <phone number with country code>, like ${commandPrefix}add 6591234567`);
        return;
    }

    let status = "";
    try {
        const results = await sock.groupParticipantsUpdate(chatId, [`${digits}@s.whatsapp.net`], "add");
        status = String(results?.[0]?.status || "");
    } catch (error) {
        log.error("extras", "Could not add the member:", error);
        await reply(sock, msg, "I couldn't add them. Make sure I'm a group administrator.");
        return;
    }

    if (status === "200") {
        await reply(sock, msg, `Added ${digits}.`);
    } else if (status === "409") {
        await reply(sock, msg, "They're already in this group.");
    } else if (status === "403") {
        await reply(sock, msg, "Their privacy settings don't let me add them. Send them the group invite link instead.");
    } else if (status === "408") {
        await reply(sock, msg, "They left the group recently, so they can't be added right away.");
    } else {
        await reply(sock, msg, `WhatsApp refused to add them (status ${status || "unknown"}).`);
    }
}

// ============================================================
// !warn / !unwarn / !warnings
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

// the time for a warn ban, 0 means it never ends. gives back null when it cant be read
function parseBanTime(input) {
    if (String(input).trim() === "0") {
        return 0;
    }
    const duration = parseDuration(input);
    return duration === null || duration < MIN_MUTE_MS || duration > MAX_MUTE_MS ? null : duration;
}

// warnings older than warnexpiry days dont count anymore, 0 means they never run out
function liveWarnings(entry, chatId) {
    const days = getGroupSetting(chatId, "warnexpiry");
    if (!days) {
        return entry.times;
    }
    return entry.times.filter(time => time > Date.now() - days * DAY_MS);
}

// drops old warnings and people with none left, so the file doesnt fill up
function cleanWarns() {
    for (const entry of state.warns) {
        entry.times = liveWarnings(entry, entry.chatId);
    }
    state.warns = state.warns.filter(entry => entry.times.length > 0);
}

// a person can have a lid and a phone number, so match any id they have
function warnEntryFor(chatId, ids) {
    return state.warns.find(entry => entry.chatId === chatId && entry.ids.some(id => ids.includes(id)));
}

// every id a group member has, so the same person is found whichever one shows up
function idsOfMember(member) {
    return [...new Set([member.id, member.lid, member.phoneNumber, member.jid].filter(Boolean).map(userPart))];
}

// mention first, then a phone number, then whoever got replied to.
// words is whatever is left of the message, which is the reason for !warn
function pickTarget(msg, text) {
    const context = msg.message?.extendedTextMessage?.contextInfo;
    const words = argsOf(text).split(/\s+/).filter(word => word && !word.startsWith("@"));
    const phoneAt = words.findIndex(word => /^\+?\d{7,15}$/.test(word));
    const phone = phoneAt === -1 ? null : words.splice(phoneAt, 1)[0].replace("+", "");

    let target = null;
    if (context?.mentionedJid?.[0]) {
        target = context.mentionedJid[0];
    } else if (phone) {
        target = `${phone}@s.whatsapp.net`;
    } else if (context?.participant) {
        target = context.participant;
    }
    return { target, words };
}

// finds them in the group so we use the id the group knows them by
async function findMember(sock, chatId, target) {
    try {
        const metadata = await sock.groupMetadata(chatId);
        const wanted = userPart(target);
        return metadata.participants.find(p =>
            [p.id, p.lid, p.phoneNumber, p.jid].some(x => x && userPart(x) === wanted)
        ) || null;
    } catch (error) {
        log.error("extras", "Could not look up the group members:", error);
        return null;
    }
}

// the checks every warn command starts with. says why and gives back false when it shouldnt go on
async function warnGuard(sock, msg, { chatId, isGroup, trusted, groupAdmin }) {
    if (!isGroup) {
        await reply(sock, msg, "This command can only be used in a group.");
        return false;
    }
    if (!trusted && !groupAdmin) {
        await reply(sock, msg, "Only group administrators and trusted users may use this command.");
        return false;
    }
    if (getGroupSetting(chatId, "warntoggle") === false) {
        await reply(sock, msg, "The warn commands are turned off in this group. Use !mod warntoggle true to turn them on.");
        return false;
    }
    return true;
}

// records a warning and does whatever the group set for the limit (kick, ban or just saying so).
// !warn and the automatic curse warnings both use this so they always behave the same
async function giveWarning(sock, chatId, member, ids, reason) {
    let entry = warnEntryFor(chatId, ids);
    if (!entry) {
        entry = { chatId, ids, jid: member.id, times: [] };
        state.warns.push(entry);
    }
    entry.ids = [...new Set([...entry.ids, ...ids])];
    entry.jid = member.id;
    entry.times = [...liveWarnings(entry, chatId), Date.now()];
    // save the warning first so a failed kick doesnt lose it
    cleanWarns();
    saveState();

    const count = entry.times.length;
    const limit = getGroupSetting(chatId, "warnlimit");
    const tag = `@${userPart(member.id)}`;
    const reasonLine = reason ? `\nReason: ${reason}` : "";
    const say = message => sock.sendMessage(chatId, { text: message + reasonLine, mentions: [member.id] });

    if (count < limit) {
        await say(`${tag} has been warned (${count}/${limit}).`);
        return;
    }

    const actions = getGroupSetting(chatId, "warnaction");
    // everything that went through gets listed in the message at the end
    const done = [];
    let kickFailed = false;

    if (actions.includes("kick")) {
        try {
            const results = await sock.groupParticipantsUpdate(chatId, [member.id], "remove");
            const status = String(results?.[0]?.status || "200");
            if (status !== "200") {
                throw new Error(`status ${status}`);
            }
            done.push("removed from the group");
        } catch (error) {
            log.error("extras", "Could not remove the member after their warnings:", error);
            kickFailed = true;
        }
    }

    if (actions.includes("ban")) {
        const duration = getGroupSetting(chatId, "warnbanduration");
        // a new ban replaces an older one for the same person
        state.bans = state.bans.filter(ban => !(ban.chatId === chatId && ban.ids.some(id => ids.includes(id))));
        state.bans.push({ chatId, ids, until: duration ? Date.now() + duration : null, jid: member.id });
        done.push(`banned from using the bot${duration ? ` for ${describeDuration(duration)}` : ""}`);
    }

    // nothing to do at the limit, so just say they got there
    if (!done.length && !kickFailed) {
        await say(`${tag} has reached ${count}/${limit} warnings.`);
        return;
    }

    // the kick was the only action and it failed, so nothing happened yet. the next warning tries it again
    if (!done.length) {
        await say(`${tag} has reached ${count}/${limit} warnings, but I couldn't remove them. Make sure I'm a group administrator.`);
        return;
    }

    saveState();

    const result = done.join(" and ");
    if (kickFailed) {
        await say(`${tag} has been warned (${count}/${limit}) and ${result}, but I couldn't remove them from the group. Make sure I'm a group administrator.`);
    } else {
        await say(`${tag} has been warned (${count}/${limit})${done.length > 1 ? "," : " and"} ${result}.`);
    }
}

async function handleWarn(sock, msg, ctx) {
    const { chatId, text, commandPrefix } = ctx;
    if (!(await warnGuard(sock, msg, ctx))) {
        return;
    }

    const { target, words } = pickTarget(msg, text);
    if (!target) {
        await reply(sock, msg, `Say who to warn: ${commandPrefix}warn @user [reason], or reply to them with ${commandPrefix}warn [reason].`);
        return;
    }

    const member = await findMember(sock, chatId, target);
    if (!member) {
        await reply(sock, msg, "I couldn't find that person in this group.");
        return;
    }

    const ids = idsOfMember(member);
    const me = [sock.user?.id, sock.user?.lid].filter(Boolean).map(userPart);
    if (ids.some(id => me.includes(id))) {
        await reply(sock, msg, "I can't warn myself.");
        return;
    }
    if ([member.id, member.lid, member.phoneNumber, member.jid].some(id => isTrusted(id))) {
        await reply(sock, msg, "Trusted users can't be warned.");
        return;
    }
    if (member.admin) {
        await reply(sock, msg, "Group admins can't be warned.");
        return;
    }

    await giveWarning(sock, chatId, member, ids, words.join(" ").trim());
}

// ----------------------------------------------------
// automatic warnings for cursing
// ----------------------------------------------------

// reads a whole number from .env, and uses the fallback if its missing or out of range
function envNumber(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

// a group uses its own numbers from !mod if it set them, otherwise the ones from .env
function curseSettings(chatId) {
    const limit = getGroupSetting(chatId, "warncurses");
    const minutes = getGroupSetting(chatId, "warncursestime");
    return {
        limit: Number.isInteger(limit) ? limit : envNumber("WARN_CURSES_DEFAULT", 5, 0, 50),
        minutes: Number.isInteger(minutes) ? minutes : envNumber("WARN_CURSES_TIME_DEFAULT", 5, 1, 60)
    };
}

// counts deleted curse messages per person, the window starts at their first one and ends after warncursestime mins
// "chatId:person" -> { start, count }
const curseCounts = new Map();

// same as !warn but the bot hands it out itself (admins and trusted people are skipped)
async function curseDeleted(sock, msg, { chatId, senderJid }) {
    const { limit, minutes } = curseSettings(chatId);
    // 0 means off, and turning the warn commands off turns this off too
    if (!limit || getGroupSetting(chatId, "warntoggle") === false) {
        return;
    }

    const member = await findMember(sock, chatId, senderJid);
    if (!member) {
        return;
    }

    // the same people !warn refuses to warn, they just get skipped quietly here
    const ids = idsOfMember(member);
    const me = [sock.user?.id, sock.user?.lid].filter(Boolean).map(userPart);
    const trusted = [member.id, member.lid, member.phoneNumber, member.jid].some(id => isTrusted(id));
    if (member.admin || trusted || ids.some(id => me.includes(id))) {
        return;
    }

    // no timers needed only check how old the window is when the next message gets deleted
    const now = Date.now();
    if (curseCounts.size > 500) {
        // nobody has a window longer than an hour, so anything older than that can go
        for (const [oldKey, old] of curseCounts) {
            if (now - old.start >= 60 * 60 * 1000) {
                curseCounts.delete(oldKey);
            }
        }
    }

    const key = `${chatId}:${ids[0]}`;
    let counter = curseCounts.get(key);
    if (!counter || now - counter.start >= minutes * 60 * 1000) {
        counter = { start: now, count: 0 };
        curseCounts.set(key, counter);
    }
    counter.count += 1;

    if (counter.count > limit) {
        await giveWarning(sock, chatId, member, ids, "Too many deleted messages for cursing.");
    }
}

async function handleUnwarn(sock, msg, ctx) {
    const { chatId, text, commandPrefix } = ctx;
    if (!(await warnGuard(sock, msg, ctx))) {
        return;
    }

    const { target, words } = pickTarget(msg, text);
    if (!target) {
        await reply(sock, msg, `Say who to remove a warning from: ${commandPrefix}unwarn @user [all], or reply to them with ${commandPrefix}unwarn [all].`);
        return;
    }

    const member = await findMember(sock, chatId, target);
    if (!member) {
        await reply(sock, msg, "I couldn't find that person in this group.");
        return;
    }

    const entry = warnEntryFor(chatId, idsOfMember(member));
    const live = entry ? liveWarnings(entry, chatId) : [];
    if (!live.length) {
        await reply(sock, msg, "That person has no warnings.");
        return;
    }

    const tag = `@${userPart(member.id)}`;
    const all = words.some(word => word.toLowerCase() === "all");
    entry.times = all ? [] : live.slice(0, -1);
    cleanWarns();
    saveState();

    const message = all
        ? `Cleared all warnings for ${tag}.`
        : `Removed a warning from ${tag}. They now have ${entry.times.length}/${getGroupSetting(chatId, "warnlimit")}.`;
    await sock.sendMessage(chatId, { text: message, mentions: [member.id] });
}

async function handleWarnings(sock, msg, ctx) {
    const { chatId, text } = ctx;
    if (!(await warnGuard(sock, msg, ctx))) {
        return;
    }

    cleanWarns();
    const limit = getGroupSetting(chatId, "warnlimit");
    const { target } = pickTarget(msg, text);

    // no one picked means everyone in the group who has warnings
    if (!target) {
        const here = state.warns.filter(entry => entry.chatId === chatId);
        if (!here.length) {
            await reply(sock, msg, "Nobody in this group has any warnings.");
            return;
        }
        const lines = here.map(entry => `@${userPart(entry.jid)}: ${entry.times.length}/${limit}`);
        await sock.sendMessage(chatId, {
            text: `Warnings in this group:\n${lines.join("\n")}`,
            mentions: here.map(entry => entry.jid)
        });
        return;
    }

    const member = await findMember(sock, chatId, target);
    if (!member) {
        await reply(sock, msg, "I couldn't find that person in this group.");
        return;
    }

    const entry = warnEntryFor(chatId, idsOfMember(member));
    const tag = `@${userPart(member.id)}`;
    await sock.sendMessage(chatId, {
        text: entry ? `${tag} has ${entry.times.length}/${limit} warnings.` : `${tag} has no warnings.`,
        mentions: [member.id]
    });
}

// ---------------------------------------------------------------------------
// !roast and !compliment
// ---------------------------------------------------------------------------

// both commands are the same thing with different words, so they share one handler.
// {name} gets swapped for whoever was picked. the backup lines only get used when the ai cant answer
const BANTER = {
    roast: {
        system: "You write one short, playful roast for a friendly group chat. Write one or two sentences, at most 200 characters, with no emojis, no hashtags and no quotation marks. Keep it light and silly, the way friends tease each other. Never joke about looks, body, weight, health, family, race, religion, nationality, gender, sexuality or disability, and never use slurs or swearing. Only write the roast itself, nothing before it and nothing after it.",
        ask: name => `Roast this: ${name}`,
        backup: [
            "{name} is the reason the group chat has a mute button.",
            "{name} has the confidence of someone who has never lost an argument, mostly because nobody has the energy to start one.",
            "{name} would lose a game of hide and seek against a lamp.",
            "{name} types a full paragraph and then sends the word ok.",
            "{name} is proof that the bar can always go lower.",
            "{name} takes three hours to reply and then asks why everyone is so quiet.",
            "{name} has the energy of a phone at 1 percent.",
            "{name} reads the group rules and decides they are more of a suggestion.",
            "{name} is the main character of a story that nobody asked to hear.",
            "{name} would get lost in a straight hallway.",
            "{name} says five minutes and means the next business week.",
            "{name} has never once found the charger on the first try."
        ]
    },
    compliment: {
        system: "You write one short, sincere and upbeat compliment. Write one or two sentences, at most 200 characters, with no emojis, no hashtags and no quotation marks. Keep it warm and specific instead of generic, and never comment on looks or the body. Only write the compliment itself, nothing before it and nothing after it.",
        ask: name => `Compliment this: ${name}`,
        backup: [
            "{name} makes every group chat a little better just by being in it.",
            "{name} has a way of making hard days feel a bit lighter.",
            "{name} is the kind of person people are glad to have around.",
            "{name} always brings good energy to the conversation.",
            "{name} is more thoughtful than they probably realise.",
            "{name} is the friend everyone hopes to have in their corner.",
            "{name} makes the people around them feel welcome.",
            "{name} has a sense of humour that keeps everyone laughing.",
            "{name} is reliable, kind and honestly a pleasure to talk to.",
            "{name} makes hard things look easy.",
            "{name} has a great way of seeing the bright side of things.",
            "{name} deserves a lot more credit than they usually get."
        ]
    }
};

// the ai can wrap its answer in quotes or leave a thinking block in, so tidy that up first.
// an empty result means it didnt give us anything usable
function cleanBanterLine(raw) {
    const line = String(raw || "")
        .replace(/<think>[\s\S]*?<\/think>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();
    return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

// gives up on the ai after a while so the command still answers quickly
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((resolve, reject) => setTimeout(() => reject(new Error("timed out")), ms))
    ]);
}

async function handleBanter(kind, sock, msg, { text }) {
    const chatId = msg.key.remoteJid;
    const context = msg.message?.extendedTextMessage?.contextInfo;
    const given = argsOf(text);

    // who it is about: a real mention first, then whatever was typed, then the person
    // being replied to, and if there is nothing at all it is about whoever sent the command
    let jid = context?.mentionedJid?.[0];
    let name = jid ? `@${userPart(jid)}` : "";
    if (!jid) {
        if (given) {
            if (given.length > 100) {
                await reply(sock, msg, "That is too long. Please keep it under 100 characters.");
                return;
            }
            name = given;
        } else {
            jid = (context?.quotedMessage && context.participant) || msg.key.participant || chatId;
            name = `@${userPart(jid)}`;
        }
    }

    const words = BANTER[kind];
    let message = "";
    try {
        const line = cleanBanterLine(await withTimeout(aitools.writeLine(words.system, words.ask(name)), 40000));
        if (line) {
            message = `${name}: ${line}`;
        }
    } catch (error) {
        log.warn("banter", `The ai could not write the ${kind}, using a backup line instead: ${error.message}`);
    }

    // no ai answer, so grab one of the backup lines
    if (!message) {
        const pick = words.backup[Math.floor(Math.random() * words.backup.length)];
        message = pick.replace("{name}", name);
    }

    await sock.sendMessage(chatId, { text: message, mentions: jid ? [jid] : [] }, { quoted: msg });
}

const handleRoast = (sock, msg, context) => handleBanter("roast", sock, msg, context);
const handleCompliment = (sock, msg, context) => handleBanter("compliment", sock, msg, context);

const COMMANDS = {
    "!fact": handleFact,
    "!joke": handleJoke,
    "!roast": handleRoast,
    "!compliment": handleCompliment,
    "!define": handleDefine,
    "!wiki": handleWiki,
    "!quote": handleQuote,
    "!translate": handleTranslate,
    "!tts": handleTts,
    "!sticker": handleSticker,
    "!animsticker": handleAnimSticker,
    "!edit": handleEdit,
    "!automute": handleAutoMute,
    "!autounmute": handleAutoMute,
    "!mute": handleMute,
    "!unmute": handleMute,
    "!ban": handleBan,
    "!unban": handleBan,
    "!execute": handleExecute,
    "!add": handleAdd,
    "!warn": handleWarn,
    "!unwarn": handleUnwarn,
    "!warnings": handleWarnings
};

async function handleCommand(sock, msg, ctx) {
    if (!extraCommandsEnabled()) {
        return false;
    }

    const name = ctx.text.trim().split(/\s+/)[0].toLowerCase();
    if (!Object.hasOwn(COMMANDS, name)) {
        return false;
    }

    await COMMANDS[name](sock, msg, ctx);
    return true;
}

module.exports = { init, handleCommand, captionText, extraCommandsEnabled, isBanned, parseBanTime, describeDuration, curseDeleted, curseSettings, isForceBanned, forceBanCommand };
