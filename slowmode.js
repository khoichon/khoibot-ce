
const { reply } = require("./utils.js");
const { getGroupSetting, setGroupSetting } = require("./config.js");

const MAX_SECONDS = 3600;

const lastSent = new Map();

function seconds(chatId) {
    const value = Number(getGroupSetting(chatId, "slowmode"));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function tooFast({ chatId, senderJid, trusted, groupAdmin }) {
    const wait = seconds(chatId);
    if (!wait || trusted || groupAdmin) {
        return false;
    }

    const key = `${chatId}|${senderJid}`;
    const now = Date.now();
    const last = lastSent.get(key) ?? 0;
    if (now - last < wait * 1000) {
        return true;
    }

    lastSent.set(key, now);
    if (lastSent.size > 5000) {
        for (const [oldKey, time] of lastSent) {
            if (now - time > MAX_SECONDS * 1000) {
                lastSent.delete(oldKey);
            }
        }
    }
    return false;
}

async function handleCommand(sock, msg, ctx) {
    const { chatId, text, isGroup, trusted, groupAdmin, commandPrefix } = ctx;
    const [name, ...rest] = text.trim().split(/\s+/);
    if (name.toLowerCase() !== "!slowmode") {
        return false;
    }

    if (!isGroup) {
        await reply(sock, msg, "Slowmode only works in groups.");
        return true;
    }
    if (!trusted && !groupAdmin) {
        await reply(sock, msg, "You need to be a group admin or trusted.");
        return true;
    }

    const argument = rest.join(" ").toLowerCase();
    if (!argument) {
        const current = seconds(chatId);
        await reply(sock, msg, current ? `Slowmode is on: one message every ${current} seconds.` : "Slowmode is off.");
        return true;
    }

    if (argument === "off") {
        setGroupSetting(chatId, "slowmode", 0);
        await reply(sock, msg, "Slowmode is off.");
        return true;
    }

    const value = /^\d+$/.test(argument) ? Number(argument) : NaN;
    if (!Number.isInteger(value) || value < 1 || value > MAX_SECONDS) {
        await reply(sock, msg, `Usage: ${commandPrefix}slowmode <1-${MAX_SECONDS} seconds|off>`);
        return true;
    }

    setGroupSetting(chatId, "slowmode", value);
    await reply(sock, msg, `Slowmode is on: one message every ${value} seconds. I can only delete the extra ones if I am an admin.`);
    return true;
}

module.exports = { handleCommand, tooFast };
