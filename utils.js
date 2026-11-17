const { getGroupSetting } = require("./config.js");
const { drunkify } = require("./drunk.js");

function getText(message) {
    return (
        message?.conversation ??
        message?.extendedTextMessage?.text ??
        null
    );
}

function reply(sock, msg, text) {
    const chatId = msg.key.remoteJid;
    const drunk = chatId.endsWith("@g.us") && getGroupSetting(chatId, "drunkmode");
    return sock.sendMessage(
        chatId,
        { text: drunk ? drunkify(text) : text },
        { quoted: msg }
    );
}

// same as reply, but the bot deletes its own message again after a few seconds, 0 means it stays forever :/
async function replyTemporary(sock, msg, text, seconds) {
    const sent = await reply(sock, msg, text);
    // sent can be undefined when the antiban is off, then theres nothing to delete
    if (seconds > 0 && sent && sent.key) {
        setTimeout(() => {
            sock.sendMessage(msg.key.remoteJid, { delete: sent.key }).catch(() => {});
        }, seconds * 1000);
    }
    return sent;
}

module.exports = {
    getText,
    reply,
    replyTemporary
};