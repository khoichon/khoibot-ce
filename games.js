// Mini games: decrypt, math, tournaments, plus the extra ones (coin, roll, rps,
// ttt, numguess, wordle, anagram). index.js passes every message to handleAnswer()
// and handleCommand(), and they return true if they used it.

const { reply } = require("./utils.js");
const { randomWord } = require("./wordhelper.js");
const { getGroupSetting } = require("./config.js");

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

// ============================================================
// More games
// ============================================================

const activeMathGames = new Map();

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

    const game = { answer, tournamentRound };
    activeMathGames.set(groupId, game);

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
const numGuessGames = new Map();
const wordleGames = new Map();
const anagramGames = new Map();

function extraGamesEnabled() {
    return process.env.ENABLE_EXTRA_GAMES === "1";
}

// Name of the extra game running in this group, or null.
function activeExtraGame(groupId) {
    if (tttGames.has(groupId)) return "tic-tac-toe";
    if (numGuessGames.has(groupId)) return "number guessing";
    if (wordleGames.has(groupId)) return "wordle";
    if (anagramGames.has(groupId)) return "anagram";
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
            console.error("Error sending game timeout message:", error);
        }
    }, ms);
    game[key].unref?.();
}

// Games follow the group's gamesEnabled setting. Group-only games say no in DMs.
async function gameAllowed(sock, msg, { chatId, isGroup }, groupOnlyLabel = null) {
    if (!isGroup) {
        if (groupOnlyLabel) {
            await reply(sock, msg, `The ${groupOnlyLabel} game can only be played in a group.`);
            return false;
        }
        return true;
    }

    if (!getGroupSetting(chatId, "gamesEnabled")) {
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
        await reply(sock, msg, `Usage: ${commandPrefix}ttt [join|cancel]`);
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
        timeout: null
    };
    numGuessGames.set(chatId, newGame);
    armTimer(sock, numGuessGames, chatId, newGame, NUMGUESS_GAME_MS, "Time is up, so the game ended.", game => `The number was ${game.secret}.`);
    armTimer(sock, numGuessGames, chatId, newGame, NUMGUESS_IDLE_MS, "Nobody guessed for a while, so the game ended.", game => `The number was ${game.secret}.`, "idleTimeout");
    await sock.sendMessage(chatId, {
        text: `I'm thinking of a number between 1 and ${max}. Send a number to guess it.`
    });
}

async function handleNumGuessAnswer(sock, chatId, senderJid, text) {
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
        armTimer(sock, wordleGames, chatId, game, WORDLE_GAME_MS, "Time is up, so the wordle game ended.", game => `The word was "${game.word}".`);
        await sock.sendMessage(chatId, {
            text: `Wordle! Guess the ${WORDLE_LENGTH}-letter word in ${WORDLE_MAX_GUESSES} tries with ${commandPrefix}wordle <word>.`
        });
    } catch (error) {
        if (wordleGames.get(chatId) === game) {
            wordleGames.delete(chatId);
        }
        console.error("Error starting wordle game:", error);
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

    if (argument) {
        if (!game) {
            await reply(sock, msg, `There is no wordle game running. Start one with ${commandPrefix}wordle.`);
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
        game.loading = false;
        armTimer(sock, anagramGames, chatId, game, ANAGRAM_GAME_MS, "Time is up, so nobody got it.", game => `The word was "${game.word}".`);
        await sock.sendMessage(chatId, {
            text: `Unscramble this word: ${scrambled.toUpperCase()}`
        });
    } catch (error) {
        if (anagramGames.get(chatId) === game) {
            anagramGames.delete(chatId);
        }
        console.error("Error starting anagram game:", error);
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

    if (argument) {
        await reply(sock, msg, `Usage: ${commandPrefix}anagram [skip]`);
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

async function handleAnagramAnswer(sock, chatId, senderJid, text) {
    const game = anagramGames.get(chatId);
    if (
        !game ||
        game.loading ||
        text.trim().toLowerCase() !== game.word
    ) {
        return false;
    }

    clearGameTimers(game);
    anagramGames.delete(chatId);
    await sock.sendMessage(chatId, {
        text: `${tag(senderJid)} got it first. The word was "${game.word}".`,
        mentions: [senderJid]
    });
    return true;
}

const EXTRA_COMMANDS = {
    "!coin": handleCoin,
    "!roll": handleRoll,
    "!rps": handleRps,
    "!ttt": handleTtt,
    "!numguess": handleNumGuess,
    "!wordle": handleWordle,
    "!anagram": handleAnagram
};


// ============================================================
// Called from index.js
// ============================================================

// Plain messages that might be answering a game.
async function handleAnswer(sock, msg, { chatId, senderJid, text }) {
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
    if (extraGamesEnabled() && getGroupSetting(chatId, "gamesEnabled")) {
        if (await handleTttMove(sock, chatId, senderJid, text)) return true;
        if (await handleNumGuessAnswer(sock, chatId, senderJid, text)) return true;
        if (await handleAnagramAnswer(sock, chatId, senderJid, text)) return true;
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
            (name === "!decrypt" || name === "!math" || (name === "!tournament" && action === "create"))
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
            if (!getGroupSetting(chatId, "gamesEnabled")) {
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

    if (text === "!decrypt") {
        if (!isGroup) {
            await reply(sock, msg, "The decrypt game can only be played in a group.");
            return true;
        }

        if (!getGroupSetting(chatId, "gamesEnabled")) {
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

        if (!getGroupSetting(chatId, "gamesEnabled")) {
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

module.exports = { handleAnswer, handleCommand };
