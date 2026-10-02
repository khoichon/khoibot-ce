function getText(message) {
    return (
        message?.conversation ??
        message?.extendedTextMessage?.text ??
        null
    );
}

function reply(sock, msg, text) {
    return sock.sendMessage(
        msg.key.remoteJid,
        { text },
        { quoted: msg }
    );
}

module.exports = {
    getText,
    reply
};