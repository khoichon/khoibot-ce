function getText(message) {
    return (
        message?.conversation ??
        message?.extendedTextMessage?.text ??
        null
    );
}

function reply(sock, msg, text) {
    return sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
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

const MAX_KEYS_KEPT = 250;
const keysByChat = new Map();

function rememberKey(chatId, key) {
    if (!chatId || !key?.id) {
        return;
    }
    const list = keysByChat.get(chatId) || [];
    if (list.some(saved => saved.id === key.id)) {
        return;
    }
    list.push({ remoteJid: key.remoteJid || chatId, fromMe: Boolean(key.fromMe), id: key.id, participant: key.participant });
    if (list.length > MAX_KEYS_KEPT) {
        list.shift();
    }
    keysByChat.set(chatId, list);
}

// the last count keys of a chat, oldest first
function recentKeys(chatId, count) {
    return (keysByChat.get(chatId) || []).slice(-count);
}

module.exports = {
    getText,
    reply,
    replyTemporary,
    rememberKey,
    recentKeys
};