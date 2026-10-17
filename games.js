// Mini games: decrypt, math, tournaments, plus the extra ones (coin, roll, rps,
// ttt, numguess, wordle, anagram). index.js passes every message to handleAnswer()
// and handleCommand(), and they return true if they used it.

const { reply } = require("./utils.js");
const { randomWord, getDefinition } = require("./wordhelper.js");
const { askDesktop } = require("./aitools.js");
const { getGroupSetting } = require("./config.js");
const { log, describeSender, describeGroup } = require("./logging.js");
const fs = require("fs");
const path = require("path");

// ============================================================
// Saving games so a restart doesnt wipe them
// decrypt, math, wordle, anagram and number guessing get written to games-state.json
// and picked back up when the bot connects. tournaments and the rest start over
// ============================================================

const GAMES_STATE_FILE = path.join(__dirname, "games-state.json");
// a math game has no timer, so one thats been sitting around this long gets dropped on startup
const MATH_RESTORE_MAX_MS = 60 * 60 * 1000;

let restored = false;
let saveQueued = false;
let lastSaved = "";

function loadSavedGames() {
    try {
        return JSON.parse(fs.readFileSync(GAMES_STATE_FILE, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") {
            log.error("games", "Could not read games-state.json:", error);
        }
        return null;
    }
}

// read once at startup, the games come back when the bot connects (they need the socket for their timers)
let savedGames = loadSavedGames();

// a map that saves the games whenever one is added or removed
class SavedMap extends Map {
    set(key, value) {
        super.set(key, value);
        saveSoon();
        return this;
    }

    delete(key) {
        const removed = super.delete(key);
        saveSoon();
        return removed;
    }
}

function snapshotGames() {
    const out = { decrypt: {}, math: {}, wordle: {}, anagram: {}, numguess: {} };

    for (const [groupId, game] of decryptGames) {
        if (game.loading || game.tournamentRound || !game.word) continue;
        out.decrypt[groupId] = {
            word: game.word,
            revealed: [...game.revealedIndices],
            hintsUsed: game.hintsUsed || 0,
            startedAt: game.startedAt
        };
    }

    for (const [groupId, game] of activeMathGames) {
        if (game.tournamentRound) continue;
        out.math[groupId] = { answer: game.answer, question: game.question, startedAt: game.startedAt };
    }

    for (const [groupId, game] of wordleGames) {
        if (game.loading || !game.word) continue;
        out.wordle[groupId] = {
            word: game.word,
            guesses: game.guesses,
            hintsUsed: game.hintsUsed || 0,
            hinted: [...(game.hinted || [])],
            startedAt: game.startedAt
        };
    }

    for (const [groupId, game] of anagramGames) {
        if (game.loading || !game.word) continue;
        out.anagram[groupId] = {
            word: game.word,
            scrambled: game.scrambled,
            hintsUsed: game.hintsUsed || 0,
            startedAt: game.startedAt
        };
    }

    for (const [groupId, game] of numGuessGames) {
        out.numguess[groupId] = {
            secret: game.secret,
            max: game.max,
            low: game.low,
            high: game.high,
            guesses: game.guesses,
            hintsUsed: game.hintsUsed || 0,
            startedAt: game.startedAt,
            lastGuessAt: game.lastGuessAt
        };
    }

    return out;
}

function saveGames() {
    saveQueued = false;
    // hands off the file until the old games are back, or a start that never connects would wipe them
    if (!restored) {
        return;
    }

    try {
        const text = JSON.stringify(snapshotGames());
        if (text === lastSaved) {
            return;
        }
        // temp file first so a crash cant leave half a file behind
        const temp = `${GAMES_STATE_FILE}.tmp`;
        fs.writeFileSync(temp, text, "utf8");
        fs.renameSync(temp, GAMES_STATE_FILE);
        lastSaved = text;
    } catch (error) {
        log.error("games", "Could not save games-state.json:", error);
    }
}

function saveSoon() {
    if (!saveQueued) {
        saveQueued = true;
        setImmediate(saveGames);
    }
}

// guesses and hints change a game without adding or removing it, so check every few seconds too
setInterval(saveGames, 5000).unref();

// index.js calls this when the connection opens. games that ran out of time while the bot was
// down are dropped without a word, the rest carry on with whatever time they had left
function restoreGames(sock) {
    if (restored) {
        return;
    }
    restored = true;

    const saved = savedGames;
    savedGames = null;
    if (!saved) {
        return;
    }

    const now = Date.now();
    const timeLeft = (startedAt, limit) => Math.max(0, limit - (now - (Number(startedAt) || 0)));
    let count = 0;

    try {
        for (const [groupId, s] of Object.entries(saved.decrypt || {})) {
            const left = timeLeft(s.startedAt, DECRYPT_GAME_MS);
            if (!left || typeof s.word !== "string") continue;

            const game = {
                groupId,
                loading: false,
                word: s.word,
                revealedIndices: new Set(s.revealed),
                hintsUsed: s.hintsUsed || 0,
                timeout: null,
                tournamentRound: null,
                startedAt: s.startedAt
            };
            decryptGames.set(groupId, game);
            scheduleDecryptTimeout(sock, game, left);
            count += 1;
        }

        for (const [groupId, s] of Object.entries(saved.math || {})) {
            if (!s.question || now - (Number(s.startedAt) || 0) > MATH_RESTORE_MAX_MS) continue;

            activeMathGames.set(groupId, {
                answer: s.answer,
                question: s.question,
                startedAt: s.startedAt,
                tournamentRound: null
            });
            count += 1;
        }

        // the extra games stay off unless ENABLE_EXTRA_GAMES=1
        if (extraGamesEnabled()) {
            for (const [groupId, s] of Object.entries(saved.wordle || {})) {
                const left = timeLeft(s.startedAt, WORDLE_GAME_MS);
                if (!left || typeof s.word !== "string") continue;

                const game = {
                    loading: false,
                    word: s.word,
                    guesses: Array.isArray(s.guesses) ? s.guesses : [],
                    hintsUsed: s.hintsUsed || 0,
                    hinted: new Set(s.hinted),
                    timeout: null,
                    startedAt: s.startedAt
                };
                wordleGames.set(groupId, game);
                armTimer(sock, wordleGames, groupId, game, left, "Time is up, so the wordle game ended.", game => `The word was "${game.word}".`);
                count += 1;
            }

            for (const [groupId, s] of Object.entries(saved.anagram || {})) {
                const left = timeLeft(s.startedAt, ANAGRAM_GAME_MS);
                if (!left || typeof s.word !== "string") continue;

                const game = {
                    loading: false,
                    word: s.word,
                    scrambled: s.scrambled,
                    hintsUsed: s.hintsUsed || 0,
                    timeout: null,
                    startedAt: s.startedAt
                };
                anagramGames.set(groupId, game);
                armTimer(sock, anagramGames, groupId, game, left, "Time is up, so nobody got it.", game => `The word was "${game.word}".`);
                count += 1;
            }

            for (const [groupId, s] of Object.entries(saved.numguess || {})) {
                const left = timeLeft(s.startedAt, NUMGUESS_GAME_MS);
                const idleLeft = timeLeft(s.lastGuessAt, NUMGUESS_IDLE_MS);
                if (!left || !idleLeft) continue;

                const game = {
                    secret: s.secret,
                    max: s.max,
                    low: s.low,
                    high: s.high,
                    guesses: s.guesses || 0,
                    hintsUsed: s.hintsUsed || 0,
                    timeout: null,
                    startedAt: s.startedAt,
                    lastGuessAt: s.lastGuessAt
                };
                numGuessGames.set(groupId, game);
                armTimer(sock, numGuessGames, groupId, game, left, "Time is up, so the game ended.", game => `The number was ${game.secret}.`);
                armTimer(sock, numGuessGames, groupId, game, idleLeft, "Nobody guessed for a while, so the game ended.", game => `The number was ${game.secret}.`, "idleTimeout");
                count += 1;
            }
        }
    } catch (error) {
        log.error("games", "Could not bring back the saved games:", error);
    }

    if (count) {
        log.info("games", `brought back ${count} game${count === 1 ? "" : "s"} after the restart`);
    }
}


// ============================================================
// Extra functions
// ============================================================

const decryptGames = new SavedMap();

function formatDecryptWord(word, revealedIndices) {
    return Array.from(word, (character, index) =>
        revealedIndices.has(index) ? character : "#"
    ).join("");
}

// how long a decrypt game lasts, if nobody solves it by then it ends
const DECRYPT_GAME_MS = 2 * 60 * 1000;

function scheduleDecryptTimeout(sock, game, ms = DECRYPT_GAME_MS) {
    // remember when it started so a restart can work out how long is left
    game.startedAt = game.startedAt || Date.now();
    game.timeout = setTimeout(async () => {
        if (decryptGames.get(game.groupId) !== game) {
            return;
        }

        decryptGames.delete(game.groupId);
        try {
            await sock.sendMessage(game.groupId, {
                text: `Nobody solved it in time. The word was "${game.word}". git good hehe`
            });
        } catch (error) {
            log.error("games", "Error sending decrypt game timeout:", error);
        }

        if (
            game.tournamentRound &&
            tournaments.get(game.groupId) === game.tournamentRound &&
            game.tournamentRound.status === "running"
        ) {
            await startTournamentRound(sock, game.groupId);
        }
    }, ms);
}

// the old way of hinting, one more letter shows up. on the desktop ai a clue replaces this
function decryptHint(game) {
    game.hintsUsed = game.hintsUsed || 0;
    if (game.hintsUsed >= MAX_HINTS) {
        return `No more hints are available (used ${MAX_HINTS}/${MAX_HINTS}).`;
    }

    const hiddenIndices = Array.from(
        { length: game.word.length },
        (_, index) => index
    ).filter(index => !game.revealedIndices.has(index));

    // never hand over the whole word
    if (hiddenIndices.length <= 1) {
        return "There is nothing left to reveal.";
    }

    game.revealedIndices.add(hiddenIndices[Math.floor(Math.random() * hiddenIndices.length)]);
    game.hintsUsed += 1;
    return `Hint ${game.hintsUsed}/${MAX_HINTS}: ${formatDecryptWord(game.word, game.revealedIndices)}`;
}

function decryptHintText(game) {
    const shown = formatDecryptWord(game.word, game.revealedIndices);
    return limitedHint(game, () => aiHint(game, WORD_HINT_PROMPT, `Secret word: ${game.word}\nThe players see: ${shown}`, decryptHint));
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
        log.info("games", `Starting decrypt game in ${describeGroup(groupId)} with word: ${word}`);

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

        game.word = word.toLowerCase();
        game.loading = false;

        while (game.revealedIndices.size < Math.min(2, game.word.length - 3)) {
            game.revealedIndices.add(
                Math.floor(Math.random() * game.word.length)
            );
        }

        await sock.sendMessage(groupId, {
            text: `find the word hehe\n${formatDecryptWord(game.word, game.revealedIndices)}\nyou have 2 minutes. ask for a hint with !decrypt hint.`
        });

        if (decryptGames.get(groupId) === game) {
            scheduleDecryptTimeout(sock, game);
        }
        return true;
    } catch (error) {
        if (decryptGames.get(groupId) !== game) {
            return false;
        }
        decryptGames.delete(groupId);
        log.error("games", "Error starting decrypt game:", error);
        await sock.sendMessage(groupId, {
            text: "SOMETHING WENT WRONG BOOP BOOP BOOP ERROR ERROR ERROR HEHEHEHEHEHEHEHEH"
        });
        return false;
    }
}

// ============================================================
// More games
// ============================================================

const activeMathGames = new SavedMap();

async function startMathGame(sock, groupId, tournamentRound = null) {
    if (activeMathGames.has(groupId)) {
        await sock.sendMessage(groupId, {
            text: "A math game is already active in this group."
        });
        return false;
    }

    const operators = ["+", "-", "*", "/"];
    const operator = operators[Math.floor(Math.random() * operators.length)];
    let a, b, answer;

    switch (operator) {
        case "+":
            a = Math.floor(Math.random() * 100) + 1;
            b = Math.floor(Math.random() * 100) + 1;
            answer = a + b;
            break;
        case "-":
            a = Math.floor(Math.random() * 99) + 2;
            b = Math.floor(Math.random() * (a - 1)) + 1;
            answer = a - b;
            break;
        case "*":
            a = Math.floor(Math.random() * 12) + 1;
            b = Math.floor(Math.random() * 12) + 1;
            answer = a * b;
            break;
        case "/":
            b = Math.floor(Math.random() * 12) + 1;
            answer = Math.floor(Math.random() * 12) + 1;
            a = b * answer;
            break;
    }

    const game = { answer, question: "What is " + a + " " + operator + " " + b + "?", startedAt: Date.now(), tournamentRound };
    activeMathGames.set(groupId, game);
    log.info("games", `Starting math game in ${describeGroup(groupId)}: ${a} ${operator} ${b} = ${answer}`);

    try {
        await sock.sendMessage(groupId, {
            text: `What is ${a} ${operator} ${b}?`
        });
    } catch (error) {
        if (activeMathGames.get(groupId) === game) {
            activeMathGames.delete(groupId);
        }
        throw error;
    }

    return true;
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

const minigames = ["decrypt", "math"];

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

    const mathGame = activeMathGames.get(groupId);
    if (mathGame?.tournamentRound === tournament) {
        activeMathGames.delete(groupId);
    }

    return tournaments.delete(groupId);
}

async function startTournamentRound(sock, groupId) {
    const tournament = tournaments.get(groupId);
    if (
        !tournament ||
        tournament.status !== "running" ||
        decryptGames.has(groupId) ||
        activeMathGames.has(groupId)
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

    if (tournament.minigame === "math") {
        try {
            const started = await startMathGame(sock, groupId, tournament);
            if (!started && tournaments.get(groupId) === tournament) {
                tournament.status = "lobby";
            }
            return started;
        } catch (error) {
            if (tournaments.get(groupId) === tournament) {
                tournament.status = "lobby";
            }
            throw error;
        }
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
// Extra games. These stay off unless ENABLE_EXTRA_GAMES=1.
// !coin, !roll, !rps, !ttt, !numguess, !wordle, !anagram
// ============================================================

// Every extra game has a time limit, so a forgotten one cant block the group.
// tic-tac-toe, wordle and anagram have a total time limit. Number guessing has
// both a total limit and a shorter one for when nobody guesses.
const TTT_LOBBY_MS = 60 * 1000;
const TTT_GAME_MS = 3 * 60 * 1000;
const WORDLE_GAME_MS = 3 * 60 * 1000;
const ANAGRAM_GAME_MS = 90 * 1000;
const NUMGUESS_GAME_MS = 90 * 1000;
const NUMGUESS_IDLE_MS = 45 * 1000;

const tttGames = new Map();
const numGuessGames = new SavedMap();
const wordleGames = new SavedMap();
const anagramGames = new SavedMap();
const hotPotatoGames = new Map();

function extraGamesEnabled() {
    return process.env.ENABLE_EXTRA_GAMES === "1";
}

// Name of the extra game running in this group, or null.
function activeExtraGame(groupId) {
    if (tttGames.has(groupId)) return "tic-tac-toe";
    if (numGuessGames.has(groupId)) return "number guessing";
    if (wordleGames.has(groupId)) return "wordle";
    if (anagramGames.has(groupId)) return "anagram";
    if (hotPotatoGames.has(groupId)) return "hot potato";
    if (blackjackGames.has(groupId)) return "blackjack";
    if (wordChainGames.has(groupId)) return "word chain";
    return null;
}

function tag(playerId) {
    return `@${playerId.split("@")[0]}`;
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Stops every timer a game has.
function clearGameTimers(game) {
    clearTimeout(game.timeout);
    clearTimeout(game.idleTimeout);
}

// Ends the game after ms, saying why. Use key "idleTimeout" for a timer that
// gets restarted, and "timeout" for a total time limit.
function armTimer(sock, games, groupId, game, ms, message, revealAnswer, key = "timeout") {
    clearTimeout(game[key]);
    game[key] = setTimeout(async () => {
        if (games.get(groupId) !== game) {
            return;
        }

        games.delete(groupId);
        clearGameTimers(game);
        try {
            await sock.sendMessage(groupId, {
                text: message + (revealAnswer ? ` ${revealAnswer(game)}` : "")
            });
        } catch (error) {
            log.error("games", "Error sending game timeout message:", error);
        }
    }, ms);
    game[key].unref?.();
}

// Games follow the group's gamesenabled setting. Group-only games say no in DMs.
async function gameAllowed(sock, msg, { chatId, isGroup }, groupOnlyLabel = null) {
    if (!isGroup) {
        if (groupOnlyLabel) {
            await reply(sock, msg, `The ${groupOnlyLabel} game can only be played in a group.`);
            return false;
        }
        return true;
    }

    if (!getGroupSetting(chatId, "gamesenabled")) {
        await reply(sock, msg, "A moderator has disabled games in this group.");
        return false;
    }

    return true;
}

// One game per group at a time.
async function canStartGame(sock, msg, chatId) {
    if (getTournament(chatId)) {
        await reply(
            sock,
            msg,
            "A tournament is already being organized or played in this group."
        );
        return false;
    }

    if (decryptGames.has(chatId)) {
        await reply(sock, msg, "Finish the current decrypt game before starting another game.");
        return false;
    }

    if (activeMathGames.has(chatId)) {
        await reply(sock, msg, "Finish the current math game before starting another game.");
        return false;
    }

    const extraGame = activeExtraGame(chatId);
    if (extraGame) {
        await reply(sock, msg, `Finish the current ${extraGame} game before starting another game.`);
        return false;
    }

    return true;
}


// ----------------------------------------------------
// !coin
// ----------------------------------------------------

async function handleCoin(sock, msg, ctx) {
    if (!await gameAllowed(sock, msg, ctx)) {
        return;
    }

    await reply(sock, msg, Math.random() < 0.5 ? "Heads." : "Tails.");
}


// ----------------------------------------------------
// !roll [sides] or !roll <count>d<sides>
// ----------------------------------------------------

async function handleRoll(sock, msg, ctx) {
    if (!await gameAllowed(sock, msg, ctx)) {
        return;
    }

    const usage = `Usage: ${ctx.commandPrefix}roll [sides] or ${ctx.commandPrefix}roll <count>d<sides> (1-20 dice, 2-1000 sides)`;
    const argument = ctx.text.slice("!roll".length).trim().toLowerCase();

    let count = 1;
    let sides = 6;
    if (argument) {
        const match = /^(?:(\d{1,2})d)?(\d{1,4})$/.exec(argument);
        if (!match) {
            await reply(sock, msg, usage);
            return;
        }
        count = match[1] ? Number(match[1]) : 1;
        sides = Number(match[2]);
    }

    if (count < 1 || count > 20 || sides < 2 || sides > 1000) {
        await reply(sock, msg, usage);
        return;
    }

    const rolls = Array.from({ length: count }, () => randomInt(1, sides));
    if (count === 1) {
        await reply(sock, msg, `You rolled a ${rolls[0]} (d${sides}).`);
        return;
    }

    const total = rolls.reduce((sum, roll) => sum + roll, 0);
    await reply(sock, msg, `You rolled ${count}d${sides}: ${rolls.join(" + ")} = ${total}`);
}


// ----------------------------------------------------
// !rps <rock|paper|scissors>
// ----------------------------------------------------

const RPS_CHOICES = {
    r: "rock", rock: "rock",
    p: "paper", paper: "paper",
    s: "scissors", scissors: "scissors"
};
const RPS_BEATS = { rock: "scissors", paper: "rock", scissors: "paper" };

async function handleRps(sock, msg, ctx) {
    if (!await gameAllowed(sock, msg, ctx)) {
        return;
    }

    const choice = RPS_CHOICES[ctx.text.slice("!rps".length).trim().toLowerCase()];
    if (!choice) {
        await reply(sock, msg, `Usage: ${ctx.commandPrefix}rps <rock|paper|scissors>`);
        return;
    }

    const options = Object.keys(RPS_BEATS);
    const botChoice = options[randomInt(0, options.length - 1)];
    let result = "It's a tie.";
    if (RPS_BEATS[choice] === botChoice) {
        result = "You win.";
    } else if (RPS_BEATS[botChoice] === choice) {
        result = "I win.";
    }

    await reply(sock, msg, `You chose ${choice}, I chose ${botChoice}. ${result}`);
}


// ----------------------------------------------------
// !ttt (tic-tac-toe)
// Someone opens a lobby, a second player joins with !ttt join, then they take
// turns sending a square number (1-9).
// ----------------------------------------------------

const TTT_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
];

function renderTttBoard(board) {
    const cell = index => board[index] ?? String(index + 1);
    const row = start => ` ${cell(start)} | ${cell(start + 1)} | ${cell(start + 2)} `;
    return [
        "```",
        row(0),
        "---+---+---",
        row(3),
        "---+---+---",
        row(6),
        "```"
    ].join("\n");
}

function tttWinner(board) {
    for (const [a, b, c] of TTT_LINES) {
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return board[a];
        }
    }
    return null;
}

function tttTurnText(game) {
    const mark = game.turn === 0 ? "X" : "O";
    return `${tag(game.players[game.turn])}'s turn (${mark}). Send a square number from 1 to 9.`;
}

async function handleTtt(sock, msg, ctx) {
    const { chatId, senderJid, text, trusted, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "tic-tac-toe")) {
        return;
    }

    const argument = text.slice("!ttt".length).trim().toLowerCase();
    const game = tttGames.get(chatId);

    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no tic-tac-toe game to cancel.");
            return;
        }
        if (!game.players.includes(senderJid) && !trusted) {
            await reply(sock, msg, "Only a player or a trusted user can cancel the game.");
            return;
        }

        clearGameTimers(game);
        tttGames.delete(chatId);
        await reply(sock, msg, "The tic-tac-toe game was cancelled.");
        return;
    }

    if (argument === "ai") {
        if (!await canStartGame(sock, msg, chatId)) {
            return;
        }

        const botGame = {
            players: [senderJid, null],
            vsBot: true,
            board: Array(9).fill(null),
            turn: 0,
            status: "playing",
            timeout: null
        };
        tttGames.set(chatId, botGame);
        armTimer(sock, tttGames, chatId, botGame, TTT_GAME_MS, "Time is up, so the tic-tac-toe game ended.");
        await sock.sendMessage(chatId, {
            text: `${tag(senderJid)} (X) vs me (O)\n${renderTttBoard(botGame.board)}\n${tttTurnText(botGame)}`,
            mentions: [senderJid]
        });
        return;
    }

    if (argument === "join") {
        if (!game) {
            await reply(sock, msg, `There is no tic-tac-toe lobby to join. Start one with ${commandPrefix}ttt.`);
            return;
        }
        if (game.status !== "lobby") {
            await reply(sock, msg, "That game already has two players.");
            return;
        }
        if (game.players[0] === senderJid) {
            await reply(sock, msg, "You can't play against yourself.");
            return;
        }

        game.players[1] = senderJid;
        game.status = "playing";
        armTimer(sock, tttGames, chatId, game, TTT_GAME_MS, "Time is up, so the tic-tac-toe game ended.");
        await sock.sendMessage(chatId, {
            text: `${tag(game.players[0])} (X) vs ${tag(game.players[1])} (O)\n${renderTttBoard(game.board)}\n${tttTurnText(game)}`,
            mentions: [...game.players]
        });
        return;
    }

    if (argument) {
        await reply(sock, msg, `Usage: ${commandPrefix}ttt [join|ai|cancel]`);
        return;
    }

    if (game) {
        const status = game.status === "lobby"
            ? `Waiting for an opponent. Send ${commandPrefix}ttt join to play.`
            : tttTurnText(game);
        await sock.sendMessage(chatId, {
            text: `${renderTttBoard(game.board)}\n${status}`,
            mentions: game.players.filter(Boolean)
        });
        return;
    }

    if (!await canStartGame(sock, msg, chatId)) {
        return;
    }

    const newGame = {
        players: [senderJid, null],
        board: Array(9).fill(null),
        turn: 0,
        status: "lobby",
        timeout: null
    };
    tttGames.set(chatId, newGame);
    armTimer(sock, tttGames, chatId, newGame, TTT_LOBBY_MS, "Nobody joined, so the tic-tac-toe lobby closed.");
    await sock.sendMessage(chatId, {
        text: `${tag(senderJid)} wants to play tic-tac-toe as X. Send ${commandPrefix}ttt join to play as O.`,
        mentions: [senderJid]
    });
}

// the desktop ai picks the square when it can. if it picks something that isnt free (or the desktop isnt on) the built in bot plays instead
async function pickTttBotMove(board) {
    const free = board.map((cell, index) => (cell ? null : index)).filter(index => index !== null);

    const rows = [0, 3, 6]
        .map(start => [0, 1, 2].map(offset => board[start + offset] ?? String(start + offset + 1)).join(" | "))
        .join("\n");
    const answer = await askDesktop(
        "You are playing tic-tac-toe as O against a player who is X. The squares are numbered 1 to 9, left to right, top to bottom. Reply with only the number of the square you want to play, nothing else.",
        `Board (numbers are free squares):\n${rows}\nFree squares: ${free.map(index => index + 1).join(", ")}`,
        15 * 1000
    );

    const picked = Number(/[1-9]/.exec(answer || "")?.[0]) - 1;
    return free.includes(picked) ? picked : simpleTttMove(board, free);
}

// the built in bot, takes a win, blocks a loss, then the middle, then corners, then whatever is left
function simpleTttMove(board, free) {
    const finishing = mark => {
        for (const line of TTT_LINES) {
            const marks = line.map(index => board[index]);
            if (marks.filter(cell => cell === mark).length === 2 && marks.includes(null)) {
                return line[marks.indexOf(null)];
            }
        }
        return null;
    };

    const move = finishing("O") ?? finishing("X");
    if (move !== null) {
        return move;
    }

    for (const wanted of [4, 0, 2, 6, 8]) {
        if (free.includes(wanted)) {
            return wanted;
        }
    }
    return free[0];
}

// A plain 1-9 message from whoever's turn it is.
async function handleTttMove(sock, chatId, senderJid, text) {
    const game = tttGames.get(chatId);
    if (
        !game ||
        game.status !== "playing" ||
        !/^[1-9]$/.test(text.trim()) ||
        senderJid !== game.players[game.turn]
    ) {
        return false;
    }

    const square = Number(text.trim()) - 1;
    if (game.board[square]) {
        await sock.sendMessage(chatId, { text: "That square is already taken." });
        return true;
    }

    game.board[square] = game.turn === 0 ? "X" : "O";

    const winner = tttWinner(game.board);
    if (winner || game.board.every(Boolean)) {
        clearGameTimers(game);
        tttGames.delete(chatId);
        await sock.sendMessage(chatId, {
            text: `${renderTttBoard(game.board)}\n` +
                (winner ? `${tag(senderJid)} wins!` : "It's a draw."),
            mentions: [senderJid]
        });
        return true;
    }

    // against the bot it answers right away. the turn stays on it until its done so nobody can move meanwhile
    if (game.vsBot) {
        game.turn = 1;
        const botSquare = await pickTttBotMove(game.board);
        // the game might have been cancelled or timed out while the ai was thinking
        if (tttGames.get(chatId) !== game) {
            return true;
        }

        game.board[botSquare] = "O";
        const botWinner = tttWinner(game.board);
        if (botWinner || game.board.every(Boolean)) {
            clearGameTimers(game);
            tttGames.delete(chatId);
            await sock.sendMessage(chatId, {
                text: `${renderTttBoard(game.board)}\nI played ${botSquare + 1}. ${botWinner ? "I win!" : "It's a draw."}`
            });
            return true;
        }

        game.turn = 0;
        await sock.sendMessage(chatId, {
            text: `${renderTttBoard(game.board)}\nI played ${botSquare + 1}. ${tttTurnText(game)}`,
            mentions: [senderJid]
        });
        return true;
    }

    game.turn = game.turn === 0 ? 1 : 0;
    await sock.sendMessage(chatId, {
        text: `${renderTttBoard(game.board)}\n${tttTurnText(game)}`,
        mentions: [...game.players]
    });
    return true;
}


// ----------------------------------------------------
// !numguess [max]
// The bot picks a number and the group guesses by sending plain numbers.
// It says higher or lower.
// ----------------------------------------------------

const MAX_HINTS = 2;
// hints cant be spammed. the first one waits a bit after the game starts, then each one waits for a pause
// seconds from .env. 0 turns that wait off, and anything that isnt a number falls back to the default.
// its read every time so a change in .env only needs a restart, and it doesnt matter when the env gets loaded
function hintSeconds(name, fallback) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
        return fallback;
    }

    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : fallback;
}

// how long into a game before the first hint works
function hintFirstDelayMs() {
    return hintSeconds("HINT_START_DELAY_SECONDS", 30) * 1000;
}

// how long to wait between hints
function hintGapMs() {
    return hintSeconds("HINT_COOLDOWN_SECONDS", 30) * 1000;
}

// milliseconds left before a hint is allowed, zero or less means go ahead. the first hint counts from when the game started, the rest from the last hint
function hintWait(game) {
    const readyAt = game.lastHintAt
        ? game.lastHintAt + hintGapMs()
        : (game.startedAt || 0) + hintFirstDelayMs();
    return readyAt - Date.now();
}

// checks the limits before making a hint, and starts the pause once one really goes out
async function limitedHint(game, makeHint) {
    game.hintsUsed = game.hintsUsed || 0;
    if (game.hintsUsed >= MAX_HINTS) {
        return `No more hints are available (used ${MAX_HINTS}/${MAX_HINTS}).`;
    }

    const wait = hintWait(game);
    if (wait > 0) {
        const seconds = Math.ceil(wait / 1000);
        return `Please wait ${seconds} more ${seconds === 1 ? "second" : "seconds"} before asking for a hint.`;
    }

    const before = game.hintsUsed;
    const answer = await makeHint();
    // only start the pause when a hint actually went out, not for a still thinking reply or when theres nothing left to reveal
    if (game.hintsUsed > before) {
        game.lastHintAt = Date.now();
    }
    return answer;
}

// First hint says if the number is odd or even. The second one gives a window
// around it that is about a quarter of what is still possible.
function numGuessHint(game) {
    game.hintsUsed = game.hintsUsed || 0;
    if (game.hintsUsed >= MAX_HINTS) {
        return `No more hints are available (used ${MAX_HINTS}/${MAX_HINTS}).`;
    }

    if (game.hintsUsed === 0) {
        game.hintsUsed += 1;
        return `Hint 1/${MAX_HINTS}: the number is ${game.secret % 2 === 0 ? "even" : "odd"}.`;
    }

    const size = game.high - game.low + 1;
    if (size <= 3) {
        return "The range is already small, so the hint cannot narrow it further.";
    }

    const width = Math.max(2, Math.ceil(size / 4));
    const earliest = Math.max(game.low, game.secret - width + 1);
    const latest = Math.min(game.secret, game.high - width + 1);
    const start = randomInt(earliest, Math.max(earliest, latest));
    const end = Math.min(game.high, start + width - 1);
    game.hintsUsed += 1;
    return `Hint 2/${MAX_HINTS}: the number is between ${start} and ${end}.`;
}

async function handleNumGuess(sock, msg, ctx) {
    const { chatId, text, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "number guessing")) {
        return;
    }

    const argument = text.slice("!numguess".length).trim().toLowerCase();
    const game = numGuessGames.get(chatId);

    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no number guessing game to cancel.");
            return;
        }

        clearGameTimers(game);
        numGuessGames.delete(chatId);
        await reply(sock, msg, `The game was cancelled. The number was ${game.secret}.`);
        return;
    }

    if (argument === "hint") {
        if (!game) {
            await reply(sock, msg, `There is no number guessing game in progress. Start one with ${commandPrefix}numguess.`);
            return;
        }
        await reply(sock, msg, await limitedHint(game, async () => numGuessHint(game)));
        return;
    }

    if (game) {
        await reply(
            sock,
            msg,
            `A number guessing game is already running. It's between ${game.low} and ${game.high}. Send a number to guess.`
        );
        return;
    }

    let max = 100;
    if (argument) {
        if (!/^\d{1,6}$/.test(argument) || Number(argument) < 10 || Number(argument) > 100000) {
            await reply(sock, msg, `Usage: ${commandPrefix}numguess [max] (max from 10 to 100000, default 100)`);
            return;
        }
        max = Number(argument);
    }

    if (!await canStartGame(sock, msg, chatId)) {
        return;
    }

    const newGame = {
        secret: randomInt(1, max),
        max,
        low: 1,
        high: max,
        guesses: 0,
        startedAt: Date.now(),
        lastGuessAt: Date.now(),
        timeout: null
    };
    numGuessGames.set(chatId, newGame);
    log.info("games", `Starting number guessing game in ${describeGroup(chatId)}, 1 to ${max}, the number is: ${newGame.secret}`);
    armTimer(sock, numGuessGames, chatId, newGame, NUMGUESS_GAME_MS, "Time is up, so the game ended.", game => `The number was ${game.secret}.`);
    armTimer(sock, numGuessGames, chatId, newGame, NUMGUESS_IDLE_MS, "Nobody guessed for a while, so the game ended.", game => `The number was ${game.secret}.`, "idleTimeout");
    await sock.sendMessage(chatId, {
        text: `I'm thinking of a number between 1 and ${max}. Send a number to guess it.`
    });
}

async function handleNumGuessAnswer(sock, msg, chatId, senderJid, text) {
    const game = numGuessGames.get(chatId);
    if (!game || !/^\d{1,7}$/.test(text.trim())) {
        return false;
    }

    const guess = Number(text.trim());
    if (guess < 1 || guess > game.max) {
        return false;
    }

    game.guesses += 1;

    if (guess === game.secret) {
        log.info("games", `${describeSender(msg)} guessed the number in ${describeGroup(chatId)}. The number was ${game.secret}, found in ${game.guesses} ${game.guesses === 1 ? "guess" : "guesses"}`);
        clearGameTimers(game);
        numGuessGames.delete(chatId);
        await sock.sendMessage(chatId, {
            text: `${tag(senderJid)} got it! The number was ${game.secret}, found in ${game.guesses} ${game.guesses === 1 ? "guess" : "guesses"}.`,
            mentions: [senderJid]
        });
        return true;
    }

    if (guess < game.secret) {
        game.low = Math.max(game.low, guess + 1);
    } else {
        game.high = Math.min(game.high, guess - 1);
    }

    game.lastGuessAt = Date.now();
    armTimer(sock, numGuessGames, chatId, game, NUMGUESS_IDLE_MS, "Nobody guessed for a while, so the game ended.", game => `The number was ${game.secret}.`, "idleTimeout");
    await sock.sendMessage(chatId, {
        text: `${guess < game.secret ? "Higher" : "Lower"}. It's between ${game.low} and ${game.high}.`
    });
    return true;
}


// ----------------------------------------------------
// !wordle
// The group shares six guesses at a five-letter word, sent as !wordle <word>.
// Any five letters count, theres no dictionary check.
// ----------------------------------------------------

const WORDLE_LENGTH = 5;
const WORDLE_MAX_GUESSES = 6;

function wordlePattern(answer, guess) {
    const pattern = Array(guess.length).fill("⬛");
    const remaining = {};

    for (let index = 0; index < guess.length; index += 1) {
        if (guess[index] === answer[index]) {
            pattern[index] = "🟩";
        } else {
            remaining[answer[index]] = (remaining[answer[index]] || 0) + 1;
        }
    }

    for (let index = 0; index < guess.length; index += 1) {
        if (pattern[index] !== "🟩" && remaining[guess[index]] > 0) {
            pattern[index] = "🟨";
            remaining[guess[index]] -= 1;
        }
    }

    return pattern.join("");
}

function wordleBoard(game) {
    return game.guesses
        .map(({ word, pattern }) => `${pattern} ${word.toUpperCase()}`)
        .join("\n");
}

// Reveals one letter that nobody has placed yet, up to MAX_HINTS per game.
function wordleHint(game) {
    game.hintsUsed = game.hintsUsed || 0;
    if (game.hintsUsed >= MAX_HINTS) {
        return `No more hints are available (used ${MAX_HINTS}/${MAX_HINTS}).`;
    }

    game.hinted = game.hinted || new Set();
    const open = [];
    for (let index = 0; index < game.word.length; index += 1) {
        const solved = game.guesses.some(guess => guess.word[index] === game.word[index]);
        if (!solved && !game.hinted.has(index)) {
            open.push(index);
        }
    }

    if (!open.length) {
        return "Every letter has already been placed, so there is nothing left to reveal.";
    }

    const index = open[randomInt(0, open.length - 1)];
    game.hinted.add(index);
    game.hintsUsed += 1;
    return `Hint ${game.hintsUsed}/${MAX_HINTS}: letter ${index + 1} is ${game.word[index].toUpperCase()}.`;
}

// what the ai is told when it gives a hint in a word game
const WORD_HINT_PROMPT = "You give hints for a word guessing game in a WhatsApp group. Give one short clue about the secret word in 15 words or less. Only say things you are sure are true about this exact word. If it has more than one meaning, pick the most common one and only talk about that. If you are not sure what the word means, do not guess, just say what kind of word it is (like a noun, a verb, an adjective, a name or a place). Never make up facts. Never write the word, never spell it out and never list its letters. Plain text only. If a dictionary definition is given, base your clue on it and reword it in your own words, never copy it.";

// two clues count as the same when most of their words overlap
function sameClue(a, b) {
    const words = text => new Set(String(text).toLowerCase().match(/[a-z]+/g) || []);
    const first = words(a);
    const second = words(b);
    let shared = 0;
    for (const word of first) {
        if (second.has(word)) {
            shared += 1;
        }
    }
    const total = first.size + second.size - shared;
    return total > 0 && shared / total >= 0.6;
}

// on the desktop ai the hint is a clue from the ai, on the pi it stays the old letter reveal. an ai clue counts as one of the hints too
async function aiHint(game, system, prompt, oldHint) {
    game.hintsUsed = game.hintsUsed || 0;
    // the old hint already knows how to say no more hints
    if (game.hintsUsed >= MAX_HINTS) return oldHint(game);
    if (game.aiHinting) return "Still thinking of a hint. Give me a moment.";

    game.aiHinting = true;
    // the clues we already gave, so the ai doesnt say the same thing twice
    game.clues = game.clues || [];
    let clue = null;
    try {
        // a real definition from the dictionary so the ai rewords it instead of guessing
        const definition = await getDefinition(game.word);
        let fullPrompt = definition ? `${prompt}\nDictionary definition (the word is blanked out): ${definition}` : prompt;
        // without this it gives the exact same clue every time, since it gets the same definition
        if (game.clues.length) {
            fullPrompt += `\nClues you already gave (do not repeat or reword these, point at a different side of the word): ${game.clues.join(" | ")}`;
        }
        clue = await askDesktop(system, fullPrompt);
    } finally {
        game.aiHinting = false;
    }

    // the ai sometimes blurts the word out. if it did, or never answered, use the old hint
    clue = clue?.replace(/\s+/g, " ").slice(0, 200);
    if (!clue || clue.toLowerCase().replace(/[^a-z]/g, "").includes(game.word)) {
        return oldHint(game);
    }

    // it said the same thing again anyway, so show the letter hint instead of a repeat
    if (game.clues.some(old => sameClue(old, clue))) {
        return oldHint(game);
    }

    game.clues.push(clue);
    game.hintsUsed += 1;
    return `Hint ${game.hintsUsed}/${MAX_HINTS}: ${clue}`;
}

function wordleHintText(game) {
    const guesses = game.guesses.map(guess => `${guess.word} ${guess.pattern}`).join("\n") || "none yet";
    return limitedHint(game, () => aiHint(game, WORD_HINT_PROMPT, `Secret word: ${game.word}\nGuesses so far:\n${guesses}`, wordleHint));
}

async function startWordleGame(sock, msg, chatId, commandPrefix) {
    const game = {
        loading: true,
        word: null,
        guesses: [],
        timeout: null
    };
    wordleGames.set(chatId, game);

    try {
        const word = await randomWord("1", WORDLE_LENGTH);

        if (wordleGames.get(chatId) !== game) {
            return;
        }

        if (typeof word !== "string" || !/^[a-z]{5}$/i.test(word)) {
            wordleGames.delete(chatId);
            await reply(sock, msg, "I couldn't get a word for wordle. Try again in a moment.");
            return;
        }

        game.word = word.toLowerCase();
        game.loading = false;
        game.startedAt = Date.now();
        log.info("games", `Starting wordle game in ${describeGroup(chatId)} with word: ${game.word}`);
        armTimer(sock, wordleGames, chatId, game, WORDLE_GAME_MS, "Time is up, so the wordle game ended.", game => `The word was "${game.word}".`);
        await sock.sendMessage(chatId, {
            text: `Wordle! Guess the ${WORDLE_LENGTH}-letter word in ${WORDLE_MAX_GUESSES} tries with ${commandPrefix}wordle <word>.`
        });
    } catch (error) {
        if (wordleGames.get(chatId) === game) {
            wordleGames.delete(chatId);
        }
        log.error("games", "Error starting wordle game:", error);
        await reply(sock, msg, "Something went wrong while starting wordle.");
    }
}

async function handleWordle(sock, msg, ctx) {
    const { chatId, senderJid, text, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "wordle")) {
        return;
    }

    const argument = text.slice("!wordle".length).trim().toLowerCase();
    const game = wordleGames.get(chatId);

    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no wordle game to cancel.");
            return;
        }

        clearGameTimers(game);
        wordleGames.delete(chatId);
        await reply(
            sock,
            msg,
            game.loading
                ? "The wordle game was cancelled."
                : `The wordle game was cancelled. The word was "${game.word}".`
        );
        return;
    }

    if (argument === "hint") {
        if (!game || game.loading) {
            await reply(
                sock,
                msg,
                game
                    ? "A wordle game is starting. Please wait."
                    : `There is no wordle game in progress. Start one with ${commandPrefix}wordle.`
            );
            return;
        }
        await reply(sock, msg, await wordleHintText(game));
        return;
    }

    if (argument) {
        if (!game) {
            await reply(sock, msg, `There is no wordle game in progress. Start one with ${commandPrefix}wordle.`);
            return;
        }
        if (game.loading) {
            await reply(sock, msg, "A wordle game is starting. Please wait.");
            return;
        }
        if (!new RegExp(`^[a-z]{${WORDLE_LENGTH}}$`).test(argument)) {
            await reply(sock, msg, `Guesses must be a ${WORDLE_LENGTH}-letter word, like ${commandPrefix}wordle crane`);
            return;
        }
        if (game.guesses.some(guess => guess.word === argument)) {
            await reply(sock, msg, "That word was already guessed.");
            return;
        }

        game.guesses.push({
            word: argument,
            pattern: wordlePattern(game.word, argument)
        });

        if (argument === game.word) {
            log.info("games", `${describeSender(msg)} solved the wordle in ${describeGroup(chatId)} in ${game.guesses.length}/${WORDLE_MAX_GUESSES}. The word was: ${game.word}`);
            clearGameTimers(game);
            wordleGames.delete(chatId);
            await sock.sendMessage(chatId, {
                text: `${wordleBoard(game)}\n${tag(senderJid)} solved it in ${game.guesses.length}/${WORDLE_MAX_GUESSES}! The word was "${game.word}".`,
                mentions: [senderJid]
            });
            return;
        }

        if (game.guesses.length >= WORDLE_MAX_GUESSES) {
            clearGameTimers(game);
            wordleGames.delete(chatId);
            await sock.sendMessage(chatId, {
                text: `${wordleBoard(game)}\nOut of guesses. The word was "${game.word}".`
            });
            return;
        }

        await sock.sendMessage(chatId, {
            text: `${wordleBoard(game)}\n${WORDLE_MAX_GUESSES - game.guesses.length} guesses left.`
        });
        return;
    }

    if (game) {
        await reply(
            sock,
            msg,
            game.loading
                ? "A wordle game is starting. Please wait."
                : `A wordle game is already running. Guess with ${commandPrefix}wordle <word>.\n${wordleBoard(game)}`
        );
        return;
    }

    if (!await canStartGame(sock, msg, chatId)) {
        return;
    }

    await startWordleGame(sock, msg, chatId, commandPrefix);
}


// ----------------------------------------------------
// !anagram
// The bot scrambles a word. First person to send the unscrambled word wins.
// ----------------------------------------------------

function scrambleWord(word) {
    const letters = word.split("");

    for (let attempt = 0; attempt < 20; attempt += 1) {
        for (let index = letters.length - 1; index > 0; index -= 1) {
            const other = randomInt(0, index);
            [letters[index], letters[other]] = [letters[other], letters[index]];
        }

        const scrambled = letters.join("");
        if (scrambled !== word) {
            return scrambled;
        }
    }

    return null;
}

// First hint shows the first letter, the second one shows the last letter too.
function anagramHint(game) {
    game.hintsUsed = game.hintsUsed || 0;
    if (game.hintsUsed >= MAX_HINTS) {
        return `No more hints are available (used ${MAX_HINTS}/${MAX_HINTS}).`;
    }

    game.hintsUsed += 1;
    const letters = game.word.split("").map(() => "_");
    letters[0] = game.word[0];
    if (game.hintsUsed >= 2) {
        letters[letters.length - 1] = game.word[game.word.length - 1];
    }
    return `Hint ${game.hintsUsed}/${MAX_HINTS}: ${letters.join(" ").toUpperCase()}`;
}

function anagramHintText(game) {
    return limitedHint(game, () => aiHint(game, WORD_HINT_PROMPT, `Secret word: ${game.word}\nScrambled letters: ${game.scrambled}`, anagramHint));
}

async function startAnagramGame(sock, msg, chatId) {
    const game = {
        loading: true,
        word: null,
        scrambled: null,
        timeout: null
    };
    anagramGames.set(chatId, game);

    try {
        const word = await randomWord("1", 6);

        if (anagramGames.get(chatId) !== game) {
            return;
        }

        if (typeof word !== "string" || !/^[a-z]{4,}$/i.test(word)) {
            anagramGames.delete(chatId);
            await reply(sock, msg, "I couldn't get a word for the anagram. Try again in a moment.");
            return;
        }

        const lowerWord = word.toLowerCase();
        const scrambled = scrambleWord(lowerWord);
        if (!scrambled) {
            anagramGames.delete(chatId);
            await reply(sock, msg, "I couldn't scramble that word. Try again.");
            return;
        }

        game.word = lowerWord;
        game.scrambled = scrambled;
        game.startedAt = Date.now();
        log.info("games", `Starting anagram game in ${describeGroup(chatId)} with word: ${lowerWord} (scrambled: ${scrambled})`);
        game.loading = false;
        armTimer(sock, anagramGames, chatId, game, ANAGRAM_GAME_MS, "Time is up, so nobody got it.", game => `The word was "${game.word}".`);
        await sock.sendMessage(chatId, {
            text: `Unscramble this word: ${scrambled.toUpperCase()}`
        });
    } catch (error) {
        if (anagramGames.get(chatId) === game) {
            anagramGames.delete(chatId);
        }
        log.error("games", "Error starting anagram game:", error);
        await reply(sock, msg, "Something went wrong while starting the anagram.");
    }
}

async function handleAnagram(sock, msg, ctx) {
    const { chatId, text, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "anagram")) {
        return;
    }

    const argument = text.slice("!anagram".length).trim().toLowerCase();
    const game = anagramGames.get(chatId);

    if (argument === "cancel" || argument === "skip") {
        if (!game) {
            await reply(sock, msg, "There is no anagram to skip.");
            return;
        }

        clearGameTimers(game);
        anagramGames.delete(chatId);
        await reply(
            sock,
            msg,
            game.loading
                ? "The anagram was cancelled."
                : `The anagram was skipped. The word was "${game.word}".`
        );
        return;
    }

    if (argument === "hint") {
        if (!game || game.loading) {
            await reply(
                sock,
                msg,
                game
                    ? "An anagram is starting. Please wait."
                    : `There is no anagram in progress. Start one with ${commandPrefix}anagram.`
            );
            return;
        }
        await reply(sock, msg, await anagramHintText(game));
        return;
    }

    if (argument) {
        await reply(sock, msg, `Usage: ${commandPrefix}anagram [hint|skip]`);
        return;
    }

    if (game) {
        await reply(
            sock,
            msg,
            game.loading
                ? "An anagram is starting. Please wait."
                : `An anagram is already running: ${game.scrambled.toUpperCase()}`
        );
        return;
    }

    if (!await canStartGame(sock, msg, chatId)) {
        return;
    }

    await startAnagramGame(sock, msg, chatId);
}

async function handleAnagramAnswer(sock, msg, chatId, senderJid, text) {
    const game = anagramGames.get(chatId);
    if (
        !game ||
        game.loading ||
        text.trim().toLowerCase() !== game.word
    ) {
        return false;
    }

    log.info("games", `${describeSender(msg)} solved the anagram in ${describeGroup(chatId)}. The word was: ${game.word}`);
    clearGameTimers(game);
    anagramGames.delete(chatId);
    await sock.sendMessage(chatId, {
        text: `${tag(senderJid)} got it first. The word was "${game.word}".`,
        mentions: [senderJid]
    });
    return true;
}

// ----------------------------------------------------
// !hotpotato and !pass
// Someone starts the potato, whoever holds it passes it on with !pass @user
// before the fuse runs out. Whoever holds it when it explodes loses.
// ----------------------------------------------------

const HOTPOTATO_MIN_MS = 20 * 1000;
const HOTPOTATO_MAX_MS = 40 * 1000;

// WhatsApp can show the same person as a phone number or a LID depending on
// where you look, so a player is remembered by every id we know for them.
function senderIds(msg) {
    return [msg.key.participant, msg.key.participantAlt].filter(Boolean);
}

function sameWho(ids, otherIds) {
    return ids.some(id => otherIds.includes(id));
}

function botIds(sock) {
    return [sock.user?.id, sock.user?.lid]
        .filter(Boolean)
        .map(id => id.replace(/:\d+@/, "@"));
}

// A mention can be in a different id format than the one the player writes
// with, so look the player up in the group list to collect all of their ids.
async function knownIds(sock, chatId, jid) {
    const ids = [jid];
    try {
        const metadata = await sock.groupMetadata(chatId);
        const member = metadata.participants.find(participant =>
            [participant.id, participant.lid, participant.jid, participant.phoneNumber].includes(jid)
        );
        if (member) {
            for (const id of [member.id, member.lid, member.jid, member.phoneNumber]) {
                if (id && !ids.includes(id)) {
                    ids.push(id);
                }
            }
        }
    } catch (error) {
        log.error("games", "Could not look up the group members for the hot potato:", error);
    }
    return ids;
}

function potatoText(game) {
    return `Hot potato: ${tag(game.holder.jid)} is holding the potato. Use !pass @user to pass it on before it explodes.`;
}

async function handleHotPotato(sock, msg, ctx) {
    const { chatId, senderJid, text, trusted, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "hot potato")) {
        return;
    }

    const argument = text.slice("!hotpotato".length).trim().toLowerCase();
    const game = hotPotatoGames.get(chatId);

    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no hot potato game to cancel.");
            return;
        }
        if (!sameWho(senderIds(msg), game.starterIds) && !trusted) {
            await reply(sock, msg, "Only the player who started the game or a trusted user can cancel it.");
            return;
        }

        clearGameTimers(game);
        hotPotatoGames.delete(chatId);
        await reply(sock, msg, "The hot potato game has been cancelled.");
        return;
    }

    if (argument) {
        await reply(sock, msg, `Usage: ${commandPrefix}hotpotato [cancel]`);
        return;
    }

    if (game) {
        await sock.sendMessage(chatId, { text: potatoText(game), mentions: [game.holder.jid] });
        return;
    }

    if (!await canStartGame(sock, msg, chatId)) {
        return;
    }

    const newGame = {
        holder: { jid: senderJid, ids: senderIds(msg) },
        from: null,
        starterIds: senderIds(msg),
        timeout: null
    };
    hotPotatoGames.set(chatId, newGame);

    newGame.timeout = setTimeout(async () => {
        if (hotPotatoGames.get(chatId) !== newGame) {
            return;
        }

        hotPotatoGames.delete(chatId);
        try {
            await sock.sendMessage(chatId, {
                text: `The potato has exploded. ${tag(newGame.holder.jid)} was holding it.`,
                mentions: [newGame.holder.jid]
            });
        } catch (error) {
            log.error("games", "Error sending hot potato explosion:", error);
        }
    }, randomInt(HOTPOTATO_MIN_MS, HOTPOTATO_MAX_MS));
    newGame.timeout.unref?.();

    await sock.sendMessage(chatId, { text: potatoText(newGame), mentions: [senderJid] });
}

async function handlePass(sock, msg, ctx) {
    const { chatId, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "hot potato")) {
        return;
    }

    const game = hotPotatoGames.get(chatId);
    if (!game) {
        await reply(sock, msg, `There is no hot potato game in progress. Start one with ${commandPrefix}hotpotato.`);
        return;
    }

    const mine = senderIds(msg);
    if (!sameWho(mine, game.holder.ids)) {
        await reply(sock, msg, "You are not holding the potato.");
        return;
    }

    // Pass to whoever is mentioned, or back to whoever passed it to you.
    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
    let target;
    if (mentioned.length) {
        target = { jid: mentioned[0], ids: await knownIds(sock, chatId, mentioned[0]) };
    } else if (game.from) {
        target = game.from;
    } else {
        await reply(sock, msg, `No one passed the potato to you. Choose a player with ${commandPrefix}pass @user.`);
        return;
    }

    if (sameWho(mine, target.ids)) {
        await reply(sock, msg, "You cannot pass the potato to yourself.");
        return;
    }
    if (botIds(sock).includes(target.jid)) {
        await reply(sock, msg, "The potato cannot be passed to the bot. Please choose another player.");
        return;
    }

    game.from = { jid: ctx.senderJid, ids: mine };
    game.holder = target;
    await sock.sendMessage(chatId, { text: potatoText(game), mentions: [target.jid] });
}

// ----------------------------------------------------
// !blackjack
// ----------------------------------------------------
// blackjack against the bot, no money involved. you just type hit or stand
const BLACKJACK_IDLE_MS = 2 * 60 * 1000;
const blackjackGames = new Map();
const CARD_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const CARD_SUITS = ["♠", "♥", "♦", "♣"];

// fresh shuffled deck every game, so no card counting
function newDeck() {
    const deck = [];
    for (const suit of CARD_SUITS) {
        for (const rank of CARD_RANKS) {
            deck.push({ rank, suit });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = randomInt(0, i);
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// an ace counts as 11 until that would bust you, then it counts as 1 
function handTotal(hand) {
    let total = 0;
    let aces = 0;
    for (const card of hand) {
        if (card.rank === "A") {
            total += 11;
            aces++;
        } else if (["J", "Q", "K"].includes(card.rank)) {
            total += 10;
        } else {
            total += Number(card.rank);
        }
    }
    while (total > 21 && aces > 0) {
        total -= 10;
        aces--;
    }
    return total;
}

function showHand(hand) {
    return hand.map(card => `${card.rank}${card.suit}`).join(" ");
}

function blackjackTable(game) {
    return [
        `Your hand: ${showHand(game.player)} (${handTotal(game.player)})`,
        `Dealer: ${game.dealer[0].rank}${game.dealer[0].suit} ?`,
        "Reply hit or stand."
    ].join("\n");
}

// dealer plays out their hand and the bot says who won. the game is already removed by now, so nothing else can touch it
async function finishBlackjack(sock, msg, game, bust) {
    let verdict;
    const player = handTotal(game.player);
    if (!bust) {
        // dealer has to keep drawing until 17 or more, no choice in the matter
        while (handTotal(game.dealer) < 17) {
            game.dealer.push(game.deck.pop());
        }
    }
    const dealer = handTotal(game.dealer);
    if (bust) {
        verdict = "Bust. The dealer wins.";
    } else if (dealer > 21) {
        verdict = "The dealer went bust. You win.";
    } else if (player > dealer) {
        verdict = "You win.";
    } else if (player < dealer) {
        verdict = "The dealer wins.";
    } else {
        verdict = "It is a tie. Nobody wins this round.";
    }
    await reply(
        sock,
        msg,
        [
            `Your hand: ${showHand(game.player)} (${player})`,
            `Dealer: ${showHand(game.dealer)} (${dealer})`,
            verdict
        ].join("\n")
    );
}

async function handleBlackjack(sock, msg, ctx) {
    const { chatId, senderJid, text, trusted, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx)) {
        return;
    }
    const argument = text.slice("!blackjack".length).trim().toLowerCase();
    const game = blackjackGames.get(chatId);
    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no blackjack game to cancel.");
            return;
        }
        if (!sameWho(senderIds(msg), game.starterIds) && senderJid !== game.starterJid && !trusted) {
            await reply(sock, msg, "Only the player who started the game or a trusted user can cancel it.");
            return;
        }
        clearGameTimers(game);
        blackjackGames.delete(chatId);
        await reply(sock, msg, "The blackjack game has been cancelled.");
        return;
    }
    if (argument) {
        await reply(sock, msg, `Usage: ${commandPrefix}blackjack [cancel]`);
        return;
    }
    if (game) {
        await reply(sock, msg, blackjackTable(game));
        return;
    }
    if (!await canStartGame(sock, msg, chatId)) {
        return;
    }
    const deck = newDeck();
    const newGame = {
        deck,
        player: [deck.pop(), deck.pop()],
        dealer: [deck.pop(), deck.pop()],
        starterIds: senderIds(msg),
        starterJid: senderJid,
        idleTimeout: null
    };
    // a natural 21 on the deal ends the game straight away

    if (handTotal(newGame.player) === 21) {
        const dealerNatural = handTotal(newGame.dealer) === 21;
        await reply(
            sock,
            msg,
            [
                `Your hand: ${showHand(newGame.player)} (21)`,
                `Dealer: ${showHand(newGame.dealer)} (${handTotal(newGame.dealer)})`,
                dealerNatural ? "Both of you have blackjack, so it is a tie." : "Blackjack. You win."
            ].join("\n")
        );
        return;
    }
    blackjackGames.set(chatId, newGame);
    armTimer(
        sock,
        blackjackGames,
        chatId,
        newGame,
        BLACKJACK_IDLE_MS,
        "The blackjack game has timed out and ended.",
        null,
        "idleTimeout"
    );
    await reply(sock, msg, blackjackTable(newGame));
}

// hit and stand are plain words and only the player who started the game can use them.
// anything else returns false so normal chat keeps working
async function handleBlackjackMove(sock, msg, chatId, senderJid, text) {
    const game = blackjackGames.get(chatId);
    if (!game) {
        return false;
    }
    const move = text.trim().toLowerCase();
    if (move !== "hit" && move !== "stand") {
        return false;
    }
    if (senderJid !== game.starterJid && !sameWho(senderIds(msg), game.starterIds)) {
        return false;
    }
    // still playing, so restart the idle timer
    armTimer(
        sock,
        blackjackGames,
        chatId,
        game,
        BLACKJACK_IDLE_MS,
        "The blackjack game has timed out and ended.",
        null,
        "idleTimeout"
    );
    if (move === "hit") {
        game.player.push(game.deck.pop());
        const total = handTotal(game.player);
        if (total > 21) {
            clearGameTimers(game);
            blackjackGames.delete(chatId);
            await finishBlackjack(sock, msg, game, true);
            return true;
        }
        if (total < 21) {
            await reply(sock, msg, blackjackTable(game));
            return true;
        }
        // exactly 21 means standing is the only sensible move, so we just do it for them
    }
    clearGameTimers(game);
    blackjackGames.delete(chatId);
    await finishBlackjack(sock, msg, game, false);
    return true;
}

// ----------------------------------------------------
// !slots :D 
// ----------------------------------------------------
// one spin and done. nothing is stored so it doesnt count as a running game
const SLOT_SYMBOLS = ["🍒", "🍋", "🍊", "🍇", "🔔", "⭐", "7️⃣"];

async function handleSlots(sock, msg, ctx) {
    if (!await gameAllowed(sock, msg, ctx)) {
        return;
    }
    const reels = [0, 1, 2].map(() => SLOT_SYMBOLS[randomInt(0, SLOT_SYMBOLS.length - 1)]);
    const distinct = new Set(reels).size;
    let verdict;
    if (distinct === 1 && reels[0] === "7️⃣") {
        verdict = "Triple sevens. Maximum jackpot!";
    } else if (distinct === 1) {
        verdict = "Jackpot. Three of a kind!";
    } else if (distinct === 2) {
        verdict = "Two of a kind. Not bad.";
    } else {
        verdict = "No match. Better luck next time.";
    }
    await reply(sock, msg, `Slots\n[ ${reels.join(" | ")} ]\n${verdict}`);
}

// ----------------------------------------------------
// !wordchain
// ----------------------------------------------------
// everyone takes turns saying a word that starts with the last letter of the previous one.
// no dictionary check on purpose, it would be slow and would reject slang. the game just ends when the group goes quiet
const WORDCHAIN_IDLE_MS = 60 * 1000;
const wordChainGames = new Map();
const WORDCHAIN_START_LETTERS = "abcdefghilmnoprstw";

function wordChainText(game) {
    return `Word chain: the next word must start with ${game.letter.toUpperCase()}. Words so far: ${game.count}.`;
}

function wordChainEnded(game) {
    return `${game.count} ${game.count === 1 ? "word was" : "words were"} chained.`;
}

async function handleWordChain(sock, msg, ctx) {
    const { chatId, senderJid, text, trusted, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "word chain")) {
        return;
    }
    const argument = text.slice("!wordchain".length).trim().toLowerCase();
    const game = wordChainGames.get(chatId);
    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no word chain game to cancel.");
            return;
        }
        if (!sameWho(senderIds(msg), game.starterIds) && !trusted) {
            await reply(sock, msg, "Only the player who started the game or a trusted user can cancel it.");
            return;
        }
        clearGameTimers(game);
        wordChainGames.delete(chatId);
        await reply(sock, msg, `The word chain game has been cancelled. ${wordChainEnded(game)}`);
        return;
    }
    if (argument) {
        await reply(sock, msg, `Usage: ${commandPrefix}wordchain [cancel]`);
        return;
    }
    if (game) {
        await reply(sock, msg, wordChainText(game));
        return;
    }
    if (!await canStartGame(sock, msg, chatId)) {
        return;
    }
    const newGame = {
        letter: WORDCHAIN_START_LETTERS[randomInt(0, WORDCHAIN_START_LETTERS.length - 1)],
        used: new Set(),
        count: 0,
        lastPlayer: null,
        starterIds: senderIds(msg),
        idleTimeout: null
    };
    wordChainGames.set(chatId, newGame);
    armWordChainTimer(sock, chatId, newGame);
    await reply(
        sock,
        msg,
        `${wordChainText(newGame)}\nPlayers take turns. A word must be 3 to 20 letters, and nobody can go twice in a row or repeat a word. The game ends after one minute without a word.`
    );
}

function armWordChainTimer(sock, chatId, game) {
    armTimer(
        sock,
        wordChainGames,
        chatId,
        game,
        WORDCHAIN_IDLE_MS,
        "The word chain has ended because nobody replied in time.",
        wordChainEnded,
        "idleTimeout"
    );
}

// only looks at single words with the right starting letter, everything else is just chat so we leave it alone
async function handleWordChainAnswer(sock, msg, chatId, senderJid, text) {
    const game = wordChainGames.get(chatId);
    if (!game) {
        return false;
    }
    const word = text.trim().toLowerCase();
    if (!/^[a-z]{3,20}$/.test(word) || word[0] !== game.letter) {
        return false;
    }
    // no going twice in a row, give someone else a turn
    if (senderJid === game.lastPlayer) {
        return false;
    }
    if (game.used.has(word)) {
        await reply(sock, msg, `"${word}" has already been used. Try another word.`);
        return true;
    }
    game.used.add(word);
    game.count++;
    game.lastPlayer = senderJid;
    game.letter = word[word.length - 1];
    armWordChainTimer(sock, chatId, game);
    await reply(sock, msg, wordChainText(game));
    return true;
}

const EXTRA_COMMANDS = {
    "!coin": handleCoin,
    "!roll": handleRoll,
    "!rps": handleRps,
    "!ttt": handleTtt,
    "!numguess": handleNumGuess,
    "!wordle": handleWordle,
    "!anagram": handleAnagram,
    "!hotpotato": handleHotPotato,
    "!pass": handlePass,
    "!blackjack": handleBlackjack,
    "!slots": handleSlots,
    "!wordchain": handleWordChain
};


// ============================================================
// Called from index.js
// ============================================================

// Answers in decrypt, math, number guessing and anagram games are one short
// word or number, so someone can spam them to brute force the answer. Each
// person gets one answer every few seconds in a group, and answers sent faster
// are ignored.
const ANSWER_COOLDOWN_MS = 3000;
const lastAnswerAt = new Map();

function answerGameRunning(chatId) {
    return (
        decryptGames.has(chatId) ||
        activeMathGames.has(chatId) ||
        numGuessGames.has(chatId) ||
        anagramGames.has(chatId)
    );
}

function onAnswerCooldown(chatId, senderJid, text) {
    if (!answerGameRunning(chatId) || !/^\S{1,30}$/.test(text.trim())) {
        return false;
    }
    const key = `${chatId}|${senderJid}`;
    const now = Date.now();
    if (now - (lastAnswerAt.get(key) || 0) < ANSWER_COOLDOWN_MS) {
        return true;
    }
    lastAnswerAt.set(key, now);
    // forget the old entries so this map doesnt grow forever
    if (lastAnswerAt.size > 500) {
        for (const [oldKey, time] of lastAnswerAt) {
            if (now - time > ANSWER_COOLDOWN_MS) {
                lastAnswerAt.delete(oldKey);
            }
        }
    }
    return false;
}

// Plain messages that might be answering a game.
async function handleAnswer(sock, msg, { chatId, senderJid, text }) {
    if (onAnswerCooldown(chatId, senderJid, text)) {
        return true;
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
                return true;
            }
            if (!tournament.players.has(senderJid)) {
                return true;
            }
        }

        log.info("games", `${describeSender(msg)} solved the decrypt game in ${describeGroup(chatId)}. The word was: ${decryptGame.word}`);
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
        return true;
    }

    const mathGame = activeMathGames.get(chatId);
    const mathAnswer = text.trim();
    if (
        mathGame &&
        /^-?(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(mathAnswer) &&
        Number(mathAnswer) === mathGame.answer
    ) {
        if (mathGame.tournamentRound) {
            const tournament = getTournament(chatId);
            if (tournament !== mathGame.tournamentRound) {
                activeMathGames.delete(chatId);
                return true;
            }
            if (!tournament.players.has(senderJid)) {
                return true;
            }
        }

        log.info("games", `${describeSender(msg)} solved the math game in ${describeGroup(chatId)}. The answer was: ${mathGame.answer}`);
        activeMathGames.delete(chatId);
        if (mathGame.tournamentRound) {
            await awardTournamentPoint(
                sock,
                chatId,
                senderJid,
                mathGame.tournamentRound
            );
        } else {
            await sock.sendMessage(chatId, {
                text: `@${senderJid.split("@")[0]} solved it first!`,
                mentions: [senderJid]
            });
        }
        return true;
    }

    // Turning games off in a group also stops the extra games already running there.
    if (extraGamesEnabled() && getGroupSetting(chatId, "gamesenabled")) {
        if (await handleTttMove(sock, chatId, senderJid, text)) return true;
        if (await handleNumGuessAnswer(sock, msg, chatId, senderJid, text)) return true;
        if (await handleAnagramAnswer(sock, msg, chatId, senderJid, text)) return true;
        if (await handleBlackjackMove(sock, msg, chatId, senderJid, text)) return true;
        if (await handleWordChainAnswer(sock, msg, chatId, senderJid, text)) return true;
    }

    return false;
}

// Game commands. The original ones are untouched, the extra ones only run
// when ENABLE_EXTRA_GAMES=1.
async function handleCommand(sock, msg, { chatId, senderJid, text, isGroup, trusted, commandPrefix }) {
    // The original game commands know nothing about the extra games, so check here.
    if (extraGamesEnabled()) {
        const [name, action] = text.trim().split(/\s+/);
        const extraGame = activeExtraGame(chatId);
        if (
            extraGame &&
            ((name === "!decrypt" && action !== "hint") || name === "!math" || (name === "!tournament" && action === "create"))
        ) {
            await reply(sock, msg, `Finish the current ${extraGame} game before starting another game.`);
            return true;
        }
    }

    if (
        text === "!tournament" ||
        text.startsWith("!tournament ")
    ) {
        if (!isGroup) {
            await reply(sock, msg, "Tournaments can only be used in a group.");
            return true;
        }

        const [, action, ...args] = text.trim().split(/\s+/);
        const tournament = getTournament(chatId);
        const usage = [
            `Usage: ${commandPrefix}tournament <create [points]|join|leave|start [decrypt|math]|status|cancel>`,
            `The creator is automatically entered and controls start/cancel.`
        ].join("\n");

        if (action === "create") {
            if (args.length > 1 || (args[0] && !/^[1-9]\d*$/.test(args[0]))) {
                await reply(sock, msg, usage);
                return true;
            }
            if (decryptGames.has(chatId) || activeMathGames.has(chatId)) {
                await reply(sock, msg, "Finish the current game before creating a tournament.");
                return true;
            }

            const maxPoints = args[0] ? Number(args[0]) : 3;
            if (!createTournament(chatId, senderJid, maxPoints)) {
                await reply(sock, msg, "A tournament already exists here, or the tournament settings are invalid.");
                return true;
            }

            await reply(
                sock,
                msg,
                `Tournament created. You are entered automatically. Others can join with ${commandPrefix}tournament join.`
            );
            return true;
        }

        if (action === "join") {
            if (args.length || !tournament) {
                await reply(sock, msg, tournament ? usage : "There is no tournament to join.");
                return true;
            }
            if (!joinTournament(chatId, senderJid)) {
                await reply(sock, msg, tournament.status === "lobby"
                    ? "You have already joined this tournament."
                    : "The tournament has already started; no more players can join.");
                return true;
            }

            await reply(sock, msg, "You joined the tournament.");
            return true;
        }

        if (action === "leave") {
            if (args.length || !tournament) {
                await reply(sock, msg, tournament ? usage : "There is no tournament to leave.");
                return true;
            }
            if (!leaveTournament(chatId, senderJid)) {
                await reply(sock, msg, senderJid === tournament.creatorId
                    ? `The creator cannot leave; use ${commandPrefix}tournament cancel instead.`
                    : "You can only leave a tournament lobby after joining.");
                return true;
            }

            await reply(sock, msg, "You left the tournament.");
            return true;
        }

        if (action === "start") {
            if (!tournament) {
                await reply(sock, msg, "There is no tournament to start.");
                return true;
            }
            if (args.length > 1) {
                await reply(sock, msg, usage);
                return true;
            }
            const minigame = args[0]?.toLowerCase() || "decrypt";
            if (!minigames.includes(minigame)) {
                await reply(sock, msg, "Choose a tournament game: decrypt or math.");
                return true;
            }
            if (senderJid !== tournament.creatorId) {
                await reply(sock, msg, "Only the tournament creator can start it.");
                return true;
            }
            if (tournament.status !== "lobby") {
                await reply(sock, msg, "The tournament is already running.");
                return true;
            }
            if (tournament.players.size < 2) {
                await reply(sock, msg, "At least two players must join before the tournament can start.");
                return true;
            }
            if (!getGroupSetting(chatId, "gamesenabled")) {
                await reply(sock, msg, "A moderator has disabled games in this group.");
                return true;
            }
            if (decryptGames.has(chatId) || activeMathGames.has(chatId)) {
                await reply(sock, msg, "Finish the current game before starting the tournament.");
                return true;
            }

            tournament.minigame = minigame;
            tournament.status = "running";
            await startTournamentRound(sock, chatId);
            return true;
        }

        if (action === "status") {
            if (args.length || !tournament) {
                await reply(sock, msg, tournament ? usage : "There is no tournament in this group.");
                return true;
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
                    `Game: ${tournament.minigame}`,
                    `First to ${tournament.maxPoints} points wins.`,
                    ...standings
                ].join("\n"),
                mentions
            });
            return true;
        }

        if (action === "cancel") {
            if (args.length || !tournament) {
                await reply(sock, msg, tournament ? usage : "There is no tournament to cancel.");
                return true;
            }
            if (senderJid !== tournament.creatorId && !trusted) {
                await reply(sock, msg, "Only the tournament creator or a trusted user can cancel it.");
                return true;
            }

            endTournament(chatId);
            await reply(sock, msg, "The tournament was cancelled.");
            return true;
        }

        await reply(sock, msg, usage);
        return true;
    }

    // ----------------------------------------------------
    // !decrypt
    // ----------------------------------------------------

    if (text === "!decrypt hint") {
        const game = decryptGames.get(chatId);
        if (!game || game.loading) {
            await reply(sock, msg, game ? "A decrypt game is starting. Please wait." : `There is no decrypt game in progress. Start one with ${commandPrefix}decrypt.`);
            return true;
        }

        await reply(sock, msg, await decryptHintText(game));
        return true;
    }

    if (text === "!decrypt") {
        if (!isGroup) {
            await reply(sock, msg, "The decrypt game can only be played in a group.");
            return true;
        }

        if (!getGroupSetting(chatId, "gamesenabled")) {
            await reply(sock, msg, "A moderator has disabled games in this group.");
            return true;
        }

        if (getTournament(chatId)) {
            await reply(
                sock,
                msg,
                "A tournament is already being organized or played in this group."
            );
            return true;
        }

        const currentGame = decryptGames.get(chatId);
        if (activeMathGames.has(chatId)) {
            await reply(sock, msg, "Finish the current math game before starting another game.");
            return true;
        }
        if (currentGame) {
            await reply(
                sock,
                msg,
                currentGame.loading
                    ? "A decrypt game is starting. Please wait."
                    : "A decrypt game is already running in this group."
            );
            return true;
        }

        await startDecryptGame(sock, chatId);
        return true;
    }

    // ----------------------------------------------------
    // !math
    // ----------------------------------------------------

    if (text === "!math") {
        if (!isGroup) {
            await reply(sock, msg, "The math game can only be played in a group.");
            return true;
        }

        if (!getGroupSetting(chatId, "gamesenabled")) {
            await reply(sock, msg, "A moderator has disabled games in this group.");
            return true;
        }

        if (getTournament(chatId)) {
            await reply(
                sock,
                msg,
                "A tournament is already being organized or played in this group."
            );
            return true;
        }

        if (decryptGames.has(chatId)) {
            await reply(sock, msg, "Finish the current decrypt game before starting another game.");
            return true;
        }

        await startMathGame(sock, chatId);
        return true;
    }

    if (extraGamesEnabled()) {
        const name = text.trim().split(/\s+/)[0].toLowerCase();
        if (Object.hasOwn(EXTRA_COMMANDS, name)) {
            await EXTRA_COMMANDS[name](sock, msg, { chatId, senderJid, text, isGroup, trusted, commandPrefix });
            return true;
        }
    }

    return false;
}

module.exports = { handleAnswer, handleCommand, restoreGames, saveGames };
