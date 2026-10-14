// remembers the last messages sent in each group so !summarise <number> has something to read.
// they get saved to chatlog-state.json (its in .gitignore) so a restart or a deploy doesnt wipe them.

const fs = require("node:fs");
const path = require("node:path");
const { log } = require("./logging.js");

const STATE_FILE = path.join(__dirname, "chatlog-state.json");

// most messages kept per group, which is also the most !summarise can ask for
const MAX_KEPT = 200;
// one really long message shouldnt take over the whole summary
const MAX_TEXT_LENGTH = 1000;
// the pi writes to an sd card, so wait a bit and save once instead of after every message
const SAVE_DELAY_MS = 10 * 1000;

const logs = new Map(); // chatId -> [{ name, text, time }]
let saveTimer = null;

function load() {
    try {
        const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        for (const [chatId, list] of Object.entries(saved)) {
            if (Array.isArray(list)) {
                logs.set(chatId, list.slice(-MAX_KEPT));
            }
        }
    } catch (error) {
        // no file yet is normal the first time
        if (error.code !== "ENOENT") {
            log.error("chatlog", "Could not read the saved messages:", error);
        }
    }
}

function save() {
    saveTimer = null;
    try {
        const temp = `${STATE_FILE}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(logs)));
        // rename it so a crash halfway through cant leave a broken file behind
        fs.renameSync(temp, STATE_FILE);
    } catch (error) {
        log.error("chatlog", "Could not save the messages:", error);
    }
}

function scheduleSave() {
    if (!saveTimer) {
        saveTimer = setTimeout(save, SAVE_DELAY_MS);
    }
}

function record(chatId, name, text) {
    const clean = String(text).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
    if (!clean) {
        return;
    }

    const list = logs.get(chatId) || [];
    list.push({ name: name || "Someone", text: clean, time: Date.now() });
    // only the newest ones are worth keeping
    if (list.length > MAX_KEPT) {
        list.splice(0, list.length - MAX_KEPT);
    }
    logs.set(chatId, list);
    scheduleSave();
}

// the last count messages, oldest first, one "name: message" per line
function recent(chatId, count) {
    const list = (logs.get(chatId) || []).slice(-count);
    return {
        count: list.length,
        text: list.map(entry => `${entry.name}: ${entry.text}`).join("\n")
    };
}

load();
// anything still waiting in the timer gets saved when the bot shuts down
process.on("exit", () => {
    if (saveTimer) {
        save();
    }
});

module.exports = { record, recent, MAX_KEPT };
