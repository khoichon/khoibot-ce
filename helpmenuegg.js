const { getMessages } = require("./messages.js");
const { getGroupSetting, setGroupSetting, isGroupEnabled } = require("./config.js");
const { reply } = require("./utils.js");
const { log } = require("./logging.js");
const data = require("./helpmenuegg-data.js");

const WIN_CHANCE = 0.001;
const HOLIDAY_WIN_CHANCE = 0.01;
const PITY_TRIES = 50;
const ROLE_CHANCE = 1 / 3;
const HOLIDAY_CHANCE = 0.5;
const FAKE_CHANCE = 0.01;
const TYPING_CHANCE = 1 / 3;

let random = Math.random;
const groups = new Map();
const listens = new Map();
const cooldowns = new Map();
let warnedOn = "";

function setRandom(fn) {
    random = fn || Math.random;
}

function reset() {
    groups.clear();
    listens.clear();
    cooldowns.clear();
    warnedOn = "";
}

function validDate(day, month, year) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseDates(text) {
    const entries = [];
    for (const part of String(text || "").split(",")) {
        const trimmed = part.trim();
        if (!trimmed) {
            continue;
        }
        const [datePart, namePart] = trimmed.split("=");
        const name = (namePart || "").trim();
        const match = /^(\d{2})-(\d{2})(?:-(\d{4}))?$/.exec((datePart || "").trim());
        const day = match ? Number(match[1]) : 0;
        const month = match ? Number(match[2]) : 0;
        const year = match && match[3] ? Number(match[3]) : null;
        if (!match || !Object.hasOwn(data.HOLIDAYS, name) || !validDate(day, month, year || 2024)) {
            log.warn("helpmenu", `Ignoring "${trimmed}" in HELPMENU_EGG_DATES, it should look like dd-mm=name or dd-mm-yyyy=name.`);
            continue;
        }
        entries.push({ day, month, year, name });
    }
    return entries;
}

function singaporeToday(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(now);
    const pick = type => Number(parts.find(part => part.type === type).value);
    return { day: pick("day"), month: pick("month"), year: pick("year") };
}

function holidayToday(entries, today) {
    const found = entries.find(entry => entry.day === today.day && entry.month === today.month && (entry.year === null || entry.year === today.year));
    return found ? found.name : null;
}

function warnIfNoDatesLeft(entries, today) {
    const stamp = `${today.year}-${today.month}-${today.day}`;
    if (warnedOn === stamp) {
        return;
    }
    warnedOn = stamp;
    const left = entries.some(entry => entry.year !== null && (entry.year > today.year || (entry.year === today.year && (entry.month > today.month || (entry.month === today.month && entry.day >= today.day)))));
    if (!left) {
        log.warn("helpmenu", "HELPMENU_EGG_DATES has no moving holiday left in the future, add next year's dates (they come out in June).");
    }
}

function loadDates() {
    return parseDates(process.env.HELPMENU_EGG_DATES || data.DEFAULT_DATES);
}

function draw(chatId, poolKey, lines) {
    const used = { ...(getGroupSetting(chatId, "helpmenuused") || {}) };
    let list = Array.isArray(used[poolKey]) ? used[poolKey].filter(line => lines.includes(line)) : [];
    let fresh = lines.filter(line => !list.includes(line));
    if (!fresh.length) {
        const last = list[list.length - 1];
        list = [];
        fresh = lines.filter(line => line !== last);
        if (!fresh.length) {
            fresh = lines.slice();
        }
    }
    const pick = fresh[Math.floor(random() * fresh.length)];
    list.push(pick);
    used[poolKey] = list;
    setGroupSetting(chatId, "helpmenuused", used);
    return pick;
}

function groupState(chatId) {
    let state = groups.get(chatId);
    if (!state) {
        state = { token: 0, longToken: 0, timers: new Set(), longTimers: new Set(), listenKeys: new Set() };
        groups.set(chatId, state);
    }
    return state;
}

function cancelLong(chatId) {
    const state = groupState(chatId);
    state.longToken++;
    for (const timer of state.longTimers) {
        clearTimeout(timer);
    }
    state.longTimers.clear();
    return state.longToken;
}

function cancel(chatId) {
    const state = groupState(chatId);
    state.token++;
    for (const timer of state.timers) {
        clearTimeout(timer);
    }
    state.timers.clear();
    for (const key of state.listenKeys) {
        listens.delete(key);
    }
    state.listenKeys.clear();
    return state.token;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const LONG_SECONDS = 20;

function later(chatId, token, seconds, job, longToken) {
    const state = groupState(chatId);
    const long = longToken !== undefined;
    const timers = long ? state.longTimers : state.timers;
    const timer = setTimeout(async () => {
        timers.delete(timer);
        if ((long ? state.longToken !== longToken : state.token !== token) || !isGroupEnabled(chatId)) {
            return;
        }
        try {
            await job();
        } catch (error) {
            log.error("helpmenu", "A follow-up did not work:", error.message);
        }
    }, seconds * 1000);
    timer.unref?.();
    timers.add(timer);
}

function numberOf(jid) {
    return String(jid || "").split("@")[0].split(":")[0];
}

async function speak(text) {
    const aitools = require("./aitools.js");
    return aitools.textToSpeech(`us ${text}`);
}

async function runStep(ctx, step) {
    const { sock, msg, chatId, senderJid } = ctx;
    if (step.say) {
        await reply(sock, msg, step.say);
    } else if (step.tag) {
        await sock.sendMessage(chatId, { text: step.tag.replace("@user", `@${numberOf(senderJid)}`), mentions: [senderJid] }, { quoted: msg });
    } else if (step.edit) {
        if (ctx.sentKey) {
            await sock.sendMessage(chatId, { text: step.edit === "__original" ? ctx.line : step.edit, edit: ctx.sentKey });
        }
    } else if (step.remove) {
        if (ctx.sentKey) {
            await sock.sendMessage(chatId, { delete: ctx.sentKey });
        }
    } else if (step.voice) {
        let audio = null;
        try {
            audio = await speak(step.voice);
        } catch (error) {
            log.error("helpmenu", "Could not make the voice note:", error.message);
        }
        if (audio) {
            await sock.sendMessage(chatId, { audio, mimetype: "audio/ogg; codecs=opus", ptt: true }, { quoted: msg });
        } else {
            await reply(sock, msg, step.voice);
        }
    } else if (step.video) {
        const sent = await require("./web.js").sendEggVideo(sock, msg, { chatId, isGroup: chatId.endsWith("@g.us") });
        if (!sent) {
            await reply(sock, msg, "(...the one that got away)");
        }
    }
}

function schedule(ctx, token, steps) {
    const longToken = steps.some(step => step.at >= LONG_SECONDS) ? cancelLong(ctx.chatId) : undefined;
    for (const step of steps) {
        if (step.listen) {
            const key = `${ctx.chatId}:${ctx.senderJid}`;
            listens.set(key, { re: step.listen, say: step.say, until: Date.now() + step.within * 1000, sock: ctx.sock });
            groupState(ctx.chatId).listenKeys.add(key);
        } else if (step.cooldown) {
            cooldowns.set(`${ctx.chatId}:${ctx.senderJid}`, { until: Date.now() + step.cooldown * 1000, warned: false });
        } else if (step.at >= LONG_SECONDS) {
            later(ctx.chatId, token, step.at, () => runStep(ctx, step), longToken);
        } else {
            later(ctx.chatId, token, step.at, () => runStep(ctx, step));
        }
    }
}

function listen(sock, msg, { chatId, senderJid, text }) {
    const key = `${chatId}:${senderJid}`;
    const wanted = listens.get(key);
    if (!wanted || !text) {
        return false;
    }
    if (wanted.until <= Date.now()) {
        listens.delete(key);
        return false;
    }
    if (!wanted.re.test(text)) {
        return false;
    }
    listens.delete(key);
    groupState(chatId).listenKeys.delete(key);
    reply(sock, msg, wanted.say).catch(() => { });
    return true;
}

function pickPool(chatId, role, holiday) {
    if (holiday && random() < HOLIDAY_CHANCE) {
        return { key: `holiday-${holiday}`, items: data.HOLIDAYS[holiday].map(line => ({ line, steps: [] })) };
    }
    if (random() < ROLE_CHANCE) {
        return { key: `role-${role}`, items: data.ROLE_POOLS[role] };
    }
    const lines = getMessages("refusemodhelp");
    return { key: "main", items: lines.map(line => ({ line, steps: data.TWISTS[line] || [] })) };
}

function take(chatId, key, items) {
    const line = draw(chatId, key, items.map(item => item.line));
    return items.find(item => item.line === line);
}

function savedTries(chatId) {
    return Number(getGroupSetting(chatId, "helpmenutries")) || 0;
}

function saveTries(chatId, count) {
    setGroupSetting(chatId, "helpmenutries", count);
}

function attempt(sock, msg, { chatId, senderJid, trusted, groupAdmin }) {
    if (getGroupSetting(chatId, "enablehelpmenu") === true) {
        reply(sock, msg, "enablehelpmenu is already true").catch(() => { });
        return { enable: false };
    }

    const cool = cooldowns.get(`${chatId}:${senderJid}`);
    if (cool && cool.until > Date.now()) {
        if (!cool.warned) {
            cool.warned = true;
            reply(sock, msg, "slow down.").catch(() => { });
        }
        return { enable: false };
    }

    const entries = loadDates();
    const today = singaporeToday();
    warnIfNoDatesLeft(entries, today);
    const holiday = holidayToday(entries, today);

    const token = cancel(chatId);
    const ctx = { sock, msg, chatId, senderJid, line: "", sentKey: null };
    const tries = savedTries(chatId) + 1;
    const role = trusted ? "trusted" : groupAdmin ? "admin" : "member";

    const won = tries >= PITY_TRIES || random() < (holiday ? HOLIDAY_WIN_CHANCE : WIN_CHANCE);
    if (won) {
        saveTries(chatId, 0);
        const items = tries >= PITY_TRIES ? data.PITY : data.WINS;
        const key = tries >= PITY_TRIES ? "pity" : "wins";
        const item = take(chatId, key, items);
        ctx.line = item.line;
        send(ctx, token, `${item.line}\nenablehelpmenu set to true`, item.steps, false);
        return { enable: true };
    }

    saveTries(chatId, tries);

    if (random() < FAKE_CHANCE) {
        const follow = draw(chatId, "fake", data.FAKE_FOLLOW_UPS);
        ctx.line = "enablehelpmenu set to true";
        send(ctx, token, "enablehelpmenu set to true", [{ at: 20, say: follow }], false);
        return { enable: false };
    }

    const pool = pickPool(chatId, role, holiday);
    const item = take(chatId, pool.key, pool.items);
    ctx.line = item.line;
    const steps = [...item.steps];
    if (data.STREAK[tries]) {
        steps.push({ at: 1, say: data.STREAK[tries] });
    }
    send(ctx, token, item.line, steps, random() < TYPING_CHANCE);
    return { enable: false };
}

function send(ctx, token, text, steps, typing) {
    const { sock, msg, chatId } = ctx;
    const state = groupState(chatId);
    (async () => {
        if (typing) {
            sock.sendPresenceUpdate("composing", chatId).catch(() => { });
            await sleep(3000 + Math.floor(random() * 5000));
            sock.sendPresenceUpdate("paused", chatId).catch(() => { });
            if (state.token !== token) {
                return;
            }
        }
        const sent = await reply(sock, msg, text);
        ctx.sentKey = sent?.key || null;
        schedule(ctx, token, steps);
    })().catch(error => log.error("helpmenu", "Could not send the reply:", error.message));
}

module.exports = { attempt, listen, parseDates, singaporeToday, holidayToday, draw, setRandom, reset };
