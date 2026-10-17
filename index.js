// simple baileys bot!!!

// libsignal dumps a whole session (keys and all spamming the logs which i hate) every time it swaps one, which floods the logs
// so we quietly drop those few lines and let everything else through
const noisySessionLines = ["Closing session:", "Opening session:", "Removing old closed session:", "Migrating session to:"];
const originalConsoleInfo = console.info.bind(console);
console.info = (...args) => {
    if (typeof args[0] === "string" && noisySessionLines.some(line => args[0].startsWith(line))) {
        return;
    }
    originalConsoleInfo(...args);
};

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("baileys");

const qrcode = require("qrcode-terminal");

const { getText, reply } = require("./utils.js");

const aitools = require("./aitools.js");
const chatlog = require("./chatlog.js");

const {
    isTrusted,
    addTrusted,
    removeTrusted,
    getTrusted,

    isGroupEnabled,
    enableGroup,
    disableGroup,
    getEnabledGroups,
    getConfigSnapshot,

    getGroupSettings,
    getGroupSetting,
    setGroupSetting
} = require("./config.js");

const games = require("./games.js");
const autoDeploy = require("./autodeploy.js");
const extras = require("./extras.js");
const antiban = require("./antiban.js");
const logging = require("./logging.js");
const { log } = logging;

const { isToxic } = require("./moderation.js");
const linkblock = require("./linkblock.js");

const { getWeather } = require("./get_weather.js");

const { 
    getCatPhoto,
    getDogPhoto,
    calculateEquation,
    sleep
} = require("./random-apis.js");

const {
    plot,
    parseExpression,
    evaluate
} = require("./mathplots.js")

const devMode = process.argv.includes("--dev");
const commandPrefix = devMode ? "t!" : "!";

function lowerCommandWord(text) {
    return text.startsWith("!") ? text.replace(/^\S+/, word => word.toLowerCase()) : text;
}
const path = require("node:path");
// ============================================================
// Welcome message
// ============================================================

async function sendWelcomeMessage(sock, groupId, participants, welcomeMsg) {
    for (const entry of participants) {
        // Baileys 7 sends objects ({ id, phoneNumber, ... }); !special welcome sends a string
        const participant = typeof entry === "string" ? entry : entry?.id;
        if (!participant) {
            continue;
        }
        const userId = participant.split("@")[0];
        await sock.sendMessage(
            groupId,
            {
                text: welcomeMsg.replace("[user]", `@${userId}`),
                mentions: [participant]
            },
            // welcome messages can wait if the ban risk goes up
            { priority: "low" }
        );
    }
}

// SCP
async function getSCP(scpNumber) {
    try {
        scpNumber = String(scpNumber)
            .trim()
            .replace(/^scp[-\s]*/i, "");

        if (!/^\d+$/.test(scpNumber)) {
            return "That SCP Item could not be found.";
        }

        const response = await fetch(
            `https://api.scpos.site/scrape?number=${encodeURIComponent(scpNumber)}`
        );

        if (!response.ok) {
            return "That SCP Item could not be found.";
        }

        const result = await response.json();

        if (
            result?.success !== true ||
            !result.data ||
            typeof result.data.name !== "string" ||
            typeof result.data.objectClass !== "string" ||
            !Array.isArray(result.data.containment) ||
            !Array.isArray(result.data.description) ||
            typeof result.data.url !== "string"
        ) {
            return "That SCP Item could not be found.";
        }

        const { name, objectClass, containment, description, url } = result.data;

        return `${name}
Class: ${objectClass}
${containment.join("\n")}

${description.slice(0, 3).join("\n")}

${url}`;
    } catch {
        return "That SCP Item could not be found.";
    }
}

// ============================================================
// Group admin check
// ============================================================

async function isGroupAdmin(sock, msg) {
    const chatId = msg.key.remoteJid;

    if (!chatId?.endsWith("@g.us")) {
        return false;
    }

    try {
        const metadata = await sock.groupMetadata(chatId);

        logging.rememberGroupName(chatId, metadata.subject);

        const senderPN = msg.key.participant;
        const senderLID = msg.key.participantAlt;

        const participant = metadata.participants.find(
            participant =>
                participant.id === senderPN ||
                participant.id === senderLID ||
                participant.jid === senderPN ||
                participant.jid === senderLID
        );

        if (!participant) {
            return false;
        }

        return (
            participant.admin === "admin" ||
            participant.admin === "superadmin"
        );

    } catch (error) {
        log.error("group",
            "Failed to get group metadata:",
            error
        );

        return false;
    }
}




// ============================================================
// Start socket
// ============================================================

const startSock = async () => {

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        path.join(__dirname, "auth")
    );


    // Group metadata cache. Without it Baileys asks WhatsApp for the member
    // list on every group send, which causes rate-overlimit (429) errors.
    const GROUP_CACHE_TTL_MS = 10 * 60 * 1000;
    const groupMetadataCache = new Map();

    const sock = makeWASocket({
        auth: state,
        cachedGroupMetadata: async (jid) => {
            const entry = groupMetadataCache.get(jid);
            if (entry && Date.now() - entry.time < GROUP_CACHE_TTL_MS) {
                return entry.metadata;
            }
            return undefined;
        }
    });

    const fetchGroupMetadata = sock.groupMetadata.bind(sock);
    sock.groupMetadata = async (jid) => {
        const entry = groupMetadataCache.get(jid);
        if (entry && Date.now() - entry.time < GROUP_CACHE_TTL_MS) {
            return entry.metadata;
        }
        const metadata = await fetchGroupMetadata(jid);
        groupMetadataCache.set(jid, { metadata, time: Date.now() });
        return metadata;
    };

    // Drop a group from the cache whenever it changes.
    sock.ev.on("groups.update", (updates) => {
        for (const update of updates) {
            groupMetadataCache.delete(update.id);
        }
    });
    sock.ev.on("group-participants.update", ({ id }) => {
        groupMetadataCache.delete(id);
    });

    // log what the bot sends back, so the console shows each reply under its command.
    // this has to run before antiban.init so the line shows up when the message really goes out.
    logging.watchReplies(sock);

    // Both only do anything when their env flag is set.
    antiban.init(sock);
    extras.init(sock);


    // ========================================================
    // Credentials
    // ========================================================

    sock.ev.on(
        "creds.update",
        saveCreds
    );


    // ========================================================
    // Connection
    // ========================================================

    sock.ev.on(
        "connection.update",
        (update) => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update;


            // ----------------------------
            // QR code
            // ----------------------------

            if (qr) {

                log.info("conn",
                    "\nScan this QR code with WhatsApp:\n"
                );

                qrcode.generate(
                    qr,
                    {
                        small: true
                    }
                );
            }


            // ----------------------------
            // Connection closed
            // ----------------------------

            if (connection === "close") {

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;


                // the health monitor wants to know about every drop
                antiban.connectionClosed(statusCode);

                const shouldReconnect =
                    statusCode !==
                    DisconnectReason.loggedOut;


                log.info("conn",
                    "Connection closed.",
                    lastDisconnect?.error
                );


                if (shouldReconnect) {

                    log.info("conn",
                        "Reconnecting..."
                    );

                    const waitMs = antiban.reconnectDelay();

                    if (waitMs > 0) {
                        log.info("conn",
                            `Waiting ${Math.round(waitMs / 1000)} seconds before reconnecting.`
                        );
                    }

                    setTimeout(startSock, waitMs);

                } else {

                    log.info("conn",
                        "Logged out."
                    );

                    log.info("conn",
                        "Delete the auth folder and restart to pair again."
                    );
                }
            }


            // ----------------------------
            // Connected
            // ----------------------------

            else if (connection === "open") {

                antiban.connectionOpened();
                // bring back any word or number games that were running before the restart
                games.restoreGames(sock);
                // checks github for new commits and restarts when there are some, if its turned on
                autoDeploy.start({ beforeRestart: games.saveGames });

                log.info("conn",
                    "Opened connection!"
                );
            }
        }
    );


    // ========================================================
    // helpers
    // ========================================================

    function normalizeUserJid(jid) {
        if (typeof jid !== "string") {
            return null;
        }

        const [user, server] = jid.split("@");
        if (!user || !server) {
            return null;
        }

        return `${user.split(":")[0]}@${server}`;
    }

    async function isBotAdmin(jid) {
        if (!jid || !jid.endsWith("@g.us")) {
            return false;
        }

        try {
            const groupMetadata = await sock.groupMetadata(jid);
            const botIds = [
                sock.user?.id,
                sock.user?.lid
            ].map(normalizeUserJid).filter(Boolean);

            const botParticipant = groupMetadata.participants.find((participant) => {
                const participantIds = [
                    participant.id,
                    participant.jid,
                    participant.lid,
                    participant.phoneNumber
                ].map(normalizeUserJid).filter(Boolean);

                return participantIds.some(id => botIds.includes(id));
            });

            return (
                botParticipant?.admin === "admin" ||
                botParticipant?.admin === "superadmin" ||
                botParticipant?.isAdmin === true ||
                botParticipant?.isSuperAdmin === true
            );
        } catch (error) {
            log.error("admin", "Failed to check bot admin status:", error);
            return false;
        }
    }

    function hasNodeTag(node, tag) {
        if (!node || typeof node !== "object") {
            return false;
        }

        if (node.tag === tag) {
            return true;
        }

        return Array.isArray(node.content) &&
            node.content.some(child => hasNodeTag(child, tag));
    }

    async function isBotInGroup(groupJid) {
        const participatingGroups = await sock.groupFetchAllParticipating();
        return Boolean(participatingGroups[groupJid]);
    }

    const communityHelperSessions = new Map();

    async function getCommunityGroups(groupJid) {
        const metadata = await sock.groupMetadata(groupJid);
        if (!metadata.isCommunity && !metadata.linkedParent) {
            throw new Error("The supplied chat is not a community or linked group.");
        }

        const result = await sock.communityFetchLinkedGroups(groupJid);
        return {
            communityJid: result.communityJid,
            linkedGroups: result.linkedGroups.filter(group => group.id)
        };
    }

    async function sendCommunityHelper(userJid, groupJid) {
        const {
            communityJid,
            linkedGroups
        } = await getCommunityGroups(groupJid);
        const participatingGroups = await sock.groupFetchAllParticipating();
        const participatingIds = new Set(Object.keys(participatingGroups));

        communityHelperSessions.set(userJid, {
            communityJid,
            groups: linkedGroups
        });

        const groupList = linkedGroups.length
            ? linkedGroups
                .map((group, index) => {
                    const status = participatingIds.has(group.id)
                        ? "joined"
                        : "not joined";
                    return `${index + 1}. ${group.subject || "(unnamed group)"} - ${status}`;
                })
                .join("\n")
            : "No linked groups found.";

        await sock.sendMessage(userJid, {
            text: [
                "Community group helper",
                `Community: ${communityJid}`,
                "",
                groupList,
                "",
                "Controls:",
                "!commhelper list",
                "!commhelper join <number>",
                "!commhelper leave <number>",
                "!commhelper exit",
                "",
                "Join uses the community link for the selected subgroup."
            ].join("\n")
        });
    }

    async function handleCommunityHelperCommand(msg, userJid, text) {
        const args = text.trim().split(/\s+/);
        const subcommand = args[1]?.toLowerCase();

        if (subcommand === "exit") {
            if (communityHelperSessions.delete(userJid)) {
                await reply(sock, msg, "Exited community helper mode.");
            } else {
                await reply(sock, msg, "No community helper session is active.");
            }
            return;
        }

        const session = communityHelperSessions.get(userJid);
        if (!session) {
            await reply(
                sock,
                msg,
                "No community helper session is active. Run !special commhelper in a community group first."
            );
            return;
        }

        const communityJid = session.communityJid;

        if (!subcommand || subcommand === "list") {
            await sendCommunityHelper(userJid, communityJid);
            return;
        }

        const {
            linkedGroups
        } = await getCommunityGroups(communityJid);

        if (subcommand === "join") {
            const groupNumber = Number(args[2]);
            const group = Number.isInteger(groupNumber)
                ? linkedGroups[groupNumber - 1]
                : undefined;

            if (!group) {
                await reply(sock, msg, "Usage: !commhelper join <number> (use !commhelper list)");
                return;
            }

            try {
                const result = await sock.query({
                    tag: "iq",
                    attrs: {
                        type: "set",
                        xmlns: "w:g2",
                        to: communityJid
                    },
                    content: [{
                        tag: "join_linked_group",
                        attrs: {
                            jid: group.id
                        }
                    }]
                });

                if (!result) {
                    await reply(
                        sock,
                        msg,
                        `Joining ${group.subject || group.id} timed out and could not be confirmed.`
                    );
                    return;
                }

                if (hasNodeTag(result, "membership_approval_request")) {
                    await reply(
                        sock,
                        msg,
                        `Join request sent for ${group.subject || group.id}; community approval is required.`
                    );
                    return;
                }

                let joined = false;
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    joined = await isBotInGroup(group.id);
                    if (joined) {
                        break;
                    }
                    await sleep(2000);
                }

                await reply(
                    sock,
                    msg,
                    joined
                        ? `Joined ${group.subject || group.id}.`
                        : `WhatsApp accepted the join request, but membership in ${group.subject || group.id} could not be confirmed.`
                );
            } catch (error) {
                log.error("group", "Error joining community group:", error);
                await reply(sock, msg, "Failed to join that community group.");
            }
            return;
        }

        if (subcommand === "leave") {
            const groupNumber = Number(args[2]);
            const group = Number.isInteger(groupNumber)
                ? linkedGroups[groupNumber - 1]
                : undefined;

            if (!group) {
                await reply(sock, msg, "Usage: !commhelper leave <number> (use !commhelper list)");
                return;
            }

            try {
                await sock.groupLeave(group.id);
                await reply(sock, msg, `Left ${group.subject || group.id}.`);
            } catch (error) {
                log.error("group", "Error leaving community group:", error);
                await reply(sock, msg, "Failed to leave that community group.");
            }
            return;
        }

        await reply(
            sock,
            msg,
            "Usage: !commhelper list | !commhelper join <number> | !commhelper leave <number> | !commhelper exit"
        );
    }

    // ========================================================
    // Welcome message
    // ========================================================

    sock.ev.on(
        "group-participants.update",
        async (update) => {

            const {
                id: groupId,
                participants,
                action
            } = update;

            if (action !== "add") {
                return;
            }

            if (!isGroupEnabled(groupId)) {
                return;
            }

            const welcomeMsgEnabled =
                getGroupSetting(
                    groupId,
                    "welcomeMsgEnabled"
                );

            if (!welcomeMsgEnabled) {
                return;
            }

            const welcomeMsgTemplate =
                getGroupSetting(
                    groupId,
                    "welcomeMsg"
                );
            // If the welcome message is not a string, default to a standard message.
            const welcomeMsg = typeof welcomeMsgTemplate === "string" ? welcomeMsgTemplate : "Welcome to the group, [user]!";

            await sendWelcomeMessage(sock, groupId, participants, welcomeMsg);
        }
    );

    // ========================================================
    // Messages
    // ========================================================

    sock.ev.on(
        "messages.upsert",
        async ({ messages }) => {

            for (const msg of messages) {

                if (!msg.message) {
                    continue;
                }

                if (msg.key.fromMe) {
                    continue;
                }

                // Old messages replayed after a reconnect.
                if (antiban.isStale(msg)) {
                    continue;
                }


                try {

                    // ====================================================
                    // Message text
                    // ====================================================

                    // An image sent with !sticker as its caption counts as a command too.
                    const receivedText =
                        getText(msg.message) ??
                        (extras.extraCommandsEnabled() ? extras.captionText(msg.message) : null);


                    if (!receivedText) {
                        continue;
                    }

                    if (devMode && receivedText.startsWith("!")) {
                        continue;
                    }

                    const text = lowerCommandWord(
                        devMode && receivedText.startsWith("t!")
                            ? `!${receivedText.slice(2)}`
                            : receivedText
                    );


                    // ====================================================
                    // Sender
                    // ====================================================

                    const senderPN =
                        msg.key.participant;

                    const senderLID =
                        msg.key.participantAlt;

                    const senderRemoteAlt =
                        msg.key.remoteJidAlt;


                    // ====================================================
                    // Chat
                    // ====================================================

                    const chatId =
                        msg.key.remoteJid;

                    const senderJid =
                        senderPN ||
                        senderLID ||
                        chatId;

                    // In direct messages WhatsApp does not set participant,
                    // so the sender is identified by remoteJid instead.
                    const trusted =
                        isTrusted(senderPN) ||
                        isTrusted(senderLID) ||
                        isTrusted(senderRemoteAlt) ||
                        isTrusted(chatId);

                    const isGroup =
                        chatId?.endsWith("@g.us");


                    // ====================================================
                    // Group admin
                    // ====================================================

                    const groupAdmin =
                        isGroup
                            ? await isGroupAdmin(
                                sock,
                                msg
                            )
                            : false;


                    // ====================================================
                    // Logging
                    // ====================================================

                    if (logging.betterLoggingEnabled()) {

                        console.log(
                            logging.formatMessage({ msg, text })
                        );

                    } else {

                        console.log(
                            `[${chatId}] ` +
                            `[${senderPN || senderLID}] ` +
                            `${text}`
                        );
                    }


                    // ====================================================
                    // Disabled group check
                    //
                    // Trusted users bypass this.
                    // ====================================================

                    // groups and dms both need to be switched on, trusted people dunt neeeds dis
                    const chatEnabled = isGroup
                        ? isGroupEnabled(chatId)
                        // dms can show up as a phone number or a lid, so we check every id we know for them
                        : [chatId, senderPN, senderLID, senderRemoteAlt].some(id => isGroupEnabled(id));

                    if (!chatEnabled && !trusted) {
                        continue;
                    }

                    // banned people can't play or run commands, but moderation still applies
                    // to them. trusted users can't be banned.
                    // force banned numbers are banned everywhere, even in dms
                    const banned = !trusted && ((isGroup && extras.isBanned(chatId, [senderPN, senderLID, senderRemoteAlt])) || extras.isForceBanned([senderPN, senderLID, senderRemoteAlt]));

                    if (!banned && await games.handleAnswer(sock, msg, { chatId, senderJid, text })) {
                        continue;
                    }


                    // ====================================================
                    // Anti-badword (ignores commands)
                    // ====================================================

                    if (
                        isGroup &&
                        (getGroupSetting(chatId, "antibadword") ||
                            getGroupSetting(chatId, "antibadwordnosay"))
                    ) {
                        // the nosay version deletes the message and never says a word in the chat
                        const noSay = getGroupSetting(chatId, "antibadwordnosay");

                        const currentBadwordlog = getGroupSetting(chatId, "badwordlog");

                        if (
                            !noSay &&
                            (currentBadwordlog === undefined ||
                            !["silent", "info", "debug"].includes(currentBadwordlog))
                        ) {
                            setGroupSetting(chatId, "badwordlog", "info");
                            await reply(
                                sock,
                                msg,
                                "Moderation defaulted to info because the group warning setting was missing or invalid."
                            );
                        }

                        try {

                            const result =
                                await isToxic(text,0.9);


                            if (result.toxic) {

                                log.info("mod",
                                    `Detected toxic message ` +
                                    `(${result.score})`
                                );

                                const botIsAdmin = await isBotAdmin(chatId);
                                const badwordreportEnabled = getGroupSetting(chatId, "antibadwordreport");
                                // debug logging, and nosay skips all of the replies below
                                if (noSay) {
                                    // stay quiet, the message just gets deleted
                                } else if (
                                    getGroupSetting(
                                        chatId,
                                        "badwordlog"
                                    ) === "debug"
                                ) {
                                    await reply(
                                    sock,
                                    msg,
                                    `${botIsAdmin ? "This message was deleted.": "" } Please be nice. ${badwordreportEnabled ? "(If you think it was a mistake please contact the group admin.)" : ""}
Debug:
${Object.entries(result.scores)
    .sort(([, a], [, b]) => b - a)
    .map(([name, score]) => `${name}: ${score}`)
    .join("\n")}`
                                );
                                } else if (
                                    getGroupSetting(
                                        chatId,
                                        "badwordlog"
                                    ) === "info"
                                ) {
                                    await reply(
                                    sock,
                                    msg,
                                    `${botIsAdmin ? "This message was deleted.": "" } Please be nice. ${badwordreportEnabled ? "(If you think it was a mistake please contact the group admin.)" : ""}
Toxicity score: ${result.score}`
                                );
                                } else if (
                                    getGroupSetting(
                                        chatId,
                                        "badwordlog"
                                    ) === "silent"
                                ) {
                                    await reply(
                                    sock,
                                    msg,
                                    `${botIsAdmin ? "This message was deleted.": "" } Please be nice. ${badwordreportEnabled ? "(If you think it was a mistake please contact the group admin.)" : ""}`
                                );
                                } else {
                                    log.error("mod",
                                        `Unknown badwordlog setting: ${getGroupSetting(chatId,"badwordlog")}`
                                    );
                                    await reply(
                                        sock,
                                        msg,
                                        `Something went horribly wrong with the moderation settings. Please contact the group admin.`
                                    )
                                }

                                if (botIsAdmin) {
                                    await sock.sendMessage(msg.key.remoteJid, {
                                        delete: msg.key
                                    });

                                    // a deleted message counts toward a warning, but only if the bot actually deleted it
                                    if (extras.extraCommandsEnabled()) {
                                        try {
                                            await extras.curseDeleted(sock, msg, { chatId, senderJid });
                                        } catch (error) {
                                            log.error("mod", "Could not give the curse warning:", error);
                                        }
                                    }
                                }

                                if (logging.betterLoggingEnabled()) {
                                    log.warn("mod",
                                        `${botIsAdmin ? "Deleted" : "Not deleted (bot is not an admin)"} ` +
                                        `(toxicity ${result.score}):`,
                                        logging.summarizeMessage({ msg, text })
                                    );
                                }
                                continue;
                                
                            }

                        } catch (error) {

                            log.error("mod",
                                "Moderation API error:",
                                error
                            );

                            // Fail open:
                            // If the moderation API is down,
                            // don't break the bot.
                        }
                    }

                    // ====================================================
                    // Link blocker
                    //
                    // deletes messages with links when disablelinking (or disablelinkingnosay) is on.
                    // linkblock.js decides what counts as a link
                    // ====================================================

                    if (
                        isGroup &&
                        (getGroupSetting(chatId, "disablelinking") ||
                        getGroupSetting(chatId, "disablelinkingnosay"))
                    ) {
                        const staff = trusted || groupAdmin;
                        // admins and trusted people can post links unless the group turned linkexempt off.
                        // their !mod commands always get through so nobody locks themselves out
                        const allowedToPost = staff && getGroupSetting(chatId, "linkexempt") !== false;
                        const modCommand = staff && /^!mod(\s|$)/.test(text);

                        if (!allowedToPost && !modCommand) {
                            try {
                                const blockedLink = await linkblock.findBlockedLink(text, {
                                    blocklist: getGroupSetting(chatId, "linkblocklist"),
                                    whitelist: getGroupSetting(chatId, "linkwhitelist")
                                });

                                if (blockedLink) {
                                    log.info("mod", `Detected a blocked link (${blockedLink})`);

                                    const botIsAdmin = await isBotAdmin(chatId);

                                    // no admin rights means no deleting, so just leave a note in the log
                                    if (botIsAdmin) {
                                        await sock.sendMessage(msg.key.remoteJid, {
                                            delete: msg.key
                                        });

                                        // the nosay version never says a word in the chat
                                        if (!getGroupSetting(chatId, "disablelinkingnosay")) {
                                            await reply(
                                                sock,
                                                msg,
                                                "That message was deleted because links are not allowed in this group."
                                            );
                                        }
                                    }

                                    if (logging.betterLoggingEnabled()) {
                                        log.warn("mod",
                                            `${botIsAdmin ? "Deleted" : "Not deleted (bot is not an admin)"} ` +
                                            `(link ${blockedLink}):`,
                                            logging.summarizeMessage({ msg, text })
                                        );
                                    }
                                    continue;
                                }
                            } catch (error) {
                                log.error("mod", "Link check error:", error);
                                // fail open: if the check breaks, dont break the bot
                            }
                        }
                    }

                    // moderation is done, so banned people stop here
                    if (banned) {
                        continue;
                    }

                    // keeps the latest messages of each group so !summarise <number> has something to read.
                    // commands are left out since nobody wants those in a summary
                    if (isGroup && !text.startsWith("!")) {
                        chatlog.record(chatId, msg.pushName, text);
                    }

                    // ====================================================
                    // Commands
                    // ====================================================

                    if (antiban.shouldIgnoreCommand({ text, trusted, senderJid, chatId })) {
                        continue;
                    }

                    if (await antiban.handleCommand(sock, msg, { text, trusted, commandPrefix })) {
                        continue;
                    }

                    if (await games.handleCommand(sock, msg, { chatId, senderJid, text, isGroup, trusted, commandPrefix })) {
                        continue;
                    }

                    if (await extras.handleCommand(sock, msg, { chatId, senderJid, text, isGroup, trusted, groupAdmin, commandPrefix })) {
                        continue;
                    }

                    // ----------------------------------------------------
                    // !summarise
                    // ----------------------------------------------------
                    
                    if (
                        text.startsWith("!summarise")
                    ) {

                        // "!summarise 50" with just a number summarises that many of the latest messages in the group
                        const countMatch = text.match(/^!summarise\s+(\d+)$/);
                        if (countMatch) {
                            if (!isGroup) {
                                await reply(sock, msg, "This command can only be used in a group.");
                                continue;
                            }

                            const wanted = Math.min(Number(countMatch[1]), chatlog.MAX_KEPT);
                            if (wanted < 1) {
                                await reply(sock, msg, `Please give a number between 1 and ${chatlog.MAX_KEPT}.`);
                                continue;
                            }

                            const { count, text: recentText } = chatlog.recent(chatId, wanted);
                            if (!count) {
                                await reply(sock, msg, "I haven't saved any messages in this group yet. I can only summarise messages that were sent while I was running.");
                                continue;
                            }

                            try {
                                // the summarizer only sees plain text, so say what kind of text it is
                                const summary = await aitools.summarizeText(`This is a group chat conversation, oldest message first. Each line is the sender's name and then their message.\n\n${recentText}`);
                                await reply(sock, msg, `Summary of the last ${count} ${count === 1 ? "message" : "messages"}:\n\n${summary}`);
                            } catch (error) {
                                log.error("ai", "Error summarizing the group messages:", error);
                                await reply(sock, msg, "Something went wrong while summarising the messages. Please try again later.");
                            }
                            continue;
                        }

                        // First, check if the message is a reply to another message, if it is, we will summarize the replied message instead of the command message itself.
                        let textToSummarize = text.slice("!summarise".length).trim();

                        if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                            const quotedMessage = msg.message.extendedTextMessage.contextInfo.quotedMessage;
                            textToSummarize = getText(quotedMessage);
                        }

                        if (!textToSummarize) {
                            await reply(
                                sock,
                                msg,
                                "Usage: !summarise <text>, reply to a message with !summarise, or use !summarise <number> to summarise the last messages in this group."
                            );
                            continue;
                        }

                        try {
                            const summary = await aitools.summarizeText(textToSummarize);
                            await reply(
                                sock,
                                msg,
                                summary
                            );
                        } catch (error) {
                            log.error("ai", "Error summarizing text:", error);
                            await reply(
                                sock,
                                msg,
                                "Something went wrong while summarizing the text. Please try again later."
                            );
                        }
                    }

                    // ----------------------------------------------------
                    // !ai
                    // ----------------------------------------------------
                    if (text === "!ai" || text.startsWith("!ai ")) {
                        try {
                            // chat answers already took ages to make, so no extra reply delay on top of that.
                            // personality and the other settings replies still wait like normal.
                            const firstWord = text.slice("!ai".length).trim().split(/\s+/)[0].toLowerCase();
                            // pictures have their own handler since the answer is an image, not text
                            if (firstWord === "imagine") {
                                await aitools.handleImagine(sock, msg, {
                                    chatId,
                                    trusted,
                                    argument: text.slice("!ai".length).trim().slice("imagine".length)
                                });
                                continue;
                            }
                            const isChat = firstWord && firstWord !== "personality" && firstWord !== "reset";
                            // show "typing..." while the model thinks. whatsapp drops it after a few seconds
                            // so we keep poking it until the answer is ready.
                            const sendPresence = (state) => Promise.resolve().then(() => sock.sendPresenceUpdate(state, msg.key.remoteJid)).catch(() => {});
                            let typingTimer = null;
                            if (isChat) {
                                sendPresence("composing");
                                typingTimer = setInterval(() => sendPresence("composing"), 8000);
                            }
                            let answer;
                            try {
                                answer = await aitools.handleAi(chatId, text.slice("!ai".length));
                            } finally {
                                if (typingTimer) {
                                    clearInterval(typingTimer);
                                    sendPresence("paused");
                                }
                            }
                            if (isChat && sock.sendMessageImmediate) {
                                await sock.sendMessageImmediate(msg.key.remoteJid, { text: answer }, { quoted: msg });
                            } else {
                                await reply(sock, msg, answer);
                            }
                        } catch (error) {
                            log.error("ai", "Error in !ai:", error);
                            await reply(sock, msg, "Something went wrong with the AI. Please try again later.");
                        }
                        continue;
                    }

                    // ----------------------------------------------------
                    // !help
                    // ----------------------------------------------------

                    else if (
                        text === "!help"
                    ) {
                        // only legacy khoibot users know the joke
                        await reply(
                            sock,
                            msg,
                            "What if I just... don't?"
                        );
                    }

                    // ----------------------------------------------------
                    // !ping
                    // ----------------------------------------------------

                    if (text === "!ping") {

                        // Skips the message delay, otherwise the delay would
                        // be what gets measured.
                        const sendNow = (sock.sendMessageImmediate ?? sock.sendMessage).bind(sock);
                        const startedAt = Date.now();

                        const sent = await sendNow(
                            chatId,
                            { text: "pong" },
                            { quoted: msg }
                        );

                        // Edit the ms in once the send has gone through.
                        try {
                            if (sent?.key) {
                                await sendNow(chatId, {
                                    text: `pong ${Date.now() - startedAt}ms`,
                                    edit: sent.key
                                });
                            }
                        } catch (error) {
                            log.error("cmd", "Could not add the ping time:", error);
                        }
                    }

                    // ----------------------------------------------------
                    // !ping BUT one letter is typed wrongly
                    // ----------------------------------------------------
                    // use regex?
                    const pingRegex = /^!(?:[a-hj-z]ing|p[a-mo-z]ng|pi[a-mo-z]g|pin[a-fh-z])$/;

                    if (pingRegex.test(text)) {
                        // MAKE SURE IT ISNT ping
                        if (text === "!ping") {
                            continue;
                        }
                        await reply(
                            sock,
                            msg,
                            `${text.slice(1)} 🥀`
                        );
                    }

                    // ----------------------------------------------------
                    // !alaganalexgizmotik22
                    // ----------------------------------------------------

                    if (text === "!alaganalexgizmotik22") {

                        await reply(
                            sock,
                            msg,
                            "wow this guy is so tuff am i right"
                        );
                    }

                    if (text === "!cat") {
                        const catlink = await getCatPhoto();
                        // check if catlink is a valid URL
                        try {
                            new URL(catlink);
                        } catch (error) {
                            log.error("cmd", "Invalid cat photo URL:", catlink);
                            await reply(
                                sock,
                                msg,
                                "Something went wrong while fetching the cat photo. Please try again later."
                            );
                            continue;
                        }

                        await sock.sendMessage(
                            chatId,
                            {
                                image: {
                                    url: catlink
                                },
                                caption: "meow"
                            },
                            {
                                quoted: msg
                            }
                        );
                    }

                    if (text === "!dog") {
                        const doglink = await getDogPhoto();
                        // check if doglink is a valid URL
                        try {
                            new URL(doglink);
                        } catch (error) {
                            log.error("cmd", "Invalid dog photo URL:", doglink);
                            await reply(
                                sock,
                                msg,
                                "Something went wrong while fetching the dog photo. Please try again later."
                            );
                            continue;
                        }

                        await sock.sendMessage(
                            chatId,
                            {
                                image: {
                                    url: doglink
                                },
                                caption: "woof"
                            },
                            {
                                quoted: msg
                            }
                        );
                    }



                    if (text.startsWith("!plane")) {
                        const keywords = text.slice("!plane".length).trim();

                        const url = new URL("http://127.0.0.1:8787/");
                        url.searchParams.set("page", "1");
                        url.searchParams.set("sort-order", "0");

                        if (keywords) {
                            url.searchParams.set("keywords", keywords);
                        }

                        const res = await fetch(url);
                        if (!res.ok) {
                            throw new Error(`Plane API returned HTTP ${res.status}`);
                        }

                        const data = await res.json();

                        if (!data.photos?.length) {
                            await sock.sendMessage(
                                chatId,
                                { text: "No planes found??" },
                                { quoted: msg }
                            );
                            continue;
                        }

                        const photo = data.photos[Math.floor(Math.random() * data.photos.length)];

                        await sock.sendMessage(
                            chatId,
                            {
                                image: {
                                    url: photo.imageUrl
                                },
                                caption: `${photo.registration} - ${photo.aircraftType}\n${photo.airline}`
                            },
                            {
                                quoted: msg
                            }
                        );
                    }


                    // ----------------------------------------------------
                    // !plot [silent] <expression>
                    // Plots the given mathematical expression and returns the image.
                    // ----------------------------------------------------
                    
                    else if (
                        text.startsWith("!plot ")
                    ) {
                        try {
                            const plotInput = text.slice(6).trim();
                            const silent = /^silent(?:\s+|$)/i.test(plotInput);
                            const expression = silent
                                ? plotInput.replace(/^silent\s+/i, "").trim()
                                : plotInput;
                            const tooLarge = antiban.plotInputProblem(expression);
                            if (tooLarge) {
                                await reply(sock, msg, tooLarge);
                                continue;
                            }

                            const imageData = await plot(expression);
                            // imageData is a buffer, we can send it as an image
                            await sock.sendMessage(
                                chatId,
                                {
                                    image: imageData,
                                    ...(silent ? {} : { caption: `Plot of: ${expression}` })
                                },
                                {
                                    quoted: msg
                                }
                            );
                        } catch (error) {
                            log.error("plot", "Error plotting expression:", error);
                            await reply(
                                sock,
                                msg,
                                "Something went wrong while plotting the expression. Please ensure it's a valid mathematical expression and try again.\n\nError details: " + error.message
                            );
                        }
                    }


                    // ----------------------------------------------------
                    // !whoami
                    // ----------------------------------------------------

                    else if (
                        text === "!whoami"
                    ) {

                        // Baileys 7 can put the LID in the participant field, so sort by suffix.
                        const whoamiIds = [senderPN, senderLID, senderRemoteAlt, chatId].filter(Boolean);
                        const whoamiPN = whoamiIds.find(id => id.endsWith("@s.whatsapp.net"));
                        const whoamiLID = whoamiIds.find(id => id.endsWith("@lid"));

                        await reply(
                            sock,
                            msg,
                            [
                                `PN: ${whoamiPN || "unknown"}`,
                                `LID: ${whoamiLID || "unknown"}`,
                                `Group: ${isGroup ? "yes" : "no"}`,
                                `Group ID: ${isGroup ? chatId : "N/A"}`,
                                `Trusted: ${trusted}`,
                                `Admin: ${groupAdmin}`
                            ].join("\n")
                        );
                    }

                    // ----------------------------------------------------
                    // !calc <expression>
                    // ----------------------------------------------------
                    
                    else if (
                        text.startsWith("!calc ")
                    ) {
                        log.info("calc", "Calculating expression:", text.slice(6).trim());
                        let expression = text.slice(6).trim();
                        // It will return a tuple of [result, error], where result is the calculated value or null if there was an error, and error is the error message or null if there was no error.
                        const [result, error] = calculateEquation(expression);
                        log.info("calc", "[CALC] After calculateEquation");
                        log.info("calc", "[CALC] result =", result);
                        log.info("calc", "[CALC] error =", error);
                        
                        if (error) {
                            await reply(
                                sock,
                                msg,
                                `Error: ${error}`
                            );
                        } else {
                            await reply(
                                sock,
                                msg,
                                `Result: ${result}`
                            );
                        }
                    }

                    // ----------------------------------------------------
                    // !weather <location>
                    // ----------------------------------------------------

                    else if (
                        text.startsWith("!weather")
                    ) {
                        const location = text.slice(8).trim();
                        if (!location) {
                            await reply(
                                sock,
                                msg,
                                "Usage: !weather <location>"
                            );
                            continue;
                        }

                        try {
                            const weatherInfo = await getWeather(location);
                            await reply(
                                sock,
                                msg,
                                weatherInfo
                            );
                        } catch (error) {
                            log.error("weather", "Error fetching weather:", error);
                            await reply(
                                sock,
                                msg,
                                "Something went wrong while fetching the weather. Please try again later."
                            );
                        }
                    }

                    // ----------------------------------------------------
                    // !trusted
                    // ----------------------------------------------------

                    else if (
                        text === "!trusted"
                    ) {

                        if (!trusted) {

                            await reply(
                                sock,
                                msg,
                                "You aren't trusted."
                            );

                            continue;
                        }


                        const users =
                            getTrusted();


                        await reply(
                            sock,
                            msg,
                            users.length
                                ? users.join("\n")
                                : "Nobody is trusted."
                        );
                    }


                    // ----------------------------------------------------
                    // !groups
                    // ----------------------------------------------------

                    else if (
                        text === "!groups"
                    ) {

                        if (!trusted) {

                            await reply(
                                sock,
                                msg,
                                "You aren't trusted."
                            );

                            continue;
                        }


                        const groups =
                            getEnabledGroups();


                        await reply(
                            sock,
                            msg,
                            groups.length
                                ? groups.join("\n")
                                : "No groups enabled."
                        );
                    }


                    // ----------------------------------------------------
                    // !enable
                    // ----------------------------------------------------

                    else if (
                        text === "!enable"
                    ) {

                        if (!trusted) {

                            await reply(
                                sock,
                                msg,
                                "You aren't trusted."
                            );

                            continue;
                        }


                        if (!isGroup) {

                            await reply(
                                sock,
                                msg,
                                "You must be in a group to use this command."
                            );

                            continue;
                        }


                        const changed =
                            enableGroup(chatId);


                        await reply(
                            sock,
                            msg,
                            changed
                                ? "Group enabled."
                                : "ℹGroup was already enabled."
                        );
                    }


                    // ----------------------------------------------------
                    // !disable
                    // ----------------------------------------------------

                    else if (
                        text === "!disable"
                    ) {

                        if (!trusted) {

                            await reply(
                                sock,
                                msg,
                                "You aren't trusted."
                            );

                            continue;
                        }


                        if (!isGroup) {

                            await reply(
                                sock,
                                msg,
                                "You must be in a group to use this command."
                            );

                            continue;
                        }


                        const changed =
                            disableGroup(chatId);


                        await reply(
                            sock,
                            msg,
                            changed
                                ? "Group disabled."
                                : "Group was already disabled."
                        );
                    }


                    // ----------------------------------------------------
                    // !toggle
                    // turns the bot on in this group if its off, and off if its on. same as !enable and !disable in one command
                    // ----------------------------------------------------

                    else if (text === "!toggle") {
                        if (!trusted) {
                            await reply(sock, msg, "You aren't trusted.");
                            continue;
                        }

                        if (!isGroup) {
                            await reply(sock, msg, "You must be in a group to use this command.");
                            continue;
                        }

                        if (isGroupEnabled(chatId)) {
                            disableGroup(chatId);
                            await reply(sock, msg, "Group disabled.");
                        } else {
                            enableGroup(chatId);
                            await reply(sock, msg, "Group enabled.");
                        }
                    }

                    // ----------------------------------------------------
                    // !trust <PN/LID>
                    // ----------------------------------------------------

                    else if (
                        text.startsWith("!trust ")
                    ) {

                        if (!trusted) {

                            await reply(
                                sock,
                                msg,
                                "You aren't trusted."
                            );

                            continue;
                        }


                        // A mention gives the full ID. The typed @text would never match.
                        const identifier =
                            msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                            text
                                .slice(7)
                                .trim();


                        if (!identifier) {

                            await reply(
                                sock,
                                msg,
                                "Usage: !trust <PN/LID>"
                            );

                            continue;
                        }


                        const changed =
                            addTrusted(identifier);


                        await reply(
                            sock,
                            msg,
                            changed
                                ? `Added ${identifier} to trusted users.`
                                : `${identifier} is already trusted.`
                        );
                    }


                    // ----------------------------------------------------
                    // !untrust <PN/LID>
                    // ----------------------------------------------------

                    else if (
                        text.startsWith("!untrust ")
                    ) {

                        if (!trusted) {

                            await reply(
                                sock,
                                msg,
                                "You aren't trusted."
                            );

                            continue;
                        }


                        // A mention gives the full ID. The typed @text would never match.
                        const identifier =
                            msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                            text
                                .slice(9)
                                .trim();


                        if (!identifier) {

                            await reply(
                                sock,
                                msg,
                                "Usage: !untrust <PN/LID>"
                            );

                            continue;
                        }


                        const changed =
                            removeTrusted(identifier);


                        await reply(
                            sock,
                            msg,
                            changed
                                ? `Removed ${identifier} from trusted users.`
                                : `${identifier} wasn't trusted.`
                        );
                    }

                    // -----------------------------------------------------
                    // !scp <number>
                    // -----------------------------------------------------
                    
                    if (
                        text.startsWith("!scp ")
                    ) {
                        const scpNumber =
                            text
                                .slice(5)
                                .trim();

                        if (!scpNumber) {

                            await reply(
                                sock,
                                msg,
                                "Usage: !scp <number>"
                            );

                            continue;
                        }

                        const scpData =
                            await getSCP(scpNumber);

                        await reply(
                            sock,
                            msg,
                            scpData
                        );
                    }


                   

                    // ----------------------------------------------------
                    // !pfp [@user | phone number]
                    // Sends the profile picture of the user
                    // ----------------------------------------------------

                    if (text.startsWith('!pfp')) {
                        const contextInfo =
                            msg.message?.extendedTextMessageMessage?.contextInfo ||
                            msg.message?.extendedTextMessage?.contextInfo ||
                            msg.message?.imageMessage?.contextInfo;

                        const mentionedJid = contextInfo?.mentionedJid?.[0];

                        // Get everything after "!pfp"
                        const argument = text.slice('!pfp'.length).trim();

                        let targetJid;
                        let usedDefault = false;

                        if (mentionedJid) {
                            // !pfp @user
                            targetJid = mentionedJid;
                        } else if (argument.replace(/[\s()+-]/g, '').length > 0 && /^\+?[\d\s()-]+$/.test(argument)) {
                            // !pfp 6591234567 / +65 9123 4567 / 65-9123-4567 / (65) 9123 4567
                            const digitsOnly = argument.replace(/\D/g, '');

                            try {
                                const [result] = await sock.onWhatsApp(digitsOnly);
                                if (result?.exists) {
                                    targetJid = result.jid; // canonical JID (LID or PN) resolved by WhatsApp
                                } else {
                                    await reply(sock, msg, `No WhatsApp account found for ${argument}.`);
                                    continue;
                                }
                            } catch (err) {
                                log.error("pfp", '!pfp onWhatsApp resolve error:', err);
                                await reply(sock, msg, "Could not resolve that number.");
                                continue;
                            }
                        } else {
                            // !pfp with no argument -> sender
                            targetJid =
                                msg.key.participant ||
                                msg.key.remoteJid;
                            usedDefault = true;
                        }

                        log.info("pfp", '!pfp target:', targetJid);

                        try {
                            const pfpUrl = await sock.profilePictureUrl(
                                targetJid,
                                'image'
                            );

                            await sock.sendMessage(
                                msg.key.remoteJid,
                                {
                                    image: { url: pfpUrl },
                                    caption: usedDefault
                                        ? "No user or number specified — showing your own profile picture."
                                        : "Profile picture of " + targetJid, // show their PN or LID if available
                                },
                                {
                                    quoted: msg
                                }
                            );
                        } catch (err) {
                            log.error("pfp", '!pfp error:', err);

                            await reply(
                                sock,
                                msg,
                                "Could not fetch profile picture."
                            );
                        }
                    }

                    // ----------------------------------------------------
                    // !mod
                    // ----------------------------------------------------

                    else if (
                        text === "!mod" ||
                        text.startsWith("!mod ")
                    ) {

                        // Trusted users OR group admins
                        if (
                            !trusted &&
                            !groupAdmin
                        ) {

                            await reply(
                                sock,
                                msg,
                                "You need to be a group admin or trusted."
                            );

                            continue;
                        }


                        // !mod dmtoggle <number> toggles commands on or off for one dm, works from any chat
                        const modArgs = text.trim().split(/\s+/);
                        if (modArgs[1] === "dmtoggle") {
                            // group admins get past the check above so this one is trusted only
                            if (!trusted) {
                                await reply(sock, msg, "You aren't trusted.");
                                continue;
                            }

                            const number = modArgs.slice(2).join("").replace(/\D/g, "");
                            if (!number) {
                                await reply(sock, msg, "Usage: !mod dmtoggle <number>");
                                continue;
                            }

                            const dmId = number + "@s.whatsapp.net";
                            if (isGroupEnabled(dmId)) {
                                disableGroup(dmId);
                                await reply(sock, msg, "Commands are now disabled in the DM with " + number + ".");
                            } else {
                                enableGroup(dmId);
                                await reply(sock, msg, "Commands are now enabled in the DM with " + number + ".");
                            }
                            continue;
                        }


                        if (!isGroup) {

                            await reply(
                                sock,
                                msg,
                                "!mod can only be used in groups."
                            );

                            continue;
                        }


                        const args =
                            text
                                .trim()
                                .split(/\s+/);


                        // ----------------------------
                        // !mod
                        // ----------------------------

                        if (args.length === 1) {

                            const antibadword =
                                getGroupSetting(
                                    chatId,
                                    "antibadword"
                                );
                            const badwordlog =
                                getGroupSetting(
                                    chatId,
                                    "badwordlog"
                                );


                            // the welcome message can be really long, so the menu only shows the start of it
                            const welcome = String(getGroupSetting(chatId, "welcomeMsg")).replace(/\s+/g, " ").trim();
                            const shortWelcome = welcome.length > 30 ? `${welcome.slice(0, 30).trimEnd()}...` : welcome;

                            await reply(
                                sock,
                                msg,
                                [
                                    "Mod configuration",
                                    "",
                                    "AntiBadWord",
                                    `  antibadword: ${antibadword}  (true|false)`,
                                    `  antibadwordnosay: ${getGroupSetting(chatId, "antibadwordnosay")}  (true|false)`,
                                    `  antibadwordreport: ${getGroupSetting(chatId, "antibadwordreport")}  (true|false)`,
                                    `  badwordlog: ${badwordlog}  (silent|info|debug)`,
                                    "",
                                    "Welcome",
                                    `  welcomeMsgEnabled: ${getGroupSetting(chatId, "welcomeMsgEnabled")}  (true|false)`,
                                    `  welcomeMsg: ${shortWelcome}  (string)`,
                                    "",
                                    "Games",
                                    `  gamesenabled: ${getGroupSetting(chatId, "gamesenabled")}  (true|false)`,
                                    "",
                                    "Links",
                                    `  disablelinking: ${getGroupSetting(chatId, "disablelinking")}  (true|false)`,
                                    `  disablelinkingnosay: ${getGroupSetting(chatId, "disablelinkingnosay")}  (true|false)`,
                                    `  linkblocklist: ${(getGroupSetting(chatId, "linkblocklist") || []).join(", ") || "empty"}  (add|remove|clear <domain>)`,
                                    `  linkwhitelist: ${(getGroupSetting(chatId, "linkwhitelist") || []).join(", ") || "empty"}  (add|remove|clear <domain>)`,
                                    `  linkexempt: ${getGroupSetting(chatId, "linkexempt")}  (true|false)`,
                                    "",
                                    "Warnings",
                                    `  warntoggle: ${getGroupSetting(chatId, "warntoggle")}  (true|false)`,
                                    `  warnlimit: ${getGroupSetting(chatId, "warnlimit")}  (1-20)`,
                                    `  warnaction: ${getGroupSetting(chatId, "warnaction").join(" ")}  (kick, ban [duration] and notify, in any mix)`,
                                    `  warnexpiry: ${getGroupSetting(chatId, "warnexpiry")}  (days, 0 for never)`,
                                    `  warncurses: ${extras.curseSettings(chatId).limit}  (0-50, 0 for off)`,
                                    `  warncursestime: ${extras.curseSettings(chatId).minutes}  (minutes, 1-60)`,
                                    "",
                                    "To update: !mod <key> <value>",
                                    "Extra: !mod test checks whether the bot is a group admin.",
                                    "Trusted only: !mod dmtoggle <number> turns commands on or off for one DM."
                                ].join("\n")
                            );

                            continue;
                        }

                        if (args[1] === "test") {
                            const botAdmin = await isBotAdmin(chatId);
                            await reply(
                                sock,
                                msg,
                                botAdmin
                                    ? "I am a group admin."
                                    : "I am not a group admin."
                            );
                            continue;
                        }


                        // ----------------------------
                        // !mod antibadword
                        // ----------------------------

                        const setting =
                            args[1];


                        if (
                            setting === "antibadword"
                        ) {

                            // Show current value
                            if (args.length === 2) {

                                const value =
                                    getGroupSetting(
                                        chatId,
                                        "antibadword"
                                    );


                                await reply(
                                    sock,
                                    msg,
                                    `antibadword is currently ${value}`
                                );

                                continue;
                            }


                            const value =
                                args[2]
                                    .toLowerCase();


                            if (
                                value !== "true" &&
                                value !== "false"
                            ) {

                                await reply(
                                    sock,
                                    msg,
                                    "Usage: !mod antibadword <true|false>"
                                );

                                continue;
                            }


                            const enabled =
                                value === "true";


                            setGroupSetting(
                                chatId,
                                "antibadword",
                                enabled
                            );


                            await reply(
                                sock,
                                msg,
                                `antibadword set to ${enabled}`
                            );

                            continue;
                        }

                        // ----------------------------
                        // !mod antibadwordnosay <true|false>
                        // same as antibadword, but the bot never says anything, it only deletes
                        // ----------------------------

                        if (setting === "antibadwordnosay") {

                            // Show current value
                            if (args.length === 2) {

                                await reply(
                                    sock,
                                    msg,
                                    "antibadwordnosay is currently " + getGroupSetting(chatId, "antibadwordnosay")
                                );

                                continue;
                            }

                            const value = args[2].toLowerCase();

                            if (value !== "true" && value !== "false") {

                                await reply(
                                    sock,
                                    msg,
                                    "Usage: !mod antibadwordnosay <true|false>"
                                );

                                continue;
                            }

                            const enabled = value === "true";

                            setGroupSetting(chatId, "antibadwordnosay", enabled);

                            await reply(
                                sock,
                                msg,
                                enabled
                                    ? "antibadwordnosay set to true. Toxic messages get deleted and the bot stays quiet about it."
                                    : "antibadwordnosay set to false"
                            );

                            continue;
                        }

                        // ----------------------------
                        // !mod badwordlog <silent|info|debug>
                        // default: info
                        // This controls the logging level for bad word detection sent in the whatsapp message. It can be set to silent, info, or debug. Silent means no logging, info means basic logging (only the toxic percentage), and debug means detailed logging (all percentage, the old code).
                        // ----------------------------
                        
                        if (args[1] === "badwordlog") {
                            // Show current value
                            if (args.length === 2) {
                                const value = getGroupSetting(chatId, "badwordlog");
                                await reply(sock, msg, `badwordlog is currently ${value}`);
                                continue;
                            }

                            const value = args[2].toLowerCase();
                            if (!["silent", "info", "debug"].includes(value)) {
                                await reply(sock, msg, "Usage: !mod badwordlog <silent|info|debug>");
                                continue;
                            }

                            setGroupSetting(chatId, "badwordlog", value);
                            await reply(sock, msg, `badwordlog set to ${value}`);
                            continue;
                        }

                        // Welcome message stuff
                        if (args[1] === "welcomeMsgEnabled") {
                            // Show current value
                            if (args.length === 2) {
                                const value = getGroupSetting(chatId, "welcomeMsgEnabled");
                                await reply(sock, msg, `welcomeMsgEnabled is currently ${value}`);
                                continue;
                            }
                            // Set new value
                            const value = args[2].toLowerCase();
                            if (!["true", "false"].includes(value)) {
                                await reply(sock, msg, "Usage: !mod welcomeMsgEnabled <true|false>");
                                continue;
                            }
                            setGroupSetting(chatId, "welcomeMsgEnabled", value === "true");
                            await reply(sock, msg, `welcomeMsgEnabled set to ${value}`);
                            continue;
                        }

                        if (args[1] === "welcomeMsg") {
                            // Show current value
                            if (args.length === 2) {
                                const value = getGroupSetting(chatId, "welcomeMsg");
                                await reply(sock, msg, `welcomeMsg is currently ${value}`);
                                continue;
                            }
                            // Set new value
                            const welcomeMsgIndex = text.indexOf(args[1]);
                            const value = text
                                .slice(welcomeMsgIndex + args[1].length)
                                .replace(/^[ \t]+/, "")
                                .replace(/^\r?\n/, "");
                            setGroupSetting(chatId, "welcomeMsg", value);
                            await reply(sock, msg, `welcomeMsg set to ${value}`);
                            continue;
                        }

                        // !mod gamesenabled <true|false> - Enable or disable games in this group
                        if (args[1]?.toLowerCase() === "gamesenabled") {
                            // Show current value
                            if (args.length === 2) {
                                const value = getGroupSetting(chatId, "gamesenabled");
                                await reply(sock, msg, `gamesenabled is currently ${value}`);
                                continue;
                            }
                            // Set new value
                            const value = args[2].toLowerCase();
                            if (!["true", "false"].includes(value)) {
                                await reply(sock, msg, "Usage: !mod gamesenabled <true|false>");
                                continue;
                            }
                            setGroupSetting(chatId, "gamesenabled", value === "true");
                            await reply(sock, msg, `gamesenabled set to ${value}`);
                            continue;
                        }

                        // the link rules in plain words, sent after link blocking gets turned on
                        const describeLinkRules = async () => {
                            const blocklist = getGroupSetting(chatId, "linkblocklist") || [];
                            return [
                                blocklist.length > 0
                                    ? "Only domains in linkblocklist are blocked."
                                    : "Every domain is blocked, except the ones in linkwhitelist.",
                                (await isBotAdmin(chatId))
                                    ? ""
                                    : "The bot is not a group admin yet, so it cannot delete anything until it is made one."
                            ].filter(Boolean).join("\n");
                        };

                        // ----------------------------
                        // !mod disablelinking <true|false> and !mod disablelinkingnosay <true|false>
                        // deletes messages with links in them, linkblock.js decides what counts as a link.
                        // the nosay one never says a word in the chat
                        // ----------------------------

                        if (["disablelinking", "disablelinkingnosay"].includes(setting.toLowerCase())) {
                            const key = setting.toLowerCase();

                            // Show current value
                            if (args.length === 2) {
                                await reply(sock, msg, `${key} is currently ${getGroupSetting(chatId, key)}`);
                                continue;
                            }

                            const value = args[2].toLowerCase();
                            if (!["true", "false"].includes(value)) {
                                await reply(sock, msg, `Usage: !mod ${key} <true|false>`);
                                continue;
                            }

                            setGroupSetting(chatId, key, value === "true");

                            if (value === "false") {
                                await reply(
                                    sock,
                                    msg,
                                    key === "disablelinking"
                                        ? "disablelinking set to false. Links are allowed again."
                                        : "disablelinkingnosay set to false"
                                );
                                continue;
                            }

                            await reply(
                                sock,
                                msg,
                                [
                                    key === "disablelinking"
                                        ? "disablelinking set to true. Messages with links will be deleted."
                                        : "disablelinkingnosay set to true. Messages with links get deleted and the bot stays quiet about it.",
                                    await describeLinkRules()
                                ].join("\n")
                            );
                            continue;
                        }

                        // ----------------------------
                        // !mod linkblocklist and !mod linkwhitelist <add|remove|clear> <domains>
                        // the whitelist is the exceptions list, those domains are never blocked
                        // ----------------------------

                        if (["linkblocklist", "linkwhitelist"].includes(setting.toLowerCase())) {
                            const listName = setting.toLowerCase();
                            const current = getGroupSetting(chatId, listName) || [];
                            const action = args[2]?.toLowerCase();

                            // no action just shows the list
                            if (!action) {
                                await reply(sock, msg, current.length ? `${listName}: ${current.join(", ")}` : `${listName} is empty`);
                                continue;
                            }

                            if (action === "clear") {
                                setGroupSetting(chatId, listName, []);
                                await reply(sock, msg, `${listName} cleared`);
                                continue;
                            }

                            const wanted = args.slice(3);
                            if ((action !== "add" && action !== "remove") || wanted.length === 0) {
                                await reply(sock, msg, `Usage: !mod ${listName} <add|remove|clear> <domain>`);
                                continue;
                            }

                            const next = [...current];
                            const done = [];
                            const skipped = [];
                            const invalid = [];

                            for (const entry of wanted) {
                                const domain = linkblock.cleanDomain(entry);
                                if (!domain) {
                                    invalid.push(entry);
                                    continue;
                                }

                                const at = next.indexOf(domain);
                                if (action === "add" && at === -1) {
                                    next.push(domain);
                                    done.push(domain);
                                } else if (action === "remove" && at !== -1) {
                                    next.splice(at, 1);
                                    done.push(domain);
                                } else {
                                    skipped.push(domain);
                                }
                            }

                            if (done.length > 0) {
                                setGroupSetting(chatId, listName, next);
                            }

                            const lines = [];
                            if (done.length > 0) {
                                lines.push(`${action === "add" ? "Added to" : "Removed from"} ${listName}: ${done.join(", ")}`);
                            }
                            if (skipped.length > 0) {
                                lines.push(`${action === "add" ? "Already in" : "Not in"} ${listName}: ${skipped.join(", ")}`);
                            }
                            if (invalid.length > 0) {
                                lines.push(`These do not look like domains: ${invalid.join(", ")}`);
                            }
                            await reply(sock, msg, lines.join("\n"));
                            continue;
                        }

                        // ----------------------------
                        // !mod warntoggle <true|false>
                        // turns the warn commands on or off in this group
                        // ----------------------------

                        if (setting.toLowerCase() === "warntoggle") {
                            // show the current value
                            if (args.length === 2) {
                                await reply(sock, msg, `warntoggle is currently ${getGroupSetting(chatId, "warntoggle")}`);
                                continue;
                            }

                            const value = args[2].toLowerCase();
                            if (!["true", "false"].includes(value)) {
                                await reply(sock, msg, "Usage: !mod warntoggle <true|false>");
                                continue;
                            }

                            setGroupSetting(chatId, "warntoggle", value === "true");
                            await reply(
                                sock,
                                msg,
                                value === "true"
                                    ? "warntoggle set to true. The warn commands are turned on."
                                    : "warntoggle set to false. The warn commands are turned off."
                            );
                            continue;
                        }

                        // ----------------------------
                        // !mod warnlimit <1-20>
                        // how many warnings someone can get before the bot does the warnaction
                        // ----------------------------

                        if (setting.toLowerCase() === "warnlimit") {
                            // show the current value
                            if (args.length === 2) {
                                await reply(sock, msg, `warnlimit is currently ${getGroupSetting(chatId, "warnlimit")}`);
                                continue;
                            }

                            const value = Number(args[2]);
                            if (!Number.isInteger(value) || value < 1 || value > 20) {
                                await reply(sock, msg, "Usage: !mod warnlimit <1-20>");
                                continue;
                            }

                            setGroupSetting(chatId, "warnlimit", value);
                            await reply(sock, msg, `warnlimit set to ${value}. People reach the limit at ${value} warnings.`);
                            continue;
                        }

                        // ----------------------------
                        // !mod warnaction <kick|ban|notify> [duration]
                        // what the bot does when someone hits the warn limit. kick, ban and notify can all be used together. a ban can have a time on it, 0 or no time means it never ends
                        // ----------------------------

                        if (setting.toLowerCase() === "warnaction") {
                            // show the current value
                            if (args.length === 2) {
                                const current = getGroupSetting(chatId, "warnaction");
                                const length = getGroupSetting(chatId, "warnbanduration");
                                const lasts = length ? `for ${extras.describeDuration(length)}` : "with no end";
                                await reply(sock, msg, `warnaction is currently ${current.join(" ")}${current.includes("ban") ? ` (the ban lasts ${lasts})` : ""}`);
                                continue;
                            }

                            const usage = "Usage: !mod warnaction <kick|ban|notify> [duration]\nkick, ban and notify can be used together, for example !mod warnaction kick ban 2h. A duration is something like 2h, 90min or 1h30min (1 minute to 30 days) and only goes with ban. Use 0 or leave it out for a ban with no end.";

                            // the actions come first, whatever is left over is the ban time
                            const picked = [];
                            let rest = args.slice(2);
                            while (rest.length && ["kick", "ban", "notify"].includes(rest[0].toLowerCase())) {
                                const word = rest[0].toLowerCase();
                                if (!picked.includes(word)) {
                                    picked.push(word);
                                }
                                rest = rest.slice(1);
                            }

                            if (!picked.length) {
                                await reply(sock, msg, usage);
                                continue;
                            }

                            // only a ban takes a time, 0 means it never ends
                            let duration = 0;
                            if (rest.length) {
                                duration = picked.includes("ban") ? extras.parseBanTime(rest.join("")) : null;
                                if (duration === null) {
                                    await reply(sock, msg, usage);
                                    continue;
                                }
                            }

                            setGroupSetting(chatId, "warnaction", picked);
                            if (picked.includes("ban")) {
                                setGroupSetting(chatId, "warnbanduration", duration);
                            }

                            const effects = [];
                            if (picked.includes("kick")) {
                                effects.push("are removed from the group");
                            }
                            if (picked.includes("ban")) {
                                effects.push(duration ? `are banned from using the bot for ${extras.describeDuration(duration)}` : "are banned from using the bot until someone unbans them");
                            }
                            if (picked.includes("notify")) {
                                effects.push("get a message");
                            }
                            await reply(sock, msg, `warnaction set to ${picked.join(" ")}. People who reach the limit ${effects.join(" and ")}.`);
                            continue;
                        }

                        // ----------------------------
                        // !mod warnexpiry <0-365>
                        // warnings older than this many days stop counting, 0 means they never expire
                        // ----------------------------

                        if (setting.toLowerCase() === "warnexpiry") {
                            // show the current value
                            if (args.length === 2) {
                                await reply(sock, msg, `warnexpiry is currently ${getGroupSetting(chatId, "warnexpiry")}`);
                                continue;
                            }

                            const value = Number(args[2]);
                            if (!Number.isInteger(value) || value < 0 || value > 365) {
                                await reply(sock, msg, "Usage: !mod warnexpiry <0-365>");
                                continue;
                            }

                            setGroupSetting(chatId, "warnexpiry", value);
                            await reply(
                                sock,
                                msg,
                                value === 0
                                    ? "warnexpiry set to 0. Warnings never expire."
                                    : `warnexpiry set to ${value}. Warnings expire after ${value} ${value === 1 ? "day" : "days"}.`
                            );
                            continue;
                        }

                        // ----------------------------
                        // !mod warncurses <0-50>
                        // how many deleted curse messages in the window before a warning, 0 means off
                        // ----------------------------

                        if (setting.toLowerCase() === "warncurses") {
                            const current = extras.curseSettings(chatId);
                            // show the current value
                            if (args.length === 2) {
                                await reply(sock, msg, current.limit === 0 ? "warncurses is currently 0 (off)." : `warncurses is currently ${current.limit}.`);
                                continue;
                            }

                            const value = Number(args[2]);
                            if (!Number.isInteger(value) || value < 0 || value > 50) {
                                await reply(sock, msg, "Usage: !mod warncurses <0-50>");
                                continue;
                            }

                            setGroupSetting(chatId, "warncurses", value);
                            await reply(
                                sock,
                                msg,
                                value === 0
                                    ? "warncurses is off. Deleted messages will not cause warnings."
                                    : `warncurses set to ${value}. People are warned when more than ${value} of their messages are deleted for cursing within ${current.minutes} ${current.minutes === 1 ? "minute" : "minutes"}.`
                            );
                            continue;
                        }

                        // ----------------------------
                        // !mod warncursestime <1-60>
                        // how many minutes the curse messages are counted over, it starts at someones first deleted message
                        // ----------------------------

                        if (setting.toLowerCase() === "warncursestime") {
                            const current = extras.curseSettings(chatId);
                            // show the current value
                            if (args.length === 2) {
                                await reply(sock, msg, `warncursestime is currently ${current.minutes} ${current.minutes === 1 ? "minute" : "minutes"}.`);
                                continue;
                            }

                            const value = Number(args[2]);
                            if (!Number.isInteger(value) || value < 1 || value > 60) {
                                await reply(sock, msg, "Usage: !mod warncursestime <1-60>");
                                continue;
                            }

                            setGroupSetting(chatId, "warncursestime", value);
                            const unit = value === 1 ? "minute" : "minutes";
                            await reply(sock, msg, `warncursestime set to ${value} ${unit}. The warncurses count is tracked within a window of ${value} ${unit} from a person's first deleted message.`);
                            continue;
                        }

                        // ----------------------------
                        // !mod linkexempt <true|false>
                        // lets group admins and trusted people post links even when linking is off
                        // ----------------------------

                        if (setting.toLowerCase() === "linkexempt") {
                            // Show current value
                            if (args.length === 2) {
                                await reply(sock, msg, `linkexempt is currently ${getGroupSetting(chatId, "linkexempt")}`);
                                continue;
                            }

                            const value = args[2].toLowerCase();
                            if (!["true", "false"].includes(value)) {
                                await reply(sock, msg, "Usage: !mod linkexempt <true|false>");
                                continue;
                            }

                            setGroupSetting(chatId, "linkexempt", value === "true");
                            await reply(
                                sock,
                                msg,
                                value === "true"
                                    ? "linkexempt set to true. Group admins and trusted users can post links."
                                    : "linkexempt set to false. Links from group admins and trusted users get deleted too."
                            );
                            continue;
                        }

                        if (setting.toLowerCase() === "antibadwordreport") {
                            if (args.length === 2) {
                                await reply(sock, msg, `antibadwordreport is currently ${getGroupSetting(chatId, "antibadwordreport")}`);
                                continue;
                            }

                            const value = args[2].toLowerCase();
                            if (!["true", "false"].includes(value)) {
                                await reply(sock, msg, "Usage: !mod antibadwordreport <true|false>");
                                continue;
                            }

                            setGroupSetting(chatId, "antibadwordreport", value === "true");
                            await reply(
                                sock,
                                msg,
                                value === "true"
                                    ? "antibadwordreport set to true. The deletion message now tells people to contact the group admin if it was a mistake."
                                    : "antibadwordreport set to false. The deletion message no longer mentions contacting the group admin."
                            );
                            continue;
                        }

                        // ----------------------------
                        // !mod edgypreset <true|false>
                        // lets this group pick the edgy preset for !ai personality, it is off until someone turns it on
                        // ----------------------------

                        if (setting.toLowerCase() === "edgypreset") {
                            // Show current value
                            if (args.length === 2) {
                                await reply(sock, msg, `edgypreset is currently ${getGroupSetting(chatId, "edgypreset")}`);
                                continue;
                            }

                            const value = args[2].toLowerCase();
                            if (!["true", "false"].includes(value)) {
                                await reply(sock, msg, "Usage: !mod edgypreset <true|false>");
                                continue;
                            }

                            setGroupSetting(chatId, "edgypreset", value === "true");
                            await reply(
                                sock,
                                msg,
                                value === "true"
                                    ? "edgypreset set to true. The edgy preset can now be chosen with !ai personality preset edgy."
                                    : "edgypreset set to false. The edgy preset can no longer be chosen in this group. A personality that is already set stays until it is reset with !ai personality reset."
                            );
                            continue;
                        }

                        // ----------------------------
                        // Unknown setting
                        // ----------------------------

                        await reply(
                            sock,
                            msg,
                            [
                                "Unknown mod setting.",
                                "",
                                "Available settings:",
                                "test - Check whether the bot is a group admin",
                                "antibadword <true|false>",
                                "antibadwordnosay <true|false>",
                                "antibadwordreport <true|false>",
                                "badwordlog <silent|info|debug>",
                                "welcomeMsgEnabled <true|false>",
                                "welcomeMsg <string>",
                                "gamesenabled <true|false>",
                                "disablelinking <true|false>",
                                "disablelinkingnosay <true|false>",
                                "linkblocklist <add|remove|clear> <domain>",
                                "linkwhitelist <add|remove|clear> <domain>",
                                "linkexempt <true|false>",
                                "warntoggle <true|false>",
                                "warnlimit <1-20>",
                                "warnaction <kick|ban|notify [duration]>",
                                "warnexpiry <0-365>",
                                "warncurses <0-50>",
                                "warncursestime <1-60>",
                                "edgypreset <true|false>"
                            ].join("\n")
                        );
                    }


                    // ----------------------------------------------------
                    // !special
                    // this command is only available ONLY to trusted users, and has a lot of special features that we don't talk about :>
                    // aka a shit ton of subcommands
                    // ----------------------------------------------------
                    if (
                        text === "!commhelper" ||
                        text.startsWith("!commhelper ")
                    ) {
                        if (!trusted) {
                            await reply(sock, msg, "You aren't trusted.");
                            continue;
                        }

                        try {
                            await handleCommunityHelperCommand(
                                msg,
                                senderJid,
                                text
                            );
                        } catch (error) {
                            log.error("community", "Community helper error:", error);
                            await reply(
                                sock,
                                msg,
                                "The community helper could not load this community."
                            );
                        }
                    }

                    else if (
                        text.startsWith("!special")
                    ) {

                        if (!trusted) {

                            await reply(
                                sock,
                                msg,
                                "You aren't trusted."
                            );

                            continue;
                        }
                        // if no subcommand is given, show the list of subcommands
                        const args =
                            text
                                .trim()
                                .split(/\s+/);
                        
                        if (args.length === 1) {
                            await reply(
                                sock,
                                msg,
                                [
                                    "Special commands:",
                                    "",
                                    "join <group invite link> - Join a group via invite link",
                                    "leave <group id> - Leave a group by ID",
                                    "listgroups - List all groups the bot is in",
                                    "debug - Dump message, group, identity, and config details",
                                    "forceban <add|remove|list> [number] - Ban a phone number from using the bot everywhere",
                                    "kickfrom <group id> <number> - Remove a number from a group the bot is in",
                                ].join("\n")
                            );

                            continue;
                        }
                        // subcommand is the second argument
                        const subcommand =
                            args[1];

                        if (subcommand === "commhelper") {
                            if (!isGroup) {
                                await reply(
                                    sock,
                                    msg,
                                    "!special commhelper must be run in a community group."
                                );
                                continue;
                            }

                            try {
                                await sendCommunityHelper(
                                    senderJid,
                                    chatId
                                );
                                await reply(
                                    sock,
                                    msg,
                                    "I sent you a DM with the community group controls."
                                );
                            } catch (error) {
                                log.error("community", "Error starting community helper:", error);
                                await reply(
                                    sock,
                                    msg,
                                    "This group is not a community, or its linked groups could not be loaded."
                                );
                            }
                        } else if (subcommand === "join") {
                            const inviteLink =
                                args[2];

                            if (!inviteLink) {
                                await reply(
                                    sock,
                                    msg,
                                    "Usage: !special join <group invite link>"
                                );
                                continue;
                            }

                            try {
                                const code = inviteLink.replace("https://chat.whatsapp.com/", "");
                                const result =
                                    await sock.groupAcceptInvite(code);
                                
                                // Fetch the group metadata to get the subject (name)
                                const groupMetadata = await sock.groupMetadata(result);
                                const groupName = groupMetadata.subject;
                                await reply(
                                    sock,
                                    msg,
                                    `Joined group: ${groupName} (${result})`
                                );
                            } catch (error) {
                                log.error("group", "Error joining group:", error);
                                await reply(
                                    sock,
                                    msg,
                                    "Failed to join group. Make sure the invite link is valid."
                                );
                            }
                        } else if (subcommand === "leave") {
                            const groupId =
                                args[2] || msg.key.remoteJid;

                            if (!groupId || !groupId.endsWith("@g.us")) {
                                await reply(
                                    sock,
                                    msg,
                                    "Usage: !special leave <group id> or run it inside the group you want to leave."
                                );
                                continue;
                            }

                            try {
                                const groupMetadata = await sock.groupMetadata(groupId);
                                const groupName = groupMetadata.subject || groupId;

                                await sock.sendMessage(
                                    groupId,
                                    { text: `Leaving group: ${groupName} (${groupId})` }
                                );

                                await sock.groupLeave(groupId);
                            } catch (error) {
                                log.error("group", "Error leaving group:", error);
                                await reply(
                                    sock,
                                    msg,
                                    "Failed to leave group. Make sure the group ID is valid."
                                );
                            }
                        } else if (subcommand === "listgroups") {
                            try {
                                const groups =
                                    await sock.groupFetchAllParticipating();
                                
                                // Convert the groups object to an array of group names and IDs
                                const groupList = Object.values(groups).map(group => `${group.subject} (${group.id})`);
                                // get all config values for the groups and append them to the list
                                const groupListWithConfig = groupList.map(group => {
                                    const groupId = group.match(/\(([^)]+)\)$/)[1]; // extract the group ID from the string
                                    // antibadword, badwordlog
                                    const antibadword = getGroupSetting(groupId, "antibadword");
                                    const badwordlog = getGroupSetting(groupId, "badwordlog");
                                    const isEnabled = getEnabledGroups().includes(groupId);
                                    return `${group} - antibadword: ${antibadword}, badwordlog: ${badwordlog}, enabled: ${isEnabled}`;
                                });
                                await reply(
                                    sock,
                                    msg,
                                    groupListWithConfig.length
                                        ? groupListWithConfig.join("\n")
                                        : "No groups found."
                                );
                            } catch (error) {
                                log.error("group", "Error listing groups:", error);
                                await reply(
                                    sock,
                                    msg,
                                    "Failed to list groups."
                                );
                            }
                        
                        } else if (subcommand === "debug") {
                            const contextInfo =
                                msg.message?.extendedTextMessage?.contextInfo ||
                                msg.message?.imageMessage?.contextInfo ||
                                msg.message?.videoMessage?.contextInfo ||
                                msg.message?.stickerMessage?.contextInfo ||
                                msg.message?.audioMessage?.contextInfo;

                            let groupMetadata = null;
                            let groupMetadataError = null;

                            if (isGroup) {
                                try {
                                    groupMetadata = await sock.groupMetadata(chatId);
                                } catch (error) {
                                    groupMetadataError = {
                                        name: error.name,
                                        message: error.message,
                                        stack: error.stack
                                    };
                                }
                            }

                            const debugData = {
                                command: {
                                    text,
                                    args,
                                    subcommand
                                },
                                message: msg,
                                messageKey: msg.key,
                                messageContent: msg.message,
                                messageContextInfo: msg.message?.messageContextInfo,
                                quotedContextInfo: contextInfo,
                                extractedText: text,
                                sender: {
                                    participant: senderPN,
                                    participantAlt: senderLID,
                                    remoteJid: chatId,
                                    fromMe: msg.key.fromMe,
                                    trusted,
                                    groupAdmin
                                },
                                bot: {
                                    user: sock.user,
                                    id: sock.user?.id,
                                    lid: sock.user?.lid
                                },
                                chat: {
                                    id: chatId,
                                    isGroup,
                                    enabled: isGroup ? isGroupEnabled(chatId) : null,
                                    currentSettings: isGroup ? getGroupSettings(chatId) : null,
                                    groupMetadata,
                                    groupMetadataError
                                },
                                config: getConfigSnapshot()
                            };

                            const seen = new WeakSet();
                            const serializedDebugData = JSON.stringify(
                                debugData,
                                (key, value) => {
                                    if (typeof value === "bigint") {
                                        return `${value}n`;
                                    }

                                    if (Buffer.isBuffer(value)) {
                                        return {
                                            type: "Buffer",
                                            data: value.toString("base64")
                                        };
                                    }

                                    if (value instanceof Error) {
                                        return {
                                            name: value.name,
                                            message: value.message,
                                            stack: value.stack
                                        };
                                    }

                                    if (value && typeof value === "object") {
                                        if (seen.has(value)) {
                                            return "[Circular]";
                                        }

                                        seen.add(value);
                                    }

                                    return value;
                                },
                                2
                            );

                            const debugChunks = serializedDebugData.match(/[\s\S]{1,6000}/g) || ["{}"];

                            for (const [index, chunk] of debugChunks.entries()) {
                                await reply(
                                    sock,
                                    msg,
                                    `SPECIAL DEBUG ${index + 1}/${debugChunks.length}\n${chunk}`
                                );
                            }
                        } else if (subcommand === "delete") {
                            const contextInfo =
                                msg.message?.extendedTextMessage?.contextInfo ||
                                msg.message?.imageMessage?.contextInfo ||
                                msg.message?.videoMessage?.contextInfo ||
                                msg.message?.stickerMessage?.contextInfo ||
                                msg.message?.audioMessage?.contextInfo;

                            const quotedId = contextInfo?.stanzaId || contextInfo?.quotedMessage?.stanzaId || contextInfo?.messageID;
                            const quotedParticipant = contextInfo?.participant || contextInfo?.quotedParticipant;
                            const quotedRemoteJid = contextInfo?.remoteJid || msg.key.remoteJid;

                            log.info("delete", "[SPECIAL DELETE DEBUG]", {
                                remoteJid: msg.key.remoteJid,
                                quotedId,
                                quotedParticipant,
                                quotedRemoteJid,
                                contextInfo,
                                botId: sock.user?.id,
                                botLid: sock.user?.lid,
                                messageKeys: Object.keys(msg.message || {})
                            });

                            if (!quotedId) {
                                await reply(
                                    sock,
                                    msg,
                                    "Usage: reply to one of my messages with !special delete"
                                );
                                continue;
                            }

                            const normalizeJid = (jid) => {
                                if (!jid || typeof jid !== "string") {
                                    return "";
                                }

                                return jid
                                    .trim()
                                    .toLowerCase()
                                    .replace(/:\d+(?=@)/, "");
                            };

                            const botCandidateJids = [
                                sock.user?.id,
                                sock.user?.lid,
                                sock.user?.id?.split(":")[0] + "@s.whatsapp.net",
                                sock.user?.id?.split(":")[0] + "@lid",
                                sock.user?.lid?.split(":")[0] + "@lid",
                                sock.user?.lid?.split(":")[0] + "@s.whatsapp.net"
                            ]
                                .map(normalizeJid)
                                .filter(Boolean);

                            const normalizedQuotedParticipant = normalizeJid(quotedParticipant);
                            const normalizedQuotedRemote = normalizeJid(quotedRemoteJid);
                            const normalizedQuotedIds = new Set([
                                normalizedQuotedParticipant,
                                normalizedQuotedRemote,
                                normalizeJid(contextInfo?.participant),
                                normalizeJid(contextInfo?.remoteJid)
                            ].filter(Boolean));
                            const normalizedBotIds = new Set(botCandidateJids);

                            const isBotQuotedMessage =
                                [...normalizedBotIds].some((botId) => normalizedQuotedIds.has(botId)) ||
                                contextInfo?.fromMe === true ||
                                quotedParticipant === sock.user?.id ||
                                quotedParticipant === sock.user?.lid ||
                                quotedParticipant?.split(":")[0] === sock.user?.id?.split(":")[0] ||
                                quotedRemoteJid === sock.user?.id ||
                                quotedRemoteJid === sock.user?.lid;

                            log.info("delete", "[SPECIAL DELETE DEBUG] isBotQuotedMessage =", isBotQuotedMessage);

                            if (!isBotQuotedMessage) {
                                await reply(
                                    sock,
                                    msg,
                                    "I can only delete one of my own messages."
                                );
                                continue;
                            }

                            try {
                                await sock.sendMessage(
                                    msg.key.remoteJid,
                                    {
                                        delete: {
                                            remoteJid: msg.key.remoteJid,
                                            fromMe: true,
                                            id: quotedId,
                                            participant: quotedParticipant || msg.key.participant || sock.user?.id
                                        }
                                    }
                                );
                            } catch (error) {
                                log.error("delete", "Error deleting bot message:", error);
                                await reply(
                                    sock,
                                    msg,
                                    "Failed to delete that message."
                                );
                            }
                        } else if (subcommand === "forceban") {
                            await reply(sock, msg, extras.forceBanCommand(args.slice(2)));
                        } else if (subcommand === "kickfrom") {
                            // one time thing, kicks a number out of a group the bot is in. get the group id from !special listgroups
                            const groupId = args[2] || "";
                            const number = String(args[3] || "").replace(/\D/g, "");
                            if (!groupId.endsWith("@g.us") || !number) {
                                await reply(sock, msg, "Usage: !special kickfrom <group id> <phone number>");
                            } else {
                                try {
                                    // look the person up in the group first, some groups use lid ids instead of phone numbers
                                    const metadata = await sock.groupMetadata(groupId);
                                    const member = metadata.participants.find(p =>
                                        [p.id, p.lid, p.phoneNumber, p.jid].some(x => x && String(x).split("@")[0].split(":")[0] === number)
                                    );
                                    if (!member) {
                                        await reply(sock, msg, "I couldn't find that number in that group.");
                                    } else {
                                        const results = await sock.groupParticipantsUpdate(groupId, [member.id], "remove");
                                        const status = String(results?.[0]?.status || "200");
                                        await reply(sock, msg, status === "200" ? `Removed ${number} from ${metadata.subject}.` : `That didn't work (status ${status}). The bot has to be an admin in that group.`);
                                    }
                                } catch (error) {
                                    await reply(sock, msg, "That didn't work. The bot has to be an admin in that group, and the group id has to be right.");
                                }
                            }
                        } else if (subcommand.startsWith("welcome")) {
                            if (!isGroup) {
                                await reply(
                                    sock,
                                    msg,
                                    "!special welcome can only be used in groups."
                                );
                                continue;
                            }

                            // Send a mock welcome message with the user being the sender, unless there is a mention/user specified.
                            const mockSenderJid =
                                msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                                msg.key.participant ||
                                msg.key.remoteJid;
                            const welcomeMsgTemplate = getGroupSetting(chatId, "welcomeMsg");

                            sendWelcomeMessage(
                                sock,
                                chatId,
                                [mockSenderJid],
                                welcomeMsgTemplate
                            );
                            await reply(
                                sock,
                                msg,
                                "Sent a mock welcome message."
                            );
                        } else if (
                            subcommand === "tag"
                        ) {
                            if (!isGroup) {
                                await reply(
                                    sock,
                                    msg,
                                    "You can only tag group chats."
                                );
                                continue;
                            }
                            const action = args[2];
                            const tagName = args[3]?.trim();
                            let existingTags = getGroupSetting(chatId,"tags");
                            if (!existingTags) {
                                existingTags = [];
                            }
                            if (!tagName) {
                                await reply(
                                    sock,
                                    msg,
                                    "Did you forget the actual tag?"
                                );
                                continue;
                            }
                            if (action === "add") {
                                if (existingTags.includes(tagName)) {
                                        await reply(
                                            sock,
                                            msg,
                                            `This group is already tagged with "${tagName}"!`
                                        );
                                        continue;
                                    }
                                existingTags.push(tagName);
                                await reply(
                                    sock,
                                    msg,
                                    `This group chat has been tagged with "${tagName}"`
                                )
                            } else if (action === "remove") {
                                if (!existingTags.includes(tagName)) {
                                    await reply(
                                        sock,
                                        msg,
                                        `This group chat is not tagged with "${tagName}", unable to remove.`
                                    );
                                } else {
                                    let tagIndex = existingTags.indexOf(tagName);
                                    if (tagIndex !== -1) {
                                        existingTags.splice(tagIndex,1);
                                        await reply(
                                            sock,
                                            msg,
                                            `Removed ${tagName} tag from the group.`
                                        )
                                    } else {
                                        await reply(
                                            sock,
                                            msg,
                                            "The code reached a literal impossible state. Congratulate yourself, I guess. Nothing happened to the tags, just saying."
                                        )
                                    }
                                }
                            } else {
                                await reply(
                                    sock,
                                    msg,
                                    "Unknown tag action. You can only \"add\", and \"remove\"."
                                )
                            }
                            setGroupSetting(chatId,"tags",existingTags)
                        } else {
                            await reply(
                                sock,
                                msg,
                                "Unknown special subcommand. Available: join, leave, listgroups, debug, delete, forceban, kickfrom, tag"
                            );
                        }
                    }
                    


                } catch (error) {

                    log.error("msg",
                        "Error processing message:",
                        error
                    );
                }
            }
        }
    );
};


// ============================================================
// Start
// ============================================================

// Load the storage backend (file by default; mysql, mariadb,
// redis, postgres or supabase via STORAGE_BACKEND/STORAGE_URL)
// before connecting, so config data is ready when messages
// arrive.
require("./storage")
    .initStorage()
    .then(startSock)
    .catch(error => {
        log.error("storage", "Storage init failed:", error);
        process.exit(1);
    });
