// simple baileys bot!!!

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("baileys");

const qrcode = require("qrcode-terminal");

const { getText, reply } = require("./utils.js");

const aitools = require("./aitools.js");

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
    setGroupSetting,

    commandExecuted
} = require("./config.js");

const { 
    randomWord
} = require("./wordhelper.js");

const { isToxic } = require("./moderation.js");

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
const fs = require('node:fs');
const responses = JSON.parse(fs.readFileSync('messages.json', 'utf8'));
// ============================================================
// Extra functions
// ============================================================

const decryptGames = new Map();

function formatDecryptWord(word, revealedIndices) {
    return Array.from(word, (character, index) =>
        revealedIndices.has(index) ? character : "#"
    ).join("");
}

function scheduleDecryptHint(sock, game) {
    game.timeout = setTimeout(async () => {
        if (decryptGames.get(game.groupId) !== game) {
            return;
        }

        const hiddenIndices = Array.from(
            { length: game.word.length },
            (_, index) => index
        ).filter(index => !game.revealedIndices.has(index));

        const indexToReveal = hiddenIndices[
            Math.floor(Math.random() * hiddenIndices.length)
        ];
        game.revealedIndices.add(indexToReveal);

        const maskedWord = formatDecryptWord(game.word, game.revealedIndices);
        const hasLost = game.revealedIndices.size === game.word.length;

        if (hasLost) {
            decryptGames.delete(game.groupId);
        }

        try {
            await sock.sendMessage(game.groupId, {
                text: hasLost
                    ? `Hint: ${maskedWord}\nNobody solved it in time. The word was "${game.word}". git good hehe`
                    : `Hint: ${maskedWord}`
            });
        } catch (error) {
            console.error("Error sending decrypt game hint:", error);
        }

        if (
            hasLost &&
            game.tournamentRound &&
            tournaments.get(game.groupId) === game.tournamentRound &&
            game.tournamentRound.status === "running"
        ) {
            await startTournamentRound(sock, game.groupId);
            return;
        }

        if (!hasLost && decryptGames.get(game.groupId) === game) {
            scheduleDecryptHint(sock, game);
        }
    }, 30_000);
}

async function startDecryptGame(sock, groupId, tournamentRound = null) {
    const game = {
        groupId,
        loading: true,
        word: null,
        revealedIndices: new Set(),
        timeout: null,
        tournamentRound
    };
    decryptGames.set(groupId, game);

    try {
        const word = await randomWord("1", 7);
        console.log(`Starting decrypt game in group ${groupId} with word: ${word}`);

        if (decryptGames.get(groupId) !== game) {
            return false;
        }

        if (!word) {
            decryptGames.delete(groupId);
            await sock.sendMessage(groupId, {
                text: "they didnt give me a word. theyre so weird."
            });
            return false;
        }

        if (typeof word !== "string" || !/^[a-z]{3,}$/i.test(word)) {
            decryptGames.delete(groupId);
            await sock.sendMessage(groupId, {
                text: "they gave me a \"not a word\"?? i thought everything was a word. weird."
            });
            return false;
        }
        if (typeof word !== "string" || !/^[a-z]{3,}$/i.test(word)) {
            decryptGames.delete(groupId);
            await sock.sendMessage(groupId, {
                text: "i forgot the word. whoops."
            });
            return false;
        }

        game.word = word.toLowerCase();
        game.loading = false;

        while (game.revealedIndices.size < Math.min(2, game.word.length - 3)) {
            game.revealedIndices.add(
                Math.floor(Math.random() * game.word.length)
            );
        }

        await sock.sendMessage(groupId, {
            text: `find the word hehe\n${formatDecryptWord(game.word, game.revealedIndices)}\na new letter arrives in 30 seconds.`
        });

        if (decryptGames.get(groupId) === game) {
            scheduleDecryptHint(sock, game);
        }
        return true;
    } catch (error) {
        if (decryptGames.get(groupId) !== game) {
            return false;
        }
        decryptGames.delete(groupId);
        console.error("Error starting decrypt game:", error);
        await sock.sendMessage(groupId, {
            text: "SOMETHING WENT WRONG BOOP BOOP BOOP ERROR ERROR ERROR HEHEHEHEHEHEHEHEH"
        });
        return false;
    }
}

async function sendWelcomeMessage(sock, groupId, participants, welcomeMsg) {
    for (const participant of participants) {
        const userId = participant.split("@")[0];
        await sock.sendMessage(
            groupId,
            {
                text: welcomeMsg.replace("[user]", `@${userId}`),
                mentions: [participant]
            }
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
        console.error(
            "Failed to get group metadata:",
            error
        );

        return false;
    }
}

// ============================================================
// Game tournaments
// What this does is that a player can start a tournament in a group, and other players can join the tournament. 
// The bot will then start a minigame but only listen to the players that joined the tournament. 
// Every person that wins one minigame round gets one point. 
// The first player to reach 3 points (configurable) wins the tournament. 
// The bot will then announce the winner and end the tournament.
// These are only the helper functions for the tournament. The actual tournament logic is in the socket section.
// ============================================================

const tournaments = new Map();

const minigames = ["decrypt"];

function createTournament(groupId, creatorId, maxPoints = 3, minigame = "decrypt") {
    if (
        !groupId ||
        !creatorId ||
        !Number.isSafeInteger(maxPoints) ||
        maxPoints < 1
    ) {
        return false;
    }

    if (!minigames.includes(minigame)) {
        return false;
    }

    if (tournaments.has(groupId)) {
        return false;
    }

    const players = new Set([creatorId]);
    tournaments.set(groupId, {
        creatorId,
        players,
        scores: new Map([[creatorId, 0]]),
        maxPoints,
        minigame,
        status: "lobby"
    });

    return true;
}

function joinTournament(groupId, playerId) {
    const tournament = tournaments.get(groupId);
    if (!tournament || tournament.status !== "lobby" || !playerId) {
        return false;
    }

    if (tournament.players.has(playerId)) {
        return false;
    }

    tournament.players.add(playerId);
    tournament.scores.set(playerId, 0);

    return true;
}

function leaveTournament(groupId, playerId) {
    const tournament = tournaments.get(groupId);
    if (
        !tournament ||
        tournament.status !== "lobby" ||
        playerId === tournament.creatorId ||
        !tournament.players.has(playerId)
    ) {
        return false;
    }

    tournament.players.delete(playerId);
    tournament.scores.delete(playerId);

    return true;
}

function getTournament(groupId) {
    return tournaments.get(groupId);
}

function endTournament(groupId) {
    const tournament = tournaments.get(groupId);
    if (!tournament) {
        return false;
    }

    const game = decryptGames.get(groupId);
    if (game?.tournamentRound === tournament) {
        clearTimeout(game.timeout);
        decryptGames.delete(groupId);
    }

    return tournaments.delete(groupId);
}

async function startTournamentRound(sock, groupId) {
    const tournament = tournaments.get(groupId);
    if (
        !tournament ||
        tournament.status !== "running" ||
        decryptGames.has(groupId)
    ) {
        return false;
    }

    if (tournament.minigame === "decrypt") {
        const started = await startDecryptGame(sock, groupId, tournament);
        if (!started && tournaments.get(groupId) === tournament) {
            tournament.status = "lobby";
        }
        return started;
    }

    return false;
}

async function awardTournamentPoint(sock, groupId, playerId, expectedTournament) {
    const tournament = tournaments.get(groupId);
    if (
        !tournament ||
        tournament !== expectedTournament ||
        tournament.status !== "running" ||
        !tournament.players.has(playerId)
    ) {
        return;
    }

    const score = (tournament.scores.get(playerId) || 0) + 1;
    tournament.scores.set(playerId, score);

    if (score >= tournament.maxPoints) {
        endTournament(groupId);
        await sock.sendMessage(groupId, {
            text: `@${playerId.split("@")[0]} wins the tournament with ${score} points!`,
            mentions: [playerId]
        });
        return;
    }

    await sock.sendMessage(groupId, {
        text: `@${playerId.split("@")[0]} wins the round and now has ${score}/${tournament.maxPoints} points. The next round is starting.`,
        mentions: [playerId]
    });

    if (tournaments.get(groupId) === tournament) {
        await startTournamentRound(sock, groupId);
    }
}



// ============================================================
// Start socket
// ============================================================

const startSock = async () => {

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState("auth");


    const sock = makeWASocket({
        auth: state
    });


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

                console.log(
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


                const shouldReconnect =
                    statusCode !==
                    DisconnectReason.loggedOut;


                console.log(
                    "Connection closed.",
                    lastDisconnect?.error
                );


                if (shouldReconnect) {

                    console.log(
                        "Reconnecting..."
                    );

                    startSock();

                } else {

                    console.log(
                        "Logged out."
                    );

                    console.log(
                        "Delete the auth folder and restart to pair again."
                    );
                }
            }


            // ----------------------------
            // Connected
            // ----------------------------

            else if (connection === "open") {

                console.log(
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
            console.error("Failed to check bot admin status:", error);
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
                console.error("Error joining community group:", error);
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
                console.error("Error leaving community group:", error);
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


                try {

                    // ====================================================
                    // Message text
                    // ====================================================

                    const receivedText =
                        getText(msg.message);


                    if (!receivedText) {
                        continue;
                    }

                    if (devMode && receivedText.startsWith("!")) {
                        continue;
                    }

                    const text = devMode && receivedText.startsWith("t!")
                        ? `!${receivedText.slice(2)}`
                        : receivedText;


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

                    console.log(
                        `[${chatId}] ` +
                        `[${senderPN || senderLID}] ` +
                        `${text}`
                    );


                    // ====================================================
                    // Disabled group check
                    //
                    // Trusted users bypass this.
                    // ====================================================

                    if (
                        isGroup &&
                        !isGroupEnabled(chatId) &&
                        !trusted
                    ) {

                        continue;
                    }

                    const decryptGame = decryptGames.get(chatId);
                    if (
                        decryptGame &&
                        !decryptGame.loading &&
                        text.trim().toLowerCase() === decryptGame.word
                    ) {
                        if (decryptGame.tournamentRound) {
                            const tournament = getTournament(chatId);
                            if (tournament !== decryptGame.tournamentRound) {
                                clearTimeout(decryptGame.timeout);
                                decryptGames.delete(chatId);
                                continue;
                            }
                            if (!tournament.players.has(senderJid)) {
                                continue;
                            }
                        }

                        clearTimeout(decryptGame.timeout);
                        decryptGames.delete(chatId);
                        if (decryptGame.tournamentRound) {
                            await awardTournamentPoint(
                                sock,
                                chatId,
                                senderJid,
                                decryptGame.tournamentRound
                            );
                        } else {
                            await sock.sendMessage(chatId, {
                                text: `@${senderJid.split("@")[0]} solved it first. The word was "${decryptGame.word}". impressive.`,
                                mentions: [senderJid]
                            });
                        }
                        continue;
                    }


                    // ====================================================
                    // Anti-badword (ignores commands)
                    // ====================================================

                    if (
                        isGroup &&
                        getGroupSetting(
                            chatId,
                            "antibadword"
                        )
                    ) {
                        const currentBadwordlog = getGroupSetting(chatId, "badwordlog");

                        if (
                            currentBadwordlog === undefined ||
                            !["silent", "info", "debug"].includes(currentBadwordlog)
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

                                console.log(
                                    `Detected toxic message ` +
                                    `(${result.score})`
                                );

                                const botIsAdmin = await isBotAdmin(chatId);

                                // debug logging
                                if (
                                    getGroupSetting(
                                        chatId,
                                        "badwordlog"
                                    ) === "debug"
                                ) {
                                    await reply(
                                    sock,
                                    msg,
                                    `${botIsAdmin ? "This message was deleted.": "" } Please be nice. (If you think it was a mistake please contact the group admin.)
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
                                    `${botIsAdmin ? "This message was deleted.": "" } Please be nice. (If you think it was a mistake please contact the group admin.)
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
                                    `${botIsAdmin ? "This message was deleted.": "" } Please be nice. (If you think it was a mistake please contact the group admin.)`
                                );
                                } else {
                                    console.error(
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
                                }
                                continue;
                                
                            }

                        } catch (error) {

                            console.error(
                                "Moderation API error:",
                                error
                            );

                            // Fail open:
                            // If the moderation API is down,
                            // don't break the bot.
                        }
                    }


                    // ====================================================
                    // Commands
                    // ====================================================

                    if (
                        text === "!tournament" ||
                        text.startsWith("!tournament ")
                    ) {
                        if (!isGroup) {
                            await reply(sock, msg, "Tournaments can only be used in a group.");
                            continue;
                        }

                        const [, action, ...args] = text.trim().split(/\s+/);
                        const tournament = getTournament(chatId);
                        const usage = [
                            `Usage: ${commandPrefix}tournament <create [points]|join|leave|start|status|cancel>`,
                            `The creator is automatically entered and controls start/cancel.`
                        ].join("\n");

                        if (action === "create") {
                            if (args.length > 1 || (args[0] && !/^[1-9]\d*$/.test(args[0]))) {
                                await reply(sock, msg, usage);
                                continue;
                            }
                            if (decryptGames.has(chatId)) {
                                await reply(sock, msg, "Finish the current decrypt game before creating a tournament.");
                                continue;
                            }

                            const maxPoints = args[0] ? Number(args[0]) : 3;
                            if (!createTournament(chatId, senderJid, maxPoints)) {
                                await reply(sock, msg, "A tournament already exists here, or the tournament settings are invalid.");
                                continue;
                            }

                            await reply(
                                sock,
                                msg,
                                `Tournament created. You are entered automatically. Others can join with ${commandPrefix}tournament join.`
                            );
                            continue;
                        }

                        if (action === "join") {
                            if (args.length || !tournament) {
                                await reply(sock, msg, tournament ? usage : "There is no tournament to join.");
                                continue;
                            }
                            if (!joinTournament(chatId, senderJid)) {
                                await reply(sock, msg, tournament.status === "lobby"
                                    ? "You have already joined this tournament."
                                    : "The tournament has already started; no more players can join.");
                                continue;
                            }

                            await reply(sock, msg, "You joined the tournament.");
                            continue;
                        }

                        if (action === "leave") {
                            if (args.length || !tournament) {
                                await reply(sock, msg, tournament ? usage : "There is no tournament to leave.");
                                continue;
                            }
                            if (!leaveTournament(chatId, senderJid)) {
                                await reply(sock, msg, senderJid === tournament.creatorId
                                    ? `The creator cannot leave; use ${commandPrefix}tournament cancel instead.`
                                    : "You can only leave a tournament lobby after joining.");
                                continue;
                            }

                            await reply(sock, msg, "You left the tournament.");
                            continue;
                        }

                        if (action === "start") {
                            if (args.length || !tournament) {
                                await reply(sock, msg, tournament ? usage : "There is no tournament to start.");
                                continue;
                            }
                            if (senderJid !== tournament.creatorId) {
                                await reply(sock, msg, "Only the tournament creator can start it.");
                                continue;
                            }
                            if (tournament.status !== "lobby") {
                                await reply(sock, msg, "The tournament is already running.");
                                continue;
                            }
                            if (tournament.players.size < 2) {
                                await reply(sock, msg, "At least two players must join before the tournament can start.");
                                continue;
                            }
                            if (!getGroupSetting(chatId, "gamesEnabled")) {
                                await reply(sock, msg, "A moderator has disabled games in this group.");
                                continue;
                            }
                            if (decryptGames.has(chatId)) {
                                await reply(sock, msg, "Finish the current decrypt game before starting the tournament.");
                                continue;
                            }

                            tournament.status = "running";
                            await startTournamentRound(sock, chatId);
                            continue;
                        }

                        if (action === "status") {
                            if (args.length || !tournament) {
                                await reply(sock, msg, tournament ? usage : "There is no tournament in this group.");
                                continue;
                            }

                            const standings = [...tournament.players]
                                .map(playerId => ({
                                    playerId,
                                    score: tournament.scores.get(playerId) || 0
                                }))
                                .sort((first, second) => second.score - first.score)
                                .map(({ playerId, score }) =>
                                    `@${playerId.split("@")[0]}: ${score}`
                                );
                            const mentions = [...tournament.players];
                            await sock.sendMessage(chatId, {
                                text: [
                                    `Tournament: ${tournament.status}`,
                                    `First to ${tournament.maxPoints} points wins.`,
                                    ...standings
                                ].join("\n"),
                                mentions
                            });
                            continue;
                        }

                        if (action === "cancel") {
                            if (args.length || !tournament) {
                                await reply(sock, msg, tournament ? usage : "There is no tournament to cancel.");
                                continue;
                            }
                            if (senderJid !== tournament.creatorId) {
                                await reply(sock, msg, "Only the tournament creator can cancel it.");
                                continue;
                            }

                            endTournament(chatId);
                            await reply(sock, msg, "The tournament was cancelled.");
                            continue;
                        }

                        await reply(sock, msg, usage);
                        continue;
                    }

                    // ----------------------------------------------------
                    // !decrypt
                    // ----------------------------------------------------

                    if (text === "!decrypt") {
                        if (!isGroup) {
                            await reply(sock, msg, "The decrypt game can only be played in a group.");
                            continue;
                        }

                        if (!getGroupSetting(chatId, "gamesEnabled")) {
                            await reply(sock, msg, "A moderator has disabled games in this group.");
                            continue;
                        }

                        if (getTournament(chatId)) {
                            await reply(
                                sock,
                                msg,
                                "A tournament is already being organized or played in this group."
                            );
                            continue;
                        }

                        const currentGame = decryptGames.get(chatId);
                        if (currentGame) {
                            await reply(
                                sock,
                                msg,
                                currentGame.loading
                                    ? "A decrypt game is starting. Please wait."
                                    : "A decrypt game is already running in this group."
                            );
                            continue;
                        }

                        await startDecryptGame(sock, chatId);
                        continue;
                    }

                    // ----------------------------------------------------
                    // !summarize
                    // ----------------------------------------------------
                    
                    if (
                        text.startsWith("!summarize")
                    ) {

                        // First, check if the message is a reply to another message, if it is, we will summarize the replied message instead of the command message itself.
                        let textToSummarize = text.slice("!summarize".length).trim();

                        if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                            const quotedMessage = msg.message.extendedTextMessage.contextInfo.quotedMessage;
                            textToSummarize = getText(quotedMessage);
                        }

                        if (!textToSummarize) {
                            await reply(
                                sock,
                                msg,
                                "Usage: !summarize <text> or reply to a message with !summarize"
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
                            console.error("Error summarizing text:", error);
                            await reply(
                                sock,
                                msg,
                                "Something went wrong while summarizing the text. Please try again later."
                            );
                        }
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

                        await reply(
                            sock,
                            msg,
                            "pong"
                        );
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
                        catlink = await getCatPhoto();
                        // check if catlink is a valid URL
                        try {
                            new URL(catlink);
                        } catch (error) {
                            console.error("Invalid cat photo URL:", catlink);
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
                        doglink = await getDogPhoto();
                        // check if doglink is a valid URL
                        try {
                            new URL(doglink);
                        } catch (error) {
                            console.error("Invalid dog photo URL:", doglink);
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
                            return;
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
                            console.error("Error plotting expression:", error);
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

                        await reply(
                            sock,
                            msg,
                            [
                                `PN: ${senderPN || "unknown"}`,
                                `LID: ${senderLID || "unknown"}`,
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
                        console.log("Calculating expression:", text.slice(6).trim());
                        let expression = text.slice(6).trim();
                        // It will return a tuple of [result, error], where result is the calculated value or null if there was an error, and error is the error message or null if there was no error.
                        const [result, error] = calculateEquation(expression);
                        console.log("[CALC] After calculateEquation");
                        console.log("[CALC] result =", result);
                        console.log("[CALC] error =", error);
                        
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
                            console.error("Error fetching weather:", error);
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


                        const identifier =
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


                        const identifier =
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
                    // !gameshelp
                    // Help command for games, lists all available games and their commands if they are enabled.
                    // -----------------------------------------------------
                    if (
                        text.startsWith("!gameshelp")
                    ) {
                        // If games are disabled in this group, tell the user that games are disabled.
                        
                    }

                    // -----------------------------------------------------
                    // !scp <number>
                    // -----------------------------------------------------
                    
                    else if (
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
                                    return;
                                }
                            } catch (err) {
                                console.error('!pfp onWhatsApp resolve error:', err);
                                await reply(sock, msg, "Could not resolve that number.");
                                return;
                            }
                        } else {
                            // !pfp with no argument -> sender
                            targetJid =
                                msg.key.participant ||
                                msg.key.remoteJid;
                            usedDefault = true;
                        }

                        console.log('!pfp target:', targetJid);

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
                            console.error('!pfp error:', err);

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


                            await reply(
                                sock,
                                msg,
                                [
                                    "Mod configuration",
                                    "",
                                    `antibadword: ${antibadword}(true|false)`,
                                    `badwordlog: ${badwordlog}(silent|info|debug)`,
                                    `welcomeMsgEnabled: ${getGroupSetting(chatId, "welcomeMsgEnabled")}(true|false)`,
                                    `welcomeMsg: ${getGroupSetting(chatId, "welcomeMsg")}(string)`,
                                    "",
                                    "To update: !mod <key> <value>",
                                    "Available keys: antibadword, badwordlog, welcomeMsgEnabled, welcomeMsg",
                                    "Valid values are in brackets next to the key at the list.",
                                    "",
                                    "Extra functions:",
                                    "!mod test - Check whether the bot is a group admin."
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
                            setGroupSetting(chatId, "welcomeMsgEnabled", value);
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
                                "badwordlog <silent|info|debug>",
                                "welcomeMsgEnabled <true|false>",
                                "welcomeMsg <string>",
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
                            console.error("Community helper error:", error);
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
                                console.error("Error starting community helper:", error);
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
                                console.error("Error joining group:", error);
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
                                console.error("Error leaving group:", error);
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
                                console.error("Error listing groups:", error);
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

                            const debugChunks = serializedDebugData.match(/[\\s\\S]{1,6000}/g) || ["{}"];

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

                            console.log("[SPECIAL DELETE DEBUG]", {
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

                            console.log("[SPECIAL DELETE DEBUG] isBotQuotedMessage =", isBotQuotedMessage);

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
                                console.error("Error deleting bot message:", error);
                                await reply(
                                    sock,
                                    msg,
                                    "Failed to delete that message."
                                );
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
                        } else {
                            await reply(
                                sock,
                                msg,
                                "Unknown special subcommand. Available: join, leave, listgroups, debug, delete"
                            );
                        }
                    }
                    


                } catch (error) {

                    console.error(
                        "Error processing message:",
                        error
                    );

                } finally {
                    
                    // Persist configuration after
                    // every message execution.
                    commandExecuted();
                }
            }
        }
    );
};


// ============================================================
// Start
// ============================================================

startSock();