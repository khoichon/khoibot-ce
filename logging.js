// Console logging. With ENABLE_BETTER_LOGGING=1 every line gets a timestamp,
// a level and a tag. Otherwise log.* prints exactly what console.* would.

const util = require("node:util");

const MAX_MESSAGE_LENGTH = 500;
const STACK_LINES = 3;

// Group names by chat id, filled in by index.js when it reads the group.
const groupNames = new Map();

const COLORS = {
    dim: "\x1b[2m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    blue: "\x1b[34m",
    white: "\x1b[37m",
    gray: "\x1b[90m",
    teal: "\x1b[38;5;36m",
    reset: "\x1b[0m"
};

const LEVELS = {
    info: { label: "INFO", color: "green", write: "log", stream: "stdout" },
    warn: { label: "WARN", color: "yellow", write: "warn", stream: "stderr" },
    error: { label: "ERROR", color: "red", write: "error", stream: "stderr" }
};

// Every colour can be set from the env: LOG_COLOR_TIME, LOG_COLOR_TAG,
// LOG_COLOR_INFO, LOG_COLOR_WARN, LOG_COLOR_ERROR, LOG_COLOR_PHONE and
// LOG_COLOR_GROUP. Use any name from COLORS above (not reset), or "none" for no
// colour. If it is blank or misspelled we just use the default.
function colorFor(envName, fallback) {
    const wanted = (process.env[envName] || "").trim().toLowerCase();
    if (wanted === "none" || (wanted !== "reset" && Object.hasOwn(COLORS, wanted))) {
        return wanted;
    }
    return fallback;
}

function betterLoggingEnabled() {
    return process.env.ENABLE_BETTER_LOGGING === "1";
}

// "0" turns an option off. Unset or anything else leaves it on.
function optionEnabled(name) {
    return process.env[name] !== "0";
}

// Colours go to a terminal only. NO_COLOR turns them off and FORCE_COLOR
// turns them on (for example under PM2, which does not use a terminal).
function useColor(stream = "stdout") {
    if (process.env.NO_COLOR) {
        return false;
    }
    if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "") {
        return process.env.FORCE_COLOR !== "0";
    }
    return Boolean(process[stream]?.isTTY);
}

function paint(text, color, enabled) {
    return enabled && COLORS[color] ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

function rememberGroupName(chatId, name) {
    if (chatId && name) {
        groupNames.set(chatId, name);
    }
}

function timestamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: process.env.EXTRA_TIMEZONE || "Asia/Singapore",
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    }).formatToParts(date);

    const get = type => parts.find(part => part.type === type).value;
    return `[${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}:${get("second")}]`;
}

// Picks the sender's id from the ids WhatsApp gives for a message.
// With showPhone it prefers the phone number, otherwise the LID.
function senderLabel(msg, showPhone) {
    const ids = [
        msg.key.participant,
        msg.key.participantAlt,
        msg.key.remoteJid,
        msg.key.remoteJidAlt
    ].filter(id => typeof id === "string" && id !== "" && !id.endsWith("@g.us"));

    const phone = ids.find(id => id.endsWith("@s.whatsapp.net"));
    const lid = ids.find(id => id.endsWith("@lid"));

    if (showPhone && phone) {
        return `+${phone.split("@")[0].split(":")[0]}`;
    }
    return lid || phone || ids[0] || `unknown ${JSON.stringify(msg.key)}`; // no ids at all, so show the raw key to help work out why
}

// How the game logs write who sent a message and which group it was in, the
// same way as the message lines (see ENABLE_SHOW_PH and ENABLE_SHOW_GRP).
function describeSender(msg) {
    return senderLabel(msg, optionEnabled("ENABLE_SHOW_PH"));
}

function describeGroup(chatId) {
    if (!chatId?.endsWith("@g.us")) {
        return chatId?.endsWith("@newsletter") ? "<CHANNEL>" : "<DM>";
    }
    const name = groupNames.get(chatId) || chatId;
    return optionEnabled("ENABLE_SHOW_GRP") ? `<GRP: ${name}>` : "<GRP>";
}

// whatsapp sends a mention as @ plus the raw id, so in the log it shows up as @123456789012345.
// we swap it for the persons name if weve seen them talk, or their number, or just "someone"
const namesById = new Map();

function idNumber(jid) {
    return String(jid || "").split("@")[0].split(":")[0];
}

function tidyMentions(text, msg) {
    // remember who just spoke, so later mentions of them can use their name
    const senderId = idNumber(msg.key.participant || msg.key.remoteJid);
    if (msg.pushName && senderId) {
        namesById.set(senderId, msg.pushName);
    }

    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    return text.replace(/@(\d{5,})/g, (whole, number) => {
        const jid = mentioned.find(id => idNumber(id) === number);
        // not a real mention, just someone typing an @ and some digits
        if (!jid) {
            return whole;
        }
        const name = optionEnabled("ENABLE_SHOW_NAME") ? namesById.get(number) : null;
        // a lid cant be turned into a phone number, so we dont pretend it is one
        if (jid.endsWith("@s.whatsapp.net")) {
            return name ? `@+${number} (${name})` : `@+${number}`;
        }
        return name ? `@${name}` : "@someone";
    });
}

// puts the persons name in brackets next to their number, like +6591234567 (Maxwell)
function withName(label, msg) {
    return msg.pushName && optionEnabled("ENABLE_SHOW_NAME") ? `${label} (${msg.pushName})` : label;
}

// The line for an incoming message.
function summarizeMessage({ msg, text, color = false }) {
    const chatId = msg.key.remoteJid;
    const isGroup = Boolean(chatId?.endsWith("@g.us"));

    const parts = [
        paint(withName(senderLabel(msg, optionEnabled("ENABLE_SHOW_PH")), msg), colorFor("LOG_COLOR_PHONE", "cyan"), color)
    ];

    const groupColor = colorFor("LOG_COLOR_GROUP", "teal");
    if (isGroup) {
        const name = groupNames.get(chatId) || chatId;
        parts.push(paint(optionEnabled("ENABLE_SHOW_GRP") ? `<GRP: ${name}>` : "<GRP>", groupColor, color));
    } else {
        parts.push(paint(chatId?.endsWith("@newsletter") ? "<CHANNEL>" : "<DM>", groupColor, color));
    }

    if (optionEnabled("ENABLE_SHOW_MESSAGE")) {
        let shown = tidyMentions(String(text), msg).replace(/\r?\n/g, "\\n");
        if (shown.length > MAX_MESSAGE_LENGTH) {
            shown = `${shown.slice(0, MAX_MESSAGE_LENGTH)}…`;
        }
        parts.push(shown);
    }

    return parts.join(" ");
}

function formatMessage({ msg, text, date, color = useColor("stdout") }) {
    return `${paint(timestamp(date), "dim", color)} ${summarizeMessage({ msg, text, color })}`;
}

// Turns the arguments of a log call into one line, plus the first lines of
// the stack for any error.
function formatArgs(args) {
    const words = [];
    const stacks = [];

    for (const arg of args) {
        if (arg instanceof Error) {
            words.push(arg.message || arg.name);
            const frames = String(arg.stack || "")
                .split("\n")
                .filter(line => line.trim().startsWith("at "))
                .slice(0, STACK_LINES);
            stacks.push(...frames.map(line => `    ${line.trim()}`));
        } else if (typeof arg === "string") {
            words.push(arg.trim());
        } else {
            words.push(util.inspect(arg, { depth: 3, breakLength: Infinity }));
        }
    }

    return { line: words.filter(Boolean).join(" "), stacks };
}

// The line for a log call.
function formatLine({ level, tag, args, date, color }) {
    const info = LEVELS[level];
    const { line, stacks } = formatArgs(args);

    const head = [
        paint(timestamp(date), colorFor("LOG_COLOR_TIME", "dim"), color),
        paint(`[${info.label}]`, colorFor(`LOG_COLOR_${level.toUpperCase()}`, info.color), color),
        paint(`[${tag}]`, colorFor("LOG_COLOR_TAG", "cyan"), color),
        line
    ].join(" ");

    return [head, ...stacks.map(frame => paint(frame, "dim", color))].join("\n");
}

function write(level, tag, args) {
    const info = LEVELS[level];
    if (!betterLoggingEnabled()) {
        console[info.write](...args);
        return;
    }
    console[info.write](formatLine({ level, tag, args, color: useColor(info.stream) }));
}

// the arrow in front of a logged reply. swap it here if you want a different look.
const REPLY_ARROW = "╰─▶";

// same width as "[09/10/26 15:59:19] " so the reply lines up under its command
const REPLY_INDENT = " ".repeat(21);

// what a sent message looks like in one line. null means don't log it
function describeContent(content) {
    if (!content || content.react || content.delete || content.edit) {
        return null;
    }
    const withCaption = (label, extra) => (extra ? `[${label}] ${extra}` : `[${label}]`);

    if (typeof content.text === "string") {
        return content.text;
    }
    if (content.image) {
        return withCaption("image", content.caption);
    }
    if (content.video) {
        return withCaption("video", content.caption);
    }
    if (content.sticker) {
        return "[sticker]";
    }
    if (content.audio) {
        return "[audio]";
    }
    if (content.document) {
        return withCaption("file", content.fileName);
    }
    if (content.poll) {
        return withCaption("poll", content.poll.name);
    }
    if (content.location) {
        return "[location]";
    }
    return "[message]";
}

// the line for something the bot sent, tucked under the command it answers
function formatReply(content, color = useColor("stdout")) {
    const text = describeContent(content);
    if (text === null) {
        return null;
    }
    let shown = String(text).replace(/\r?\n/g, "\\n");
    if (shown.length > MAX_MESSAGE_LENGTH) {
        shown = `${shown.slice(0, MAX_MESSAGE_LENGTH)}…`;
    }
    return REPLY_INDENT + paint(`${REPLY_ARROW} ${shown}`, colorFor("LOG_COLOR_REPLY", "green"), color);
}

// logs everything the bot sends. run it before antiban.init so the line shows up
// when the message really goes out, after any delay
function watchReplies(sock) {
    const original = sock.sendMessage.bind(sock);

    sock.sendMessage = async (jid, content, options) => {
        const sent = await original(jid, content, options);
        try {
            if (betterLoggingEnabled() && optionEnabled("ENABLE_SHOW_MESSAGE")) {
                const line = formatReply(content);
                if (line) {
                    console.log(line);
                }
            }
        } catch (error) {
            // a logging problem should never stop a message from going out
        }
        return sent;
    };
}

const log = {
    info: (tag, ...args) => write("info", tag, args),
    warn: (tag, ...args) => write("warn", tag, args),
    error: (tag, ...args) => write("error", tag, args)
};

module.exports = {
    betterLoggingEnabled,
    rememberGroupName,
    formatMessage,
    summarizeMessage,
    describeSender,
    describeGroup,
    formatLine,
    watchReplies,
    log
};
