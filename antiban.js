// Anti-ban features. Everything is off unless ENABLE_ANTIBAN=1.

const fs = require("node:fs");
const path = require("node:path");

const { reply } = require("./utils.js");
const { log } = require("./logging.js");

const STATE_FILE = path.join(__dirname, "antiban-state.json");

function antibanEnabled() {
    return process.env.ENABLE_ANTIBAN === "1";
}

function numberSetting(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Read on every call so env changes apply without reloading the module.
function limits() {
    return {
        perMinute: Math.max(1, state.limits?.perMinute ?? numberSetting("ANTIBAN_MAX_PER_MINUTE", 20)),
        perHour: Math.max(1, state.limits?.perHour ?? numberSetting("ANTIBAN_MAX_PER_HOUR", 300)),
        pfpPerHour: Math.max(1, numberSetting("ANTIBAN_PFP_PER_HOUR", 30)),
        plotMaxExpressions: Math.max(1, numberSetting("ANTIBAN_PLOT_MAX_EXPRESSIONS", 10)),
        plotMaxChars: Math.max(1, numberSetting("ANTIBAN_PLOT_MAX_CHARS", 500)),
        cooldownMs: numberSetting("ANTIBAN_COMMAND_COOLDOWN", 3) * 1000,
        heavyCooldownMs: numberSetting("ANTIBAN_HEAVY_COOLDOWN", 10) * 1000,
        maxAgeSeconds: numberSetting("ANTIBAN_MAX_MESSAGE_AGE", 60),
        reconnectMaxMs: numberSetting("ANTIBAN_RECONNECT_MAX", 300) * 1000
    };
}

// A message that would wait longer than this for the rate limit is dropped.
const MAX_QUEUE_WAIT_MS = 120 * 1000;

// Commands that call outside services or use a lot of CPU.
const HEAVY_COMMANDS = new Set([
    "!tts", "!sticker", "!animsticker", "!edit", "!translate", "!wiki", "!define", "!fact", "!joke",
    "!summarise", "!plane", "!weather", "!scp", "!roast", "!compliment"
]);

// Commands with their own cooldown (seconds), changed with
// "!<command> setcooldown <seconds>". They replace the normal/heavy cooldown.
const COMMAND_COOLDOWN_DEFAULTS = { "!plot": 20, "!pfp": 30, "!whoami": 10, "!animsticker": 30 };

// A connection up this long resets the reconnect backoff.
const STABLE_CONNECTION_MS = 60 * 1000;

let clock = {
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
};


// ---------- Saved state (survives restarts) ----------

// messageDelay is { min, max } in seconds, or null for the default.
// cooldown is { normal, heavy } in seconds, or null for the default.
// commandCooldowns is { "!plot": seconds, ... } for the commands changed so far.
// limits is { perMinute, perHour } set with !antiban, or null for the env/defaults.
let state = { messageDelay: null, cooldown: null, cooldownOn: true, off: false, commandCooldowns: {}, limits: null };

function loadState() {
    try {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        if (saved && typeof saved === "object") {
            const delay = saved.messageDelay;
            if (
                delay &&
                Number.isFinite(delay.min) &&
                Number.isFinite(delay.max) &&
                delay.min >= 0 &&
                delay.max >= delay.min
            ) {
                state.messageDelay = { min: delay.min, max: delay.max };
            }
            const cd = saved.cooldown;
            if (cd && Number.isFinite(cd.normal) && Number.isFinite(cd.heavy) && cd.normal >= 0 && cd.heavy >= 0) {
                state.cooldown = { normal: cd.normal, heavy: cd.heavy };
            }
            if (saved.commandCooldowns && typeof saved.commandCooldowns === "object") {
                for (const name of Object.keys(COMMAND_COOLDOWN_DEFAULTS)) {
                    const value = saved.commandCooldowns[name];
                    if (Number.isFinite(value) && value >= 0) {
                        state.commandCooldowns[name] = value;
                    }
                }
            }
            const lim = saved.limits;
            if (lim && Number.isInteger(lim.perMinute) && Number.isInteger(lim.perHour) && lim.perMinute >= 1 && lim.perHour >= lim.perMinute) {
                state.limits = { perMinute: lim.perMinute, perHour: lim.perHour };
            }
            state.cooldownOn = saved.cooldownOn !== false;
            state.off = saved.off === true;
        }
    } catch (error) {
        if (error.code !== "ENOENT") {
            log.error("antiban", "Could not read antiban-state.json, starting fresh:", error);
        }
    }
}

// Temp file + rename so a crash cannot leave a half-written file.
function saveState() {
    try {
        const temp = `${STATE_FILE}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(state, null, 4), "utf8");
        fs.renameSync(temp, STATE_FILE);
    } catch (error) {
        log.error("antiban", "Failed to write antiban-state.json:", error);
    }
}

loadState();


// ---------- Message delay ----------

const MAX_DELAY_SECONDS = 30;

function defaultDelay() {
    const min = Number(process.env.MESSAGE_DELAY_DEFAULT_MIN);
    const max = Number(process.env.MESSAGE_DELAY_DEFAULT_MAX);
    if (
        process.env.MESSAGE_DELAY_DEFAULT_MIN !== undefined &&
        process.env.MESSAGE_DELAY_DEFAULT_MAX !== undefined &&
        Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min
    ) {
        return { min, max };
    }
    return { min: 1, max: 3 };
}

function currentDelay() {
    return state.messageDelay || defaultDelay();
}

function describeDelay(delay) {
    return delay.max === 0
        ? "off"
        : `${delay.min} to ${delay.max} seconds`;
}


// ---------- Rate limits ----------

// Send times from the last hour, oldest first.
const sentTimes = [];

function forgetOldSends(now) {
    while (sentTimes.length && sentTimes[0] <= now - 60 * 60 * 1000) {
        sentTimes.shift();
    }
}

// Waits for room under the limits and counts the message.
// Returns false if the message must be dropped.
async function takeSlot() {
    const base = limits();
    // risky times run slower so the limits shrink too
    const factor = riskFactor();
    const perMinute = Math.max(1, Math.floor(base.perMinute * factor));
    const perHour = Math.max(1, Math.floor(base.perHour * factor));
    const startedAt = clock.now();

    for (;;) {
        const now = clock.now();
        forgetOldSends(now);

        // The send that must expire first is the perMinute-th (perHour-th) most recent.
        let wait = 0;
        const lastMinute = sentTimes.filter(time => time > now - 60 * 1000);
        if (lastMinute.length >= perMinute) {
            wait = Math.max(wait, lastMinute[lastMinute.length - perMinute] + 60 * 1000 - now);
        }
        if (sentTimes.length >= perHour) {
            wait = Math.max(wait, sentTimes[sentTimes.length - perHour] + 60 * 60 * 1000 - now);
        }

        if (wait <= 0) {
            sentTimes.push(now);
            return true;
        }

        if (now - startedAt + wait > MAX_QUEUE_WAIT_MS) {
            log.warn("antiban", "A message was dropped because the rate limit did not free up in time.");
            return false;
        }
        await clock.sleep(wait + 50);
    }
}


// ---------- Plus features (ENABLE_ANTIBAN_PLUS=1) ----------

// the extra stuff, only on when ENABLE_ANTIBAN_PLUS=1. a health monitor, a thing that
// tweaks repeated messages, and a queue that cares about priority and retries.
// it all sits inside the send guard so ENABLE_ANTIBAN=1 has to be on too

function plusEnabled() {
    return antibanEnabled() && process.env.ENABLE_ANTIBAN_PLUS === "1";
}

// --- health monitor ---

// bad stuff from the last hour, each thing is worth some risk points
const HEALTH_WINDOW_MS = 60 * 60 * 1000;
const HEALTH_POINTS = { disconnect: 10, forbidden: 30, failed: 6 };
const healthEvents = [];
let lastRiskLevel = "low";

function recordHealth(kind) {
    if (!plusEnabled()) {
        return;
    }
    healthEvents.push({ kind, time: clock.now() });
    // peeking at the level also logs it if it just changed
    riskLevel();
}

// 0 to 100. old stuff drops off after an hour so it cools down on its own
function riskScore() {
    const cutoff = clock.now() - HEALTH_WINDOW_MS;
    while (healthEvents.length && healthEvents[0].time <= cutoff) {
        healthEvents.shift();
    }
    let score = 0;
    for (const event of healthEvents) {
        score += HEALTH_POINTS[event.kind] || 0;
    }
    return Math.min(100, score);
}

function riskLevel() {
    const score = riskScore();
    let level = "low";
    if (score >= 85) {
        level = "critical";
    } else if (score >= 60) {
        level = "high";
    } else if (score >= 30) {
        level = "medium";
    }

    if (level !== lastRiskLevel) {
        log.warn("antiban", `ban risk went from ${lastRiskLevel} to ${level} (score ${score}).`);
        lastRiskLevel = level;
    }
    return level;
}

// anything above low means half speed (double the delay, half the limits)
function riskFactor() {
    return plusEnabled() && riskLevel() !== "low" ? 0.5 : 1;
}

// high risk only lets the important stuff through, critical lets nothing through
function riskAllows(priority) {
    const level = riskLevel();
    if (level === "critical") {
        return false;
    }
    return level !== "high" || priority === "high";
}

// index.js yells this whenever the connection drops
function connectionClosed(statusCode) {
    recordHealth("disconnect");
    if (statusCode === 403) {
        recordHealth("forbidden");
    }
}

// --- content variator ---

// same text to the same chat again within 10 mins? give it a tiny makeover so it isnt identical
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const ZERO_WIDTH = ["\u200b", "\u200c", "\u2060"];
const recentTexts = new Map();

function wasSentRecently(jid, text, now) {
    const list = (recentTexts.get(jid) || []).filter(entry => now - entry.time < REPEAT_WINDOW_MS);
    recentTexts.set(jid, list);
    return list.some(entry => entry.text === text);
}

function rememberText(jid, text, now) {
    const list = recentTexts.get(jid) || [];
    list.push({ text, time: now });
    // dont need a long history
    if (list.length > 20) {
        list.shift();
    }
    recentTexts.set(jid, list);

    if (recentTexts.size > 500) {
        for (const [chat, entries] of recentTexts) {
            if (!entries.length || now - entries[entries.length - 1].time > REPEAT_WINDOW_MS) {
                recentTexts.delete(chat);
            }
        }
    }
}

// plain text only. mentions, links and @numbers get left alone so nothing breaks
function canVary(content) {
    return Boolean(
        content &&
        typeof content.text === "string" &&
        content.text.trim() &&
        !content.mentions?.length &&
        !content.edit && !content.react && !content.delete &&
        !/https?:\/\/|www\.|@\d{5,}/i.test(content.text)
    );
}

function varyText(text) {
    let out = text;

    // small tweak to the punctuation at the end
    if (out.endsWith(".") && Math.random() < 0.5) {
        out = out.slice(0, -1);
    } else if (out.endsWith("!") && Math.random() < 0.5) {
        out += "!";
    }

    // hide one or two invisible chars before a space (or at the end if theres no space)
    const count = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i++) {
        const invisible = ZERO_WIDTH[Math.floor(Math.random() * ZERO_WIDTH.length)];
        const spaces = [...out.matchAll(/ /g)].map(match => match.index);
        if (spaces.length) {
            const at = spaces[Math.floor(Math.random() * spaces.length)];
            out = out.slice(0, at) + invisible + out.slice(at);
        } else {
            out += invisible;
        }
    }
    return out;
}

// --- priorities ---

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const MAX_RETRIES = 2;

// replies to commands count as high, everything else is normal. if something can wait
// (like welcome messages) pass { priority: "low" } in the send options
function priorityOf(options) {
    if (Object.hasOwn(PRIORITY_RANK, options?.priority)) {
        return options.priority;
    }
    return options?.quoted ? "high" : "normal";
}

// baileys has no idea what priority is so dont hand it over
function withoutPriority(options) {
    if (!options || !("priority" in options)) {
        return options;
    }
    const { priority, ...rest } = options;
    return rest;
}

// ---------- Outgoing messages ----------
    
// Wraps sock.sendMessage: typing delay, rate limits, bot on/off. Messages to one
// chat stay in order. A dropped message resolves to undefined.
function installSendGuard(sock) {
    const original = sock.sendMessage.bind(sock);
    const queues = new Map();

    // Sends without the delay or rate limits. Used by !ping (so the timing is accurate) and by the !bot and !antiban replies.
    sock.sendMessageImmediate = original;

    // the plus queue. one per chat, most important first, retries if a send fails
    const plusQueues = new Map();
    let plusSeq = 0;

    function plusSend(jid, content, options, priority) {
        return new Promise((resolve, reject) => {
            let queue = plusQueues.get(jid);
            if (!queue) {
                queue = { items: [], running: false };
                plusQueues.set(jid, queue);
            }
            queue.items.push({ content, options, priority, seq: plusSeq++, queuedAt: clock.now(), resolve, reject });
            if (!queue.running) {
                queue.running = true;
                drainPlusQueue(jid, queue);
            }
        });
    }

    async function drainPlusQueue(jid, queue) {
        while (queue.items.length) {
            // most important first, then whoever got here first
            queue.items.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.seq - b.seq);
            const item = queue.items[0];

            if (!riskAllows(item.priority)) {
                // too risky right now so wait it out, but dont hold stuff forever
                const now = clock.now();
                queue.items = queue.items.filter(waiting => {
                    if (now - waiting.queuedAt <= MAX_QUEUE_WAIT_MS) {
                        return true;
                    }
                    log.warn("antiban", "a message was dropped because the ban risk stayed too high.");
                    waiting.resolve(undefined);
                    return false;
                });
                await clock.sleep(2000);
                continue;
            }

            queue.items.shift();
            try {
                item.resolve(await sendPlusItem(jid, item));
            } catch (error) {
                item.reject(error);
            }
        }
        queue.running = false;
        plusQueues.delete(jid);
    }

    async function sendPlusItem(jid, item) {
        const { min, max } = currentDelay();
        const slowdown = 1 / riskFactor();
        const waitMs = max > 0
            ? Math.round((min + Math.random() * (max - min)) * 1000 * slowdown)
            : 0;

        if (waitMs > 0) {
            try {
                await sock.sendPresenceUpdate("composing", jid);
            } catch {
                // presence is optional
            }
            await clock.sleep(waitMs);
            try {
                await sock.sendPresenceUpdate("paused", jid);
            } catch {
                // presence is optional
            }
        }

        // got turned off while this was waiting
        if (state.off) {
            return undefined;
        }

        if (!(await takeSlot())) {
            return undefined;
        }

        // same text in this chat again? shake it up a bit
        let content = item.content;
        if (canVary(content)) {
            const now = clock.now();
            if (wasSentRecently(jid, content.text, now)) {
                content = { ...content, text: varyText(content.text) };
            }
            rememberText(jid, item.content.text, now);
        }

        for (let attempt = 0; ; attempt++) {
            try {
                return await original(jid, content, item.options);
            } catch (error) {
                const closed = isClosedConnection(error);
                const forbidden = error?.output?.statusCode === 403;

                // closed connection is already counted as a disconnect, and a 403 wont fix itself by retrying
                if (closed || forbidden || attempt >= MAX_RETRIES) {
                    if (forbidden) {
                        recordHealth("forbidden");
                    }
                    if (!closed) {
                        recordHealth("failed");
                    }
                    throw error;
                }

                // wait longer each time, the resend uses up a rate limit slot too
                await clock.sleep(Math.round(2000 * 3 ** attempt * (0.8 + Math.random() * 0.4)));
                if (!(await takeSlot())) {
                    return undefined;
                }
            }
        }
    }

    sock.sendMessage = (jid, content, rawOptions) => {
        // priority is our thing, baileys doesnt need to see it :)
        const priority = priorityOf(rawOptions);
        const options = withoutPriority(rawOptions);

        const isDelete = Boolean(content && content.delete);
        const isEditOrReaction = Boolean(content && (content.edit || content.react || content.delete));

        // Deletes stay allowed while off so moderation still works.
        if (state.off && !isDelete) {
            return Promise.resolve(undefined);
        }

        // Edits, reactions and deletes are not new messages.
        if (isEditOrReaction) {
            return original(jid, content, options);
        }

        // plus mode has its own queue (priority, retries, risk checks)
        if (plusEnabled()) {
            return plusSend(jid, content, options, priority);
        }

        const { min, max } = currentDelay();
        const waitMs = max > 0
            ? Math.round((min + Math.random() * (max - min)) * 1000)
            : 0;

        const previous = queues.get(jid) || Promise.resolve();
        const run = previous.then(async () => {
            if (waitMs > 0) {
                try {
                    await sock.sendPresenceUpdate("composing", jid);
                } catch {
                    // presence is optional
                }
                await clock.sleep(waitMs);
                try {
                    await sock.sendPresenceUpdate("paused", jid);
                } catch {
                    // presence is optional
                }
            }

            // Turned off while this message was waiting.
            if (state.off) {
                return undefined;
            }

            if (!(await takeSlot())) {
                return undefined;
            }
            return original(jid, content, options);
        });

        // Keep the queue going even if this send fails.
        const tail = run.catch(() => {});
        queues.set(jid, tail);
        tail.then(() => {
            if (queues.get(jid) === tail) {
                queues.delete(jid);
            }
        });
        return run;
    };
}


// ---------- Closed connections ----------

function isClosedConnection(error) {
    return Boolean(
        error && (
            error.output?.statusCode === 428 ||
            /connection (closed|failure)/i.test(String(error.message))
        )
    );
}

// An unhandled "Connection Closed" from a send would crash the bot and PM2
// would restart it instantly (a crash loop). Other errors still crash.
let crashGuardInstalled = false;

function installCrashGuard() {
    if (crashGuardInstalled) {
        return;
    }
    crashGuardInstalled = true;

    process.on("unhandledRejection", error => {
        if (isClosedConnection(error)) {
            log.warn("antiban", "A send failed because the connection was closed, ignoring it:", error?.message);
            return;
        }
        throw error;
    });
}


// ---------- Reconnect backoff ----------

let reconnectAttempts = 0;
let connectedSince = null;

// Milliseconds to wait before reconnecting: 5s, 15s, 45s... up to the max,
// with +-20% jitter.
function reconnectDelay() {
    if (!antibanEnabled()) {
        return 0;
    }

    if (connectedSince !== null && clock.now() - connectedSince >= STABLE_CONNECTION_MS) {
        reconnectAttempts = 0;
    }
    connectedSince = null;

    reconnectAttempts++;
    const { reconnectMaxMs } = limits();
    const base = Math.min(reconnectMaxMs, 5000 * 3 ** (reconnectAttempts - 1));
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(Math.min(reconnectMaxMs, base * jitter));
}

function connectionOpened() {
    if (antibanEnabled()) {
        connectedSince = clock.now();
    }
}


// ---------- Hooks for index.js ----------

// True for old messages replayed after a reconnect.
function isStale(msg) {
    if (!antibanEnabled()) {
        return false;
    }

    const raw = msg?.messageTimestamp;
    if (raw === undefined || raw === null) {
        return false;
    }
    // Number or Long.
    const seconds = Number(typeof raw === "object" ? raw.toString() : raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return false;
    }

    return clock.now() / 1000 - seconds > limits().maxAgeSeconds;
}

const MAX_COOLDOWN_SECONDS = 600;
const MAX_PER_MINUTE = 60;
const MAX_PER_HOUR = 1000;

function currentCooldown() {
    if (state.cooldown) {
        return {
            cooldownMs: state.cooldown.normal * 1000,
            heavyCooldownMs: state.cooldown.heavy * 1000
        };
    }
    const { cooldownMs, heavyCooldownMs } = limits();
    return { cooldownMs, heavyCooldownMs };
}

const lastCommandAt = new Map();

// When each !pfp lookup went out in the last hour, for the global cap.
const pfpTimes = [];
let warnedPfpLimit = false;

function commandCooldownSeconds(name) {
    return state.commandCooldowns[name] ?? COMMAND_COOLDOWN_DEFAULTS[name];
}

// True if the command should be ignored silently (bot off, on cooldown, or
// over the !pfp cap). A "slow down" reply would just be another message.
// Cooldowns are per person across all chats. Trusted users are exempt.
function shouldIgnoreCommand({ text, trusted, senderJid }) {
    if (!antibanEnabled() || trusted) {
        return false;
    }

    const words = String(text).trim().split(/\s+/);
    const name = words[0].toLowerCase();
    if (!name.startsWith("!")) {
        return false;
    }

    if (state.off) {
        return true;
    }

    // Changing a cooldown is not a use of the command.
    if (Object.hasOwn(COMMAND_COOLDOWN_DEFAULTS, name) && (words[1] || "").toLowerCase() === "setcooldown") {
        return false;
    }

    const now = clock.now();

    if (state.cooldownOn) {
        let kind = "normal";
        let gap;
        if (Object.hasOwn(COMMAND_COOLDOWN_DEFAULTS, name)) {
            kind = name;
            gap = commandCooldownSeconds(name) * 1000;
        } else if (HEAVY_COMMANDS.has(name)) {
            kind = "heavy";
            gap = currentCooldown().heavyCooldownMs;
        } else {
            gap = currentCooldown().cooldownMs;
        }

        if (gap > 0) {
            const key = `${senderJid}|${kind}`;
            const last = lastCommandAt.get(key);
            if (last !== undefined && now - last < gap) {
                return true;
            }
            lastCommandAt.set(key, now);
            // Keep the map from growing forever.
            if (lastCommandAt.size > 2000) {
                for (const [oldKey, time] of lastCommandAt) {
                    if (now - time > 10 * 60 * 1000) {
                        lastCommandAt.delete(oldKey);
                    }
                }
            }
        }
    }

    // Global cap on profile picture lookups, across all users.
    if (name === "!pfp") {
        const { pfpPerHour } = limits();
        while (pfpTimes.length && pfpTimes[0] <= now - 60 * 60 * 1000) {
            pfpTimes.shift();
        }
        if (pfpTimes.length >= pfpPerHour) {
            if (!warnedPfpLimit) {
                warnedPfpLimit = true;
                log.warn("antiban", `The !pfp limit of ${pfpPerHour} lookups per hour has been reached. Further lookups are ignored until older ones expire.`);
            }
            return true;
        }
        warnedPfpLimit = false;
        pfpTimes.push(now);
    }

    return false;
}

// Returns a message if the !plot input is too big, otherwise null.
// Expressions are counted as lines or as =, <, > signs, whichever is larger,
// since several can share one line separated by commas.
function plotInputProblem(expression) {
    if (!antibanEnabled()) {
        return null;
    }
    const { plotMaxExpressions, plotMaxChars } = limits();
    const input = String(expression);
    const lines = input.split("\n").filter(line => line.trim()).length;
    const relations = (input.match(/[<>]=?|=/g) || []).length;
    if (input.length > plotMaxChars || Math.max(lines, relations) > plotMaxExpressions) {
        return `That expression is too large. The limit is ${plotMaxExpressions} expressions and ${plotMaxChars} characters.`;
    }
    return null;
}


// ---------- Commands ----------

// Replies that must go out even while the bot is off.
function sayNow(sock, msg, text) {
    const send = (sock.sendMessageImmediate ?? sock.sendMessage).bind(sock);
    return send(msg.key.remoteJid, { text }, { quoted: msg });
}

function argsOf(text) {
    return text.trim().replace(/^\S+\s*/, "");
}

// !messagedelay [set <min> <max> | reset] (viewing is open to everyone)
async function handleMessageDelay(sock, msg, { text, trusted, commandPrefix }) {
    const [sub, minArg, maxArg] = argsOf(text).split(/\s+/).filter(Boolean);
    const action = (sub || "").toLowerCase();

    if (!action) {
        const isDefault = !state.messageDelay;
        await reply(
            sock,
            msg,
            `Message delay: ${describeDelay(currentDelay())}${isDefault ? " (default)" : ""}.\n` +
            `Usage: ${commandPrefix}messagedelay set <min> <max> or ${commandPrefix}messagedelay reset`
        );
        return;
    }

    if (!trusted) {
        await reply(sock, msg, "Only trusted users may change the message delay.");
        return;
    }

    if (action === "reset") {
        state.messageDelay = null;
        saveState();
        await reply(sock, msg, `The message delay has been reset to the default: ${describeDelay(defaultDelay())}.`);
        return;
    }

    if (action === "set") {
        const min = Number(minArg);
        const max = Number(maxArg);
        if (
            minArg === undefined || maxArg === undefined ||
            !Number.isFinite(min) || !Number.isFinite(max) ||
            min < 0 || max < min || max > MAX_DELAY_SECONDS
        ) {
            await reply(sock, msg, `Usage: ${commandPrefix}messagedelay set <min> <max> (seconds, from 0 to ${MAX_DELAY_SECONDS}; the minimum cannot exceed the maximum)`);
            return;
        }

        state.messageDelay = { min, max };
        saveState();
        await reply(sock, msg, `The message delay has been set to ${describeDelay(state.messageDelay)}.`);
        return;
    }

    await reply(sock, msg, `Usage: ${commandPrefix}messagedelay [set <min> <max> | reset]`);
}

// !bot on|off
async function handleBot(sock, msg, { text, trusted, commandPrefix }) {
    if (!trusted) {
        await reply(sock, msg, "Only trusted users may use this command.");
        return;
    }

    const action = argsOf(text).toLowerCase();
    if (action !== "on" && action !== "off") {
        await sayNow(sock, msg, `The bot is ${state.off ? "off" : "on"}.\nUsage: ${commandPrefix}bot on or ${commandPrefix}bot off`);
        return;
    }

    const wantOff = action === "off";
    if (state.off === wantOff) {
        await sayNow(sock, msg, `The bot is already ${action}.`);
        return;
    }

    state.off = wantOff;
    saveState();
    await sayNow(
        sock,
        msg,
        wantOff
            ? `The bot is now off. No messages will be sent until a trusted user runs ${commandPrefix}bot on.`
            : "The bot is now on."
    );
}

function describeCooldown() {
    if (!state.cooldownOn) {
        return "off";
    }
    const { cooldownMs, heavyCooldownMs } = currentCooldown();
    return `${cooldownMs / 1000} seconds, or ${heavyCooldownMs / 1000} seconds for heavy commands`;
}

// !messagecooldown [<normal> <heavy> | on | off] (viewing is open to everyone)
async function handleMessageCooldown(sock, msg, { text, trusted, commandPrefix }) {
    const [first, second] = argsOf(text).split(/\s+/).filter(Boolean);
    const action = (first || "").toLowerCase();

    if (!action) {
        await reply(
            sock,
            msg,
            `Command cooldown: ${describeCooldown()}.\n` +
            `Usage: ${commandPrefix}messagecooldown <normal commands> <heavy commands> or ${commandPrefix}messagecooldown on|off`
        );
        return;
    }

    if (!trusted) {
        await reply(sock, msg, "Only trusted users may change the command cooldown.");
        return;
    }

    if (action === "on" || action === "off") {
        state.cooldownOn = action === "on";
        saveState();
        await reply(sock, msg, `The command cooldown is now ${action}.`);
        return;
    }

    const normal = Number(first);
    const heavy = Number(second);
    if (
        second === undefined ||
        !Number.isFinite(normal) || !Number.isFinite(heavy) ||
        normal < 0 || heavy < 0 ||
        normal > MAX_COOLDOWN_SECONDS || heavy > MAX_COOLDOWN_SECONDS
    ) {
        await reply(sock, msg, `Usage: ${commandPrefix}messagecooldown <normal commands> <heavy commands> (seconds, from 0 to ${MAX_COOLDOWN_SECONDS}) or ${commandPrefix}messagecooldown on|off`);
        return;
    }

    state.cooldown = { normal, heavy };
    saveState();
    await reply(sock, msg, `The command cooldown has been set to ${normal} seconds, or ${heavy} seconds for heavy commands.`);
}

// !antiban [banrisk | perminute <n> | perhour <n> | reset]
async function handleStatus(sock, msg, { text, trusted, commandPrefix }) {
    if (!trusted) {
        await reply(sock, msg, "Only trusted users may use this command.");
        return;
    }

    const [sub, value] = argsOf(text).split(/\s+/).filter(Boolean);
    const action = (sub || "").toLowerCase();

    if (action === "reset") {
        state.limits = null;
        saveState();
        const { perMinute, perHour } = limits();
        await sayNow(sock, msg, `The message limits have been restored to their defaults (${perMinute} per minute, ${perHour} per hour).`);
        return;
    }

    // just the ban risk line, nothing else phew
    if (action === "banrisk") {
        if (!plusEnabled()) {
            await sayNow(sock, msg, "Ban risk tracking is turned off. Set ENABLE_ANTIBAN_PLUS=1 to use it.");
            return;
        }
        await sayNow(sock, msg, `Ban risk: ${riskScore()}/100 (${riskLevel()})`);
        return;
    }

    if (action === "perminute" || action === "perhour") {
        const number = Number(value);
        const current = limits();
        const isMinute = action === "perminute";
        const max = isMinute ? Math.min(MAX_PER_MINUTE, current.perHour) : MAX_PER_HOUR;
        const min = isMinute ? 1 : current.perMinute;
        if (value === undefined || !Number.isInteger(number) || number < min || number > max) {
            await sayNow(sock, msg, `Usage: ${commandPrefix}antiban ${action} <number> (a whole number from ${min} to ${max})`);
            return;
        }

        state.limits = {
            perMinute: isMinute ? number : current.perMinute,
            perHour: isMinute ? current.perHour : number
        };
        saveState();
        await sayNow(sock, msg, `The ${isMinute ? "per-minute" : "per-hour"} message limit has been set to ${number}.`);
        return;
    }

    if (action) {
        await sayNow(sock, msg, `Usage: ${commandPrefix}antiban [banrisk | perminute <number> | perhour <number> | reset]`);
        return;
    }

    const { perMinute, perHour } = limits();
    const now = clock.now();
    forgetOldSends(now);
    const lastMinute = sentTimes.filter(time => time > now - 60 * 1000).length;
    const perCommand = Object.keys(COMMAND_COOLDOWN_DEFAULTS)
        .map(name => `${name} ${commandCooldownSeconds(name)} seconds`)
        .join(", ");

    await sayNow(sock, msg, [
        "Anti-ban status",
        `Bot: ${state.off ? "off" : "on"}`,
        `Message delay: ${describeDelay(currentDelay())}`,
        `Sent: ${lastMinute} in the last minute (limit ${perMinute}), ${sentTimes.length} in the last hour (limit ${perHour})`,
        ...(plusEnabled() ? [`Ban risk: ${riskScore()}/100 (${riskLevel()})`] : []),
        `Command cooldown: ${describeCooldown()}`,
        `Own cooldowns: ${perCommand}`
    ].join("\n"));
}

// !plot|!pfp|!whoami setcooldown [<seconds>]
// Returns true if it handled the message. Anything else is left to index.js.
async function handleCommandCooldown(sock, msg, { text, trusted, commandPrefix }) {
    const [name, sub, value] = text.trim().split(/\s+/);
    if ((sub || "").toLowerCase() !== "setcooldown") {
        return false;
    }

    const command = name.toLowerCase();
    const shown = `${commandPrefix}${command.slice(1)}`;

    if (value === undefined) {
        await reply(sock, msg, `The ${shown} cooldown is ${commandCooldownSeconds(command)} seconds.\nUsage: ${shown} setcooldown <seconds>`);
        return true;
    }

    if (!trusted) {
        await reply(sock, msg, "Only trusted users may change the command cooldown.");
        return true;
    }

    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_COOLDOWN_SECONDS) {
        await reply(sock, msg, `Usage: ${shown} setcooldown <seconds> (from 0 to ${MAX_COOLDOWN_SECONDS})`);
        return true;
    }

    state.commandCooldowns[command] = seconds;
    saveState();
    await reply(sock, msg, `The ${shown} cooldown has been set to ${seconds} seconds.`);
    return true;
}

const COMMANDS = {
    "!messagedelay": handleMessageDelay,
    "!bot": handleBot,
    "!messagecooldown": handleMessageCooldown,
    "!antiban": handleStatus
};

// Call once per socket (it is recreated on reconnect).
function init(sock) {
    if (!antibanEnabled()) {
        return;
    }

    installSendGuard(sock);
    installCrashGuard();
}

// Returns true if the message was one of the commands above.
async function handleCommand(sock, msg, ctx) {
    if (!antibanEnabled()) {
        return false;
    }

    const name = ctx.text.trim().split(/\s+/)[0].toLowerCase();
    if (Object.hasOwn(COMMAND_COOLDOWN_DEFAULTS, name)) {
        return handleCommandCooldown(sock, msg, ctx);
    }
    if (!Object.hasOwn(COMMANDS, name)) {
        return false;
    }

    await COMMANDS[name](sock, msg, ctx);
    return true;
}

module.exports = {
    init,
    handleCommand,
    isStale,
    shouldIgnoreCommand,
    plotInputProblem,
    reconnectDelay,
    connectionOpened,
    connectionClosed,
    antibanEnabled,

    // Tests only.
    _test: {
        setClock(newClock) { clock = newClock; },
        clearCounts() {
            sentTimes.length = 0;
        },
        reset() {
            state = { messageDelay: null, cooldown: null, cooldownOn: true, off: false, commandCooldowns: {}, limits: null };
            sentTimes.length = 0;
            lastCommandAt.clear();
            pfpTimes.length = 0;
            healthEvents.length = 0;
            lastRiskLevel = "low";
            recentTexts.clear();
            warnedPfpLimit = false;
            reconnectAttempts = 0;
            connectedSince = null;
        }
    }
};
