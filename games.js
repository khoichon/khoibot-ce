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
const chessgame = require("./chessgame.js");
const { keepBrokenCopy } = require("./backup.js");
const sharp = require("sharp");

// ============================================================
// Saving games so a restart doesnt wipe them
// decrypt, math, wordle, anagram, number guessing and chess get written to games-state.json
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
            keepBrokenCopy(GAMES_STATE_FILE);
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
    const out = { decrypt: {}, math: {}, wordle: {}, anagram: {}, numguess: {}, chess: chess.snapshot() };

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
        out.math[groupId] = { answer: game.answer, question: game.question, startedAt: game.startedAt, level: game.level };
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

    for (const [kind, games] of [["decrypt", decryptGames], ["math", activeMathGames], ["wordle", wordleGames], ["anagram", anagramGames], ["numguess", numGuessGames]]) {
        for (const [groupId, game] of games) {
            if (out[kind][groupId] && game.durationMs) {
                out[kind][groupId].durationMs = game.durationMs;
            }
        }
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
            const left = timeLeft(s.startedAt, s.durationMs || DECRYPT_GAME_MS);
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

            const game = {
                answer: s.answer,
                question: s.question,
                startedAt: s.startedAt,
                level: s.level || "medium",
                tournamentRound: null
            };

            const left = timeLeft(s.startedAt, s.durationMs || mathTimeMs(game.level));
            if (!left) continue;

            activeMathGames.set(groupId, game);
            scheduleMathTimeout(sock, groupId, game, left);
            count += 1;
        }

        // the extra games stay off unless ENABLE_EXTRA_GAMES=1
        if (extraGamesEnabled()) {
            count += chess.restore(sock, saved.chess);

            for (const [groupId, s] of Object.entries(saved.wordle || {})) {
                const left = timeLeft(s.startedAt, s.durationMs || WORDLE_GAME_MS);
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
                const left = timeLeft(s.startedAt, s.durationMs || ANAGRAM_GAME_MS);
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
                const left = timeLeft(s.startedAt, s.durationMs || NUMGUESS_GAME_MS);
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

    for (const [kind, games] of [["decrypt", decryptGames], ["math", activeMathGames], ["wordle", wordleGames], ["anagram", anagramGames], ["numguess", numGuessGames]]) {
        for (const [groupId, s] of Object.entries(saved[kind] || {})) {
            const game = games.get(groupId);
            if (game && s.durationMs) {
                game.durationMs = s.durationMs;
            }
        }
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

function scheduleDecryptTimeout(sock, game, ms = game.durationMs || DECRYPT_GAME_MS) {
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
        game.durationMs = gameMs(groupId, DECRYPT_GAME_MS);

        while (game.revealedIndices.size < Math.min(2, game.word.length - 3)) {
            game.revealedIndices.add(
                Math.floor(Math.random() * game.word.length)
            );
        }

        await sock.sendMessage(groupId, {
            text: `find the word hehe\n${formatDecryptWord(game.word, game.revealedIndices)}\nyou have ${formatGameTime(game.durationMs)}. ask for a hint with !decrypt hint.`
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

const lastMathStart = new Map();

function mathCooldownMs() {
    const value = process.env.MATH_COOLDOWN_SECONDS;
    const seconds = value === undefined || value.trim() === "" ? NaN : Number(value);
    return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 20) * 1000;
}

const MATH_TIME_MS = {
    easy: 60 * 1000,
    medium: 90 * 1000,
    hard: 2 * 60 * 1000,
    impossible: 3 * 60 * 1000,
    asian: 5 * 60 * 1000
};

function mathTimeMs(level) {
    return MATH_TIME_MS[level] || MATH_TIME_MS.medium;
}

function scheduleMathTimeout(sock, groupId, game, ms = game.durationMs || mathTimeMs(game.level)) {
    clearTimeout(game.timeout);
    game.timeout = setTimeout(async () => {
        if (activeMathGames.get(groupId) !== game) {
            return;
        }

        activeMathGames.delete(groupId);
        try {
            await sock.sendMessage(groupId, {
                text: `Time is up, so nobody got it. The answer was ${game.answer}.`
            });
        } catch (error) {
            log.error("games", "Error sending math game timeout:", error);
        }

        if (
            game.tournamentRound &&
            tournaments.get(groupId) === game.tournamentRound &&
            game.tournamentRound.status === "running"
        ) {
            try {
                await startTournamentRound(sock, groupId);
            } catch (error) {
                log.error("games", "Error starting the next tournament round:", error);
            }
        }
    }, ms);
    game.timeout.unref?.();
}

// how hard a math question is. !math picks one at random when nobody asks for a level
// easy is only * and /, medium has brackets and mixed stuff in it, hard is the properly nasty ones
// impossible and asian have their own sets of questions, see makeImpossibleQuestion and makeAsianQuestion
const MATH_LEVELS = ["easy", "medium", "hard", "impossible", "asian"];
// impossible and asian only show up when someone asks for them, a random pick or a tournament round shouldnt be that cruel
const MATH_RANDOM_LEVELS = MATH_LEVELS.filter((level) => level !== "impossible" && level !== "asian");

// every answer is a whole number so people can just type it out.
// the plain ones look like "What is 12 + 5?" and the algebra ones like "Solve for x: 2x + 5 = 17"

// "+ 5" or "- 5", for building equations where the number could go either way
function signed(n) {
    return n < 0 ? `- ${-n}` : `+ ${n}`;
}

// a random number in a range but never 0, so x doesnt end up as a boring answer
function randomNonZero(min, max) {
    let n = 0;
    while (n === 0) n = randomInt(min, max);
    return n;
}

function makeArithmeticQuestion(level) {
    const kind = randomInt(0, 3);

    if (level === "easy") {
        // only * and /, and every division comes out even
        if (kind === 0) {
            const a = randomInt(2, 12);
            const b = randomInt(2, 20);
            return { question: `What is ${a} * ${b}?`, answer: a * b };
        }
        if (kind === 1) {
            const b = randomInt(2, 12);
            const answer = randomInt(2, 25);
            return { question: `What is ${b * answer} / ${b}?`, answer };
        }
        if (kind === 2) {
            const c = randomInt(2, 9);
            const m = randomInt(2, 9);
            const b = randomInt(2, 12);
            return { question: `What is ${c * m} * ${b} / ${c}?`, answer: m * b };
        }
        const b = randomInt(2, 9);
        const m = randomInt(2, 15);
        const c = randomInt(2, 12);
        return { question: `What is ${b * m} / ${b} * ${c}?`, answer: m * c };
    }

    if (level === "hard") {
        const impossibleKind = randomInt(0, 6);
        if (impossibleKind === 0) {
            const a = randomInt(1000, 9999);
            const b = randomInt(100, 999);
            return { question: `What is ${a} * ${b}?`, answer: a * b };
        }
        if (impossibleKind === 1) {
            const c = randomInt(12, 99);
            const q = randomInt(100, 999);
            return { question: `What is ${c * q} / ${c}?`, answer: q };
        }
        if (impossibleKind === 2) {
            const a = randomInt(23, 99);
            const b = randomInt(23, 99);
            const c = randomInt(23, 99);
            return { question: `What is ${a} * ${b} * ${c}?`, answer: a * b * c };
        }
        if (impossibleKind === 3) {
            const a = randomInt(100, 999);
            const b = randomInt(100, 999);
            const d = randomInt(100, 500);
            const c = d + randomInt(50, 400);
            return { question: `What is (${a} + ${b}) * (${c} - ${d})?`, answer: (a + b) * (c - d) };
        }
        if (impossibleKind === 4) {
            const a = randomInt(30, 99);
            const b = randomInt(30, a);
            return { question: `What is ${a}^2 - ${b}^2?`, answer: a * a - b * b };
        }
        if (impossibleKind === 5) {
            const a = randomInt(13, 35);
            return { question: `What is ${a}^3?`, answer: a * a * a };
        }
        while (true) {
            const [a, b, d, e] = [0, 0, 0, 0].map(() => randomInt(12, 99));
            const c = randomInt(11, 60);
            const f = randomInt(3, 12);
            const top = (a + b) * c - d * e;
            if (top > 0 && top % f === 0) {
                return { question: `What is ((${a} + ${b}) * ${c} - ${d} * ${e}) / ${f}?`, answer: top / f };
            }
        }
    }

    const hardKind = randomInt(0, 8);

    if (hardKind === 0) {
        const a = randomInt(100, 999);
        const b = randomInt(11, 99);
        return { question: `What is ${a} * ${b}?`, answer: a * b };
    }
    if (hardKind === 1) {
        const a = randomInt(10, 99);
        const b = randomInt(10, 99);
        const d = randomInt(10, 50);
        const c = d + randomInt(5, 40);
        return { question: `What is (${a} + ${b}) * (${c} - ${d})?`, answer: (a + b) * (c - d) };
    }
    if (hardKind === 2) {
        const [a, b, c, d] = [0, 0, 0, 0].map(() => randomInt(12, 60));
        return { question: `What is ${a} * ${b} + ${c} * ${d}?`, answer: a * b + c * d };
    }
    if (hardKind === 3) {
        const d = randomInt(2, 12);
        const m = randomInt(2, 20);
        const b = randomInt(10, 99);
        const c = randomInt(10, 99);
        return { question: `What is ${d * m} * (${b} + ${c}) / ${d}?`, answer: m * (b + c) };
    }
    if (hardKind === 4) {
        const b = randomInt(11, 40);
        const c = randomInt(11, 40);
        const a = b * c + randomInt(50, 900);
        const e = randomInt(2, 12);
        const q = randomInt(5, 60);
        return { question: `What is ${a} - ${b} * ${c} + ${e * q} / ${e}?`, answer: a - b * c + q };
    }
    if (hardKind === 5) {
        const a = randomInt(10, 60);
        const b = randomInt(10, 60);
        const c = randomInt(3, 15);
        const e = randomInt(2, 12);
        const top = (a + b) * c;
        const d = (top % e) + e * randomInt(0, 20);
        return { question: `What is ((${a} + ${b}) * ${c} - ${d}) / ${e}?`, answer: (top - d) / e };
    }
    if (hardKind === 6) {
        const d = randomInt(2, 12);
        const m = randomInt(2, 8);
        const b = randomInt(12, 40);
        const c = randomInt(3, 12);
        return { question: `What is ${d * m} * ${b} * ${c} / ${d}?`, answer: m * b * c };
    }
    if (hardKind === 7) {
        const [a, b, c, d] = [0, 0, 0, 0].map(() => randomInt(12, 50));
        return { question: `What is ${a} * ${b} - ${c} * ${d}?`, answer: a * b - c * d };
    }
    const a = randomInt(11, 30);
    const b = randomInt(2, 9);
    const c = randomInt(10, 60);
    const d = randomInt(2, 9);
    return { question: `What is (${a} - ${b}) * (${c} + ${d}) - ${a * d}?`, answer: (a - b) * (c + d) - a * d };
}

function makeAlgebraQuestion(level) {
    const kind = randomInt(0, 3);
    let equation, x;
    let positiveOnly = false;

    if (level === "easy") {
        if (kind === 0) {
            x = randomInt(2, 25);
            const a = randomInt(2, 15);
            equation = `${a}x = ${a * x}`;
        } else if (kind === 1) {
            const a = randomInt(2, 12);
            const c = randomInt(2, 25);
            x = a * c;
            equation = `x / ${a} = ${c}`;
        } else if (kind === 2) {
            const a = randomInt(2, 9);
            let b = randomInt(2, 9);
            while (b === a) b = randomInt(2, 9);
            const k = randomInt(2, 12);
            x = b * k;
            equation = `${a}x / ${b} = ${a * k}`;
        } else {
            x = randomInt(2, 15);
            const c = randomInt(2, 15);
            equation = `${x * c} / x = ${c}`;
        }
    } else if (level === "hard") {
        const impossibleKind = randomInt(0, 5);
        if (impossibleKind === 0) {
            x = randomNonZero(-200, 300);
            const c = randomInt(11, 80);
            const a = c + randomInt(1, 60);
            const b = randomInt(1, 500);
            equation = `${a}x + ${b} = ${c}x ${signed((a - c) * x + b)}`;
        } else if (impossibleKind === 1) {
            x = randomNonZero(-60, 90);
            let a, b, c, d, e, f;
            do {
                a = randomInt(2, 12);
                b = randomInt(2, 12);
                d = randomInt(2, 12);
                e = randomInt(2, 12);
            } while (a * b === d * e);
            c = randomInt(1, 40);
            f = randomInt(1, 40);
            equation = `${a}(${b}x + ${c}) - ${d}(${e}x - ${f}) = ${a * (b * x + c) - d * (e * x - f)}`;
        } else if (impossibleKind === 2) {
            let a, b, c;
            do {
                a = randomInt(2, 12);
                b = randomInt(2, 12);
                c = randomInt(2, 12);
            } while (a === b || b === c || a === c || b * c + a * c === a * b);
            x = a * b * c * randomInt(1, 2);
            equation = `x / ${a} + x / ${b} - x / ${c} = ${x / a + x / b - x / c}`;
        } else if (impossibleKind === 3) {
            positiveOnly = true;
            x = randomInt(2, 30);
            const a = randomInt(1, 9);
            const c = randomInt(1, 9);
            const b = randomInt(1, 20);
            const d = randomInt(1, 20);
            equation = `(${a}x + ${b})(${c}x + ${d}) = ${(a * x + b) * (c * x + d)}`;
        } else if (impossibleKind === 4) {
            positiveOnly = true;
            x = randomInt(2, 25);
            const a = randomInt(2, 9);
            const b = randomInt(1, 40);
            const c = randomInt(1, 60);
            equation = `${a}x^2 + ${b}x + ${c} = ${a * x * x + b * x + c}`;
        } else {
            x = randomNonZero(-40, 60);
            const t = randomNonZero(-30, 30);
            const c = randomInt(2, 30);
            equation = `${c * t} / (x ${signed(t - x)}) = ${c}`;
        }
    } else {
        const hardKind = randomInt(0, 5);
        if (hardKind === 0) {
            x = randomNonZero(-25, 40);
            const c = randomInt(2, 20);
            const a = c + randomInt(1, 15);
            const b = randomInt(1, 60);
            equation = `${a}x + ${b} = ${c}x ${signed((a - c) * x + b)}`;
        } else if (hardKind === 1) {
            x = randomNonZero(-20, 30);
            const c = randomInt(2, 12);
            const a = c + randomInt(1, 8);
            const b = randomInt(1, 20);
            const d = randomInt(1, 20);
            equation = `${a}(x + ${b}) - ${c}(x - ${d}) = ${a * (x + b) - c * (x - d)}`;
        } else if (hardKind === 2) {
            const a = randomInt(2, 12);
            let b = randomInt(2, 12);
            while (b === a) b = randomInt(2, 12);
            x = a * b * randomInt(1, 3);
            const minus = Math.random() < 0.5;
            equation = `x / ${a} ${minus ? "-" : "+"} x / ${b} = ${minus ? x / a - x / b : x / a + x / b}`;
        } else if (hardKind === 3) {
            x = randomNonZero(-15, 30);
            const a = randomInt(2, 9);
            const b = randomInt(2, 9);
            const d = randomInt(2, 9);
            const m = randomInt(2, 15);
            const t = d * m - b * x;
            equation = `${a}(${b}x ${signed(t)}) / ${d} = ${a * m}`;
        } else if (hardKind === 4) {
            positiveOnly = true;
            x = randomInt(2, 20);
            if (Math.random() < 0.5) {
                const b = randomInt(1, 15);
                equation = `x^2 + ${b}x = ${x * x + b * x}`;
            } else {
                const a = randomInt(1, 12);
                const b = randomInt(1, 12);
                equation = `(x + ${a})(x + ${b}) = ${(x + a) * (x + b)}`;
            }
        } else {
            positiveOnly = true;
            x = randomInt(2, 15);
            const a = randomInt(2, 9);
            const b = randomInt(1, 40);
            equation = `${a}x^2 + ${b} = ${a * x * x + b}`;
        }
    }

    return { question: `Solve for x${positiveOnly ? " (x > 0)" : ""}: ${equation}`, answer: x };
}

// impossible has its own pile of questions instead of just being a harder version of the same ones.
// every answer is still a whole number (and never negative) so people can just type it out
function makeImpossibleQuestion() {
    const kind = randomInt(0, 8);

    // powers
    if (kind === 0) {
        const a = randomInt(5, 12);
        const b = randomInt(2, 5);
        const c = randomInt(2, 9);
        return { question: `What is ${a}^3 + ${b}^4 - ${c}^2?`, answer: a ** 3 + b ** 4 - c ** 2 };
    }

    // roots of perfect squares and cubes
    if (kind === 1) {
        const a = randomInt(12, 40);
        const b = randomInt(3, 9);
        const c = randomInt(3, 15);
        return { question: `What is sqrt(${a * a}) * ${b} + cbrt(${c ** 3})?`, answer: a * b + c };
    }

    // remainders of big powers
    if (kind === 2) {
        const a = randomInt(2, 9);
        const power = randomInt(10, 30);
        const m = randomInt(5, 13);
        return { question: `What is the remainder of ${a}^${power} divided by ${m}?`, answer: Number(BigInt(a) ** BigInt(power) % BigInt(m)) };
    }

    // choosing k things out of n
    if (kind === 3) {
        const n = randomInt(8, 14);
        const k = randomInt(3, 5);
        let ways = 1;
        for (let i = 1; i <= k; i++) ways = (ways * (n - k + i)) / i;
        return { question: `How many ways can you choose ${k} things out of ${n}?`, answer: ways };
    }

    // add up the digits of a big product
    if (kind === 4) {
        const a = randomInt(100, 999);
        const b = randomInt(100, 999);
        const digits = String(a * b).split("").reduce((sum, digit) => sum + Number(digit), 0);
        return { question: `What is the sum of the digits of ${a} * ${b}?`, answer: digits };
    }

    // brackets and a bit of algebra
    if (kind === 5) {
        const x = randomInt(2, 30);
        const a = randomInt(4, 12);
        const b = randomInt(1, 9);
        const c = randomInt(2, a - 1);
        return { question: `Solve for x: ${a}(x + ${b}) - ${c}x = ${a * (x + b) - c * x}`, answer: x };
    }

    // two equations, two unknowns
    if (kind === 6) {
        const x = randomInt(21, 60);
        const y = randomInt(1, 20);
        const p = randomInt(2, 6);
        return { question: `Solve for x: x + y = ${x + y} and ${p}x - y = ${p * x - y}`, answer: x };
    }

    // a quadratic with one negative root, so only one answer is allowed
    if (kind === 7) {
        const r = randomInt(16, 30);
        const t = randomInt(1, 15);
        return { question: `Solve for x (x > 0): x^2 ${signed(t - r)}x - ${r * t} = 0`, answer: r };
    }

    // big multiplications that are too long to do in your head
    const a = randomInt(21, 99);
    const b = randomInt(21, 99);
    const c = randomInt(21, 99);
    const d = randomInt(21, 99);
    return { question: `What is ${a} * ${b} + ${c} * ${d}?`, answer: a * b + c * d };
}

const ASIAN_TRIPLES = [[3, 4, 5], [5, 12, 13], [8, 15, 17], [7, 24, 25], [20, 21, 29], [12, 35, 37], [9, 40, 41], [28, 45, 53], [11, 60, 61], [16, 63, 65], [33, 56, 65], [48, 55, 73], [13, 84, 85], [36, 77, 85], [39, 80, 89], [65, 72, 97]];

const ASIAN_BOXES = [[1, 2, 2, 3], [2, 3, 6, 7], [4, 4, 7, 9], [1, 4, 8, 9], [2, 6, 9, 11], [6, 6, 7, 11], [3, 4, 12, 13], [2, 10, 11, 15], [4, 5, 20, 21], [8, 9, 12, 17], [1, 12, 12, 17], [2, 5, 14, 15], [6, 6, 17, 19]];

function asianCosineTriples(sign) {
    const found = [];
    for (let a = 1; a <= 40; a++) {
        for (let c = a + 1; c <= 40; c++) {
            const bSquared = a * a + c * c + sign * a * c;
            const b = Math.round(Math.sqrt(bSquared));
            if (b * b === bSquared) found.push([a, c, b]);
        }
    }
    return found;
}
const ASIAN_60 = asianCosineTriples(-1);
const ASIAN_120 = asianCosineTriples(1);

const ASIAN_LADDERS = [];
for (let length = 20; length <= 150; length++) {
    const spots = [];
    for (let foot = 1; foot < length; foot++) {
        const top = Math.round(Math.sqrt(length * length - foot * foot));
        if (top > 0 && top * top + foot * foot === length * length) spots.push([foot, top]);
    }
    if (spots.length >= 4) ASIAN_LADDERS.push({ length, spots });
}

function asianPick(list) {
    return list[randomInt(0, list.length - 1)];
}

function asianTriple() {
    const [a, b, c] = asianPick(ASIAN_TRIPLES);
    return Math.random() < 0.5 ? [a, b, c] : [b, a, c];
}

function asianPolynomial(parts) {
    let text = "";
    for (const [coef, body] of parts) {
        if (coef === 0) continue;
        const size = Math.abs(coef);
        const shown = body && size === 1 ? "" : String(size);
        if (text === "") text = (coef < 0 ? "-" : "") + shown + body;
        else text += (coef < 0 ? " - " : " + ") + shown + body;
    }
    return text;
}

const ASIAN_SIN_VALUES = [[1, 2, [30, 150]], [-1, 2, [210, 330]], [1, 1, [90]], [-1, 1, [270]]];
const ASIAN_COS_VALUES = [[1, 2, [60, 300]], [-1, 2, [120, 240]], [1, 1, [0, 360]], [-1, 1, [180]]];

const ASIAN_QUESTIONS = [
    () => {
        const base = asianPick([2, 3, 5]);
        const k = base === 2 ? randomInt(3, 6) : base === 3 ? randomInt(2, 4) : randomInt(2, 3);
        const big = base ** k;
        const q = randomInt(1, 7);
        return { question: `Solve for x: ${base}^(2x) - ${big - q}*${base}^x - ${q * big} = 0`, answer: k };
    },

    () => {
        const base = asianPick([2, 3, 5]);
        const k = randomInt(2, 5);
        const m = randomInt(2, 4);
        return { question: `Solve for x: ${base}^(x + ${m}) - ${base}^x = ${base ** k * (base ** m - 1)}`, answer: k };
    },

    () => {
        const a = randomInt(2, 6);
        const b = randomInt(3, 10);
        const c = randomInt(2, 9);
        const d = randomInt(2, 9);
        return { question: `What is ${a ** 3}^(2/3) + ${b * b}^(3/2) - ${c * c}^(-1/2) * ${c * d}?`, answer: a * a + b ** 3 - d };
    },

    () => {
        const y = randomInt(1, 12);
        const x = Math.ceil(1.5 * y) + randomInt(1, 10);
        return { question: `Given that 4^x * 8^y = 2^${2 * x + 3 * y} and 9^x / 27^y = 3^${2 * x - 3 * y}, find x + y.`, answer: x + y };
    },

    () => {
        const [a, b, c] = asianTriple();
        return { question: `If sin(x) = ${a}/${c} and x is acute, find ${a * b} * (tan(x) + 1/tan(x)).`, answer: c * c };
    },

    () => {
        const [a, b, c] = asianTriple();
        return { question: `If sin(x) + cos(x) = ${a + b}/${c} and x is acute, find ${c ** 3} * (sin(x)^3 + cos(x)^3).`, answer: a ** 3 + b ** 3 };
    },

    () => {
        const useSin = Math.random() < 0.5;
        const values = useSin ? ASIAN_SIN_VALUES : ASIAN_COS_VALUES;
        const fn = useSin ? "sin" : "cos";
        const first = asianPick(values);
        let second = asianPick(values);
        while (second === first) second = asianPick(values);
        const [n1, d1, angles1] = first;
        const [n2, d2, angles2] = second;
        const equation = asianPolynomial([
            [d1 * d2, `${fn}^2(x)`],
            [-(d1 * n2 + d2 * n1), `${fn}(x)`],
            [n1 * n2, ""],
        ]);
        const total = [...angles1, ...angles2].reduce((sum, angle) => sum + angle, 0);
        return { question: `Solve ${equation} = 0 for 0 <= x <= 360 (in degrees). Find the sum of all the solutions.`, answer: total };
    },

    () => {
        const sixty = Math.random() < 0.5;
        const [a, c, b] = asianPick(sixty ? ASIAN_60 : ASIAN_120);
        const k = randomInt(1, 6);
        return { question: `In triangle ABC, AB = ${k * c} cm, BC = ${k * a} cm and angle ABC = ${sixty ? 60 : 120} degrees. Find the length of AC in cm.`, answer: k * b };
    },

    () => {
        const [lo, hi, c] = asianPick(ASIAN_TRIPLES);
        return { question: `If sin(x) = ${lo}/${c} and x is acute, find ${c * c} * cos(2x).`, answer: hi * hi - lo * lo };
    },

    () => {
        const [a, b, c, diagonal] = asianPick(ASIAN_BOXES);
        const k = randomInt(1, 4);
        return { question: `A cuboid measures ${k * a} cm by ${k * b} cm by ${k * c} cm. Find the length of the longest straight line that fits inside it, in cm.`, answer: k * diagonal };
    },

    () => {
        const [a, b, c] = asianPick(ASIAN_TRIPLES.filter((triple) => triple[2] <= 40));
        const options = [];
        for (let d = 1; d <= 1000; d++) {
            const e = Math.round(Math.sqrt(c * c + d * d));
            if (e * e === c * c + d * d) options.push([d, e]);
        }
        const [d, e] = asianPick(options);
        return { question: `In quadrilateral ABCD, angle ABC = 90 degrees and angle ACD = 90 degrees. AB = ${a} cm, BC = ${b} cm and CD = ${d} cm. Find the length of AD in cm.`, answer: e };
    },

    () => {
        const { length, spots } = asianPick(ASIAN_LADDERS);
        let start, end;
        do {
            start = asianPick(spots);
            end = asianPick(spots);
        } while (end[1] >= start[1]);
        return { question: `A ladder ${length} m long leans against a vertical wall with its foot ${start[0]} m from the wall. The top of the ladder slides down ${start[1] - end[1]} m. How far does the foot of the ladder move away from the wall, in m?`, answer: end[0] - start[0] };
    },

    () => {
        const [a, b, d] = asianPick(ASIAN_TRIPLES);
        const k = randomInt(1, 3);
        return { question: `A rectangle has a diagonal of ${k * d} cm and a perimeter of ${2 * k * (a + b)} cm. Find its area in cm^2.`, answer: k * k * a * b };
    },

    () => {
        const base = asianPick([2, 3, 5]);
        const i = base === 2 ? randomInt(3, 6) : base === 3 ? randomInt(2, 4) : randomInt(2, 3);
        const j = randomInt(1, i - 1);
        return { question: `Solve for x: log_${base}(x) + log_${base}(x - ${base ** i - base ** j}) = ${i + j}`, answer: base ** i };
    },

    () => {
        const base = asianPick([2, 3]);
        const k = base === 2 ? randomInt(1, 2) : 1;
        return { question: `Solve for x: log_${base}(x) + log_${base ** 2}(x) + log_${base ** 3}(x) = ${11 * k}`, answer: base ** (6 * k) };
    },

    () => {
        const base = asianPick([2, 3, 5]);
        const t = 2 * randomInt(1, 3);
        return { question: `Solve for x: log_${base}(x) + log_${base ** 2}(x) = ${(3 * t) / 2}`, answer: base ** t };
    },

    () => {
        const a = asianPick([2, 3, 5]);
        const u = randomInt(2, 4);
        return { question: `Given that x > ${a}, solve log_${a}(x) + log_x(${a}) = ${u * u + 1}/${u}`, answer: a ** u };
    },

    () => {
        const s = randomInt(4, 14);
        const p = randomInt(1, Math.floor((s * s) / 4));
        return { question: `The roots of x^2 - ${s}x + ${p} = 0 are a and b. Find a^3 + b^3.`, answer: s ** 3 - 3 * s * p };
    },

    () => {
        const s = randomInt(4, 14);
        const p = randomInt(1, Math.floor((s * s) / 4));
        return { question: `The roots of x^2 - ${s}x + ${p} = 0 are a and b. Find a^4 + b^4.`, answer: (s * s - 2 * p) ** 2 - 2 * p * p };
    },

    () => {
        if (Math.random() < 0.5) {
            const r = randomInt(2, 9);
            const m = randomInt(2, 5);
            return { question: `The equation x^2 - kx + ${m * r * r} = 0 has one root equal to ${m} times the other root. Find the positive value of k.`, answer: (m + 1) * r };
        }
        const lo = randomInt(1, 12);
        const d = randomInt(1, 12);
        return { question: `The roots of x^2 - kx + ${lo * (lo + d)} = 0 differ by ${d}. Find the positive value of k.`, answer: 2 * lo + d };
    },

    () => {
        const t = randomInt(2, 5) * (Math.random() < 0.5 ? -1 : 1);
        const a = randomInt(2, 9) * (Math.random() < 0.5 ? -1 : 1);
        const c = randomInt(2, 20) * (Math.random() < 0.5 ? -1 : 1);
        const k = randomInt(2, 9);
        const remainder = t ** 3 + a * t * t + k * t + c;
        const cubic = `x^3 ${signed(a)}x^2 + kx ${signed(c)}`;
        return { question: `The remainder is ${remainder} when ${cubic} is divided by (x ${signed(-t)}). Find k.`, answer: k };
    },

    () => {
        const r1 = randomInt(1, 9);
        let r2 = randomInt(1, 9);
        while (r2 === r1) r2 = randomInt(1, 9);
        const r3 = randomInt(1, 9);
        return { question: `x^3 + px^2 + qx - ${r1 * r2 * r3} has (x - ${r1}) and (x - ${r2}) as factors. Find q.`, answer: r1 * r2 + r1 * r3 + r2 * r3 };
    },

    () => {
        const a = randomInt(1, 6);
        let b = randomInt(1, 6);
        while (b === a) b = randomInt(1, 6);
        const p = randomInt(1, 9);
        const q = randomInt(1, 30);
        const first = a ** 3 + p * a * a + q;
        const second = b ** 3 + p * b * b + q;
        return { question: `The remainder is ${first} when x^3 + px^2 + q is divided by (x - ${a}) and ${second} when it is divided by (x - ${b}). Find p + q.`, answer: p + q };
    },
];

function makeAsianQuestion() {
    return asianPick(ASIAN_QUESTIONS)();
}

function makeMathQuestion(level) {
    if (level === "impossible") return makeImpossibleQuestion();
    if (level === "asian") return makeAsianQuestion();
    return Math.random() < 0.4 ? makeAlgebraQuestion(level) : makeArithmeticQuestion(level);
}

async function startMathGame(sock, groupId, tournamentRound = null, level = null) {
    if (activeMathGames.has(groupId)) {
        await sock.sendMessage(groupId, {
            text: "A math game is already active in this group."
        });
        return false;
    }

    // no level asked for means a random one
    const chosen = MATH_LEVELS.includes(level) ? level : MATH_RANDOM_LEVELS[randomInt(0, MATH_RANDOM_LEVELS.length - 1)];
    const { question, answer } = makeMathQuestion(chosen);

    const game = { answer, question, startedAt: Date.now(), tournamentRound, level: chosen, durationMs: gameMs(groupId, mathTimeMs(chosen)) };
    activeMathGames.set(groupId, game);
    scheduleMathTimeout(sock, groupId, game);
    log.info("games", `Starting ${chosen} math game in ${describeGroup(groupId)}: ${question} The answer is ${answer}`);

    try {
        await sock.sendMessage(groupId, {
            text: `Math (${chosen})\n${question}`
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

const GAME_TIME_MIN_SECONDS = 10;
const GAME_TIME_MAX_SECONDS = 60 * 60;
const askedGameTime = new Map();

function gameMs(chatId, normalMs) {
    const asked = askedGameTime.get(chatId);
    if (asked) {
        return asked;
    }

    const seconds = getGroupSetting(chatId, "gametimer");
    return seconds ? seconds * 1000 : normalMs;
}

function formatGameTime(ms) {
    const total = Math.round(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    const parts = [];
    if (minutes) {
        parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
    }
    if (seconds) {
        parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
    }
    return parts.join(" ");
}

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
    if (connect4Games.has(groupId)) return "connect 4";
    if (chess.isActive(groupId)) return "chess";
    if (numGuessGames.has(groupId)) return "number guessing";
    if (wordleGames.has(groupId)) return "wordle";
    if (anagramGames.has(groupId)) return "anagram";
    if (hotPotatoGames.has(groupId)) return "hot potato";
    if (blackjackGames.has(groupId)) return "blackjack";
    if (wordChainGames.has(groupId)) return "word chain";
    if (minesweeperGames.has(groupId)) return "minesweeper";
    if (crosswordGames.has(groupId)) return "crossword";
    if (hangmanGames.has(groupId)) return "hangman";
    if (triviaGames.has(groupId)) return "trivia";
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

// blackjack and slots need gamesenabled AND casinoenabled, casino stays off until a mod turns it on
async function casinoAllowed(sock, msg, ctx) {
    if (!await gameAllowed(sock, msg, ctx)) {
        return false;
    }

    if (ctx.isGroup && !getGroupSetting(ctx.chatId, "casinoenabled")) {
        await reply(sock, msg, "A moderator has not enabled casino games in this group.");
        return false;
    }

    return true;
}

function playerGamesIn(groupId) {
    const found = [];
    const ttt = tttGames.get(groupId);
    if (ttt) found.push({ name: "tic-tac-toe", jids: ttt.players });
    const connect4 = connect4Games.get(groupId);
    if (connect4) found.push({ name: "connect 4", jids: connect4.players });
    if (chess.isActive(groupId)) found.push({ name: "chess", jids: chess.playersOf(groupId) });
    const blackjack = blackjackGames.get(groupId);
    if (blackjack) found.push({ name: "blackjack", jids: [blackjack.starterJid] });
    const potato = hotPotatoGames.get(groupId);
    if (potato) found.push({ name: "hot potato", jids: [potato.holder.jid] });
    return found;
}

// the extra game that should stop this person from starting another one, or null.
// the open ones (anyone can answer) hold up the whole group
function blockingExtraGame(groupId, jid) {
    const mine = playerGamesIn(groupId).find((game) => game.jids.includes(jid));
    if (mine) return mine.name;
    if (numGuessGames.has(groupId)) return "number guessing";
    if (wordleGames.has(groupId)) return "wordle";
    if (anagramGames.has(groupId)) return "anagram";
    if (wordChainGames.has(groupId)) return "word chain";
    if (minesweeperGames.has(groupId)) return "minesweeper";
    if (crosswordGames.has(groupId)) return "crossword";
    if (hangmanGames.has(groupId)) return "hangman";
    if (triviaGames.has(groupId)) return "trivia";
    return null;
}

// One game per group at a time, except the player games, which only hold up their own players.
// kind is the game being started, so two of the same game cant run in one group
async function canStartGame(sock, msg, chatId, senderJid, kind = null) {
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

    const extraGame = blockingExtraGame(chatId, senderJid);
    if (extraGame) {
        await reply(sock, msg, `Finish the current ${extraGame} game before starting another game.`);
        return false;
    }

    // a second game of the same kind would overwrite the one already running
    if (kind && playerGamesIn(chatId).some((game) => game.name === kind)) {
        await reply(sock, msg, `There is already a ${kind} game running in this group.`);
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
        if (!await canStartGame(sock, msg, chatId, senderJid, "tic-tac-toe")) {
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

    if (!await canStartGame(sock, msg, chatId, senderJid, "tic-tac-toe")) {
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
    const { chatId, senderJid, text, commandPrefix } = ctx;
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

    if (!await canStartGame(sock, msg, chatId, senderJid)) {
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
    armTimer(sock, numGuessGames, chatId, newGame, (newGame.durationMs = gameMs(chatId, NUMGUESS_GAME_MS)), "Time is up, so the game ended.", game => `The number was ${game.secret}.`);
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
        armTimer(sock, wordleGames, chatId, game, (game.durationMs = gameMs(chatId, WORDLE_GAME_MS)), "Time is up, so the wordle game ended.", game => `The word was "${game.word}".`);
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

    if (!await canStartGame(sock, msg, chatId, senderJid)) {
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
        armTimer(sock, anagramGames, chatId, game, (game.durationMs = gameMs(chatId, ANAGRAM_GAME_MS)), "Time is up, so nobody got it.", game => `The word was "${game.word}".`);
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
    const { chatId, senderJid, text, commandPrefix } = ctx;
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

    if (!await canStartGame(sock, msg, chatId, senderJid)) {
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

    if (!await canStartGame(sock, msg, chatId, senderJid, "hot potato")) {
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
    if (!await casinoAllowed(sock, msg, ctx)) {
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
    if (!await canStartGame(sock, msg, chatId, senderJid, "blackjack")) {
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
    if (!await casinoAllowed(sock, msg, ctx)) {
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
    if (!await canStartGame(sock, msg, chatId, senderJid)) {
        return;
    }
    const newGame = {
        letter: WORDCHAIN_START_LETTERS[randomInt(0, WORDCHAIN_START_LETTERS.length - 1)],
        used: new Set(),
        count: 0,
        starterIds: senderIds(msg),
        idleTimeout: null
    };
    wordChainGames.set(chatId, newGame);
    armWordChainTimer(sock, chatId, newGame);
    await reply(
        sock,
        msg,
        `${wordChainText(newGame)}\nAnyone can add a word, so you can also play alone. A word must be 3 to 20 letters and cannot be repeated. The game ends after one minute without a word.`
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
    if (game.used.has(word)) {
        await reply(sock, msg, `"${word}" has already been used. Try another word.`);
        return true;
    }
    game.used.add(word);
    game.count++;
    game.letter = word[word.length - 1];
    armWordChainTimer(sock, chatId, game);
    await reply(sock, msg, wordChainText(game));
    return true;
}

// ----------------------------------------------------
// !minesweeper
// ----------------------------------------------------

const MINESWEEPER_IDLE_MS = 3 * 60 * 1000;
const MINESWEEPER_COLUMNS = "abcdefghij";
const MINESWEEPER_LEVELS = {
    easy: { size: 6, mines: 5 },
    medium: { size: 8, mines: 10 },
    hard: { size: 10, mines: 20 }
};
const MINESWEEPER_CELL = 56;
const MINESWEEPER_MARGIN = 26;
const MINESWEEPER_FONT = "DejaVu Sans, Arial, sans-serif";
const MINESWEEPER_NUMBER_COLORS = ["", "#1565c0", "#2e7d32", "#c62828", "#283593", "#8d4004", "#00838f", "#212121", "#616161"];
const minesweeperGames = new Map();

function minesweeperNeighbors(game, row, col) {
    const found = [];
    for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
            const r = row + dr;
            const c = col + dc;
            if ((dr !== 0 || dc !== 0) && r >= 0 && r < game.size && c >= 0 && c < game.size) {
                found.push([r, c]);
            }
        }
    }
    return found;
}

function minesweeperCount(game, row, col) {
    return minesweeperNeighbors(game, row, col).filter(([r, c]) => game.mineAt.has(r * game.size + c)).length;
}

function minesweeperPlaceMines(game, safeRow, safeCol) {
    const blocked = new Set([safeRow * game.size + safeCol]);
    for (const [r, c] of minesweeperNeighbors(game, safeRow, safeCol)) {
        blocked.add(r * game.size + c);
    }
    const spots = [];
    for (let i = 0; i < game.size * game.size; i++) {
        if (!blocked.has(i)) {
            spots.push(i);
        }
    }
    for (let placed = 0; placed < game.mines; placed++) {
        const pick = randomInt(0, spots.length - 1);
        game.mineAt.add(spots[pick]);
        spots.splice(pick, 1);
    }
}

function minesweeperOpen(game, row, col) {
    const stack = [[row, col]];
    while (stack.length) {
        const [r, c] = stack.pop();
        const key = r * game.size + c;
        if (game.opened.has(key) || game.flagged.has(key)) {
            continue;
        }
        game.opened.add(key);
        if (minesweeperCount(game, r, c) === 0) {
            for (const next of minesweeperNeighbors(game, r, c)) {
                stack.push(next);
            }
        }
    }
}

function minesweeperSvg(game, showMines) {
    const total = MINESWEEPER_MARGIN * 2 + MINESWEEPER_CELL * game.size;
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}">`);
    parts.push(`<rect width="${total}" height="${total}" fill="#2b2b2b"/>`);
    for (let r = 0; r < game.size; r++) {
        for (let c = 0; c < game.size; c++) {
            const key = r * game.size + c;
            const x = MINESWEEPER_MARGIN + c * MINESWEEPER_CELL;
            const y = MINESWEEPER_MARGIN + r * MINESWEEPER_CELL;
            const cx = x + MINESWEEPER_CELL / 2;
            const cy = y + MINESWEEPER_CELL / 2;
            const open = game.opened.has(key);
            const dark = (r + c) % 2 === 1;
            let fill = dark ? "#b58863" : "#f0d9b5";
            if (!open) {
                fill = dark ? "#769656" : "#86a666";
            }
            parts.push(`<rect x="${x}" y="${y}" width="${MINESWEEPER_CELL}" height="${MINESWEEPER_CELL}" fill="${fill}"/>`);
            if (game.exploded === key) {
                parts.push(`<rect x="${x}" y="${y}" width="${MINESWEEPER_CELL}" height="${MINESWEEPER_CELL}" fill="#e0453a" fill-opacity="0.7"/>`);
            }
            if (open) {
                const count = minesweeperCount(game, r, c);
                if (count) {
                    parts.push(`<text x="${cx}" y="${cy + 12}" font-family="${MINESWEEPER_FONT}" font-size="36" text-anchor="middle" fill="${MINESWEEPER_NUMBER_COLORS[count]}">${count}</text>`);
                }
            } else if (showMines && game.mineAt.has(key)) {
                parts.push(`<line x1="${cx - 18}" y1="${cy}" x2="${cx + 18}" y2="${cy}" stroke="#161616" stroke-width="3"/>`);
                parts.push(`<line x1="${cx}" y1="${cy - 18}" x2="${cx}" y2="${cy + 18}" stroke="#161616" stroke-width="3"/>`);
                parts.push(`<line x1="${cx - 13}" y1="${cy - 13}" x2="${cx + 13}" y2="${cy + 13}" stroke="#161616" stroke-width="3"/>`);
                parts.push(`<line x1="${cx - 13}" y1="${cy + 13}" x2="${cx + 13}" y2="${cy - 13}" stroke="#161616" stroke-width="3"/>`);
                parts.push(`<circle cx="${cx}" cy="${cy}" r="12" fill="#161616"/>`);
            } else if (game.flagged.has(key)) {
                parts.push(`<rect x="${cx - 8}" y="${y + 10}" width="3" height="34" fill="#161616"/>`);
                parts.push(`<polygon points="${cx - 5},${y + 10} ${cx + 15},${y + 19} ${cx - 5},${y + 28}" fill="#d22d2d"/>`);
            }
        }
    }
    for (let i = 0; i < game.size; i++) {
        const mid = MINESWEEPER_MARGIN + i * MINESWEEPER_CELL + MINESWEEPER_CELL / 2;
        parts.push(`<text x="${mid}" y="${total - 7}" font-family="${MINESWEEPER_FONT}" font-size="15" text-anchor="middle" fill="#cfcfcf">${MINESWEEPER_COLUMNS[i]}</text>`);
        parts.push(`<text x="${MINESWEEPER_MARGIN / 2}" y="${mid + 5}" font-family="${MINESWEEPER_FONT}" font-size="15" text-anchor="middle" fill="#cfcfcf">${i + 1}</text>`);
    }
    parts.push("</svg>");
    return parts.join("");
}

function minesweeperImage(game, showMines) {
    return sharp(Buffer.from(minesweeperSvg(game, showMines))).png().toBuffer();
}

async function sendMinesweeper(sock, chatId, game, caption, showMines = false, mentions = []) {
    const image = await minesweeperImage(game, showMines);
    await sock.sendMessage(chatId, { image, caption, mentions });
}

function minesweeperText(game) {
    const left = game.mines - game.flagged.size;
    return "Minesweeper (" + game.level + "), mines left: " + left + ". Send dig b3 to open a square or flag b3 to mark one.";
}

function minesweeperEnded(game) {
    return "You opened " + game.opened.size + " of " + (game.size * game.size - game.mines) + " safe squares.";
}

function armMinesweeperTimer(sock, chatId, game) {
    armTimer(
        sock,
        minesweeperGames,
        chatId,
        game,
        gameMs(chatId, MINESWEEPER_IDLE_MS),
        "The minesweeper game has ended because nobody played in time.",
        minesweeperEnded,
        "idleTimeout"
    );
}

async function handleMinesweeper(sock, msg, ctx) {
    const { chatId, senderJid, text, trusted, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "minesweeper")) {
        return;
    }
    const argument = text.slice("!minesweeper".length).trim().toLowerCase();
    const game = minesweeperGames.get(chatId);
    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no minesweeper game to cancel.");
            return;
        }
        if (!sameWho(senderIds(msg), game.starterIds) && !trusted) {
            await reply(sock, msg, "Only the player who started the game or a trusted user can cancel it.");
            return;
        }
        clearGameTimers(game);
        minesweeperGames.delete(chatId);
        await reply(sock, msg, "The minesweeper game has been cancelled. " + minesweeperEnded(game));
        return;
    }
    if (argument && !Object.hasOwn(MINESWEEPER_LEVELS, argument)) {
        await reply(sock, msg, "Usage: " + commandPrefix + "minesweeper [easy|medium|hard|cancel]");
        return;
    }
    if (game) {
        await sendMinesweeper(sock, chatId, game, minesweeperText(game));
        return;
    }
    if (!await canStartGame(sock, msg, chatId, senderJid)) {
        return;
    }
    const level = argument || "easy";
    const newGame = {
        level,
        size: MINESWEEPER_LEVELS[level].size,
        mines: MINESWEEPER_LEVELS[level].mines,
        mineAt: new Set(),
        opened: new Set(),
        flagged: new Set(),
        started: false,
        exploded: null,
        starterIds: senderIds(msg),
        idleTimeout: null
    };
    minesweeperGames.set(chatId, newGame);
    armMinesweeperTimer(sock, chatId, newGame);
    await sendMinesweeper(
        sock,
        chatId,
        newGame,
        minesweeperText(newGame) + "\nAnyone can play. Your first dig is always safe. The game ends after three minutes without a move."
    );
}

async function handleMinesweeperAnswer(sock, msg, chatId, senderJid, text) {
    const game = minesweeperGames.get(chatId);
    if (!game) {
        return false;
    }
    const move = /^(dig|flag)\s+([a-j])(\d{1,2})$/i.exec(text.trim());
    if (!move) {
        return false;
    }
    const action = move[1].toLowerCase();
    const col = MINESWEEPER_COLUMNS.indexOf(move[2].toLowerCase());
    const row = Number(move[3]) - 1;
    if (col >= game.size || row < 0 || row >= game.size) {
        await reply(sock, msg, "That square is off the board.");
        return true;
    }
    const key = row * game.size + col;
    if (game.opened.has(key)) {
        await reply(sock, msg, "That square is already open.");
        return true;
    }
    if (action === "flag") {
        if (game.flagged.has(key)) {
            game.flagged.delete(key);
        } else {
            game.flagged.add(key);
        }
        if (game.started && game.flagged.size === game.mines && [...game.flagged].every(flagKey => game.mineAt.has(flagKey))) {
            clearGameTimers(game);
            minesweeperGames.delete(chatId);
            await sendMinesweeper(sock, chatId, game, tag(senderJid) + " found every mine!", true, [senderJid]);
            return true;
        }
        armMinesweeperTimer(sock, chatId, game);
        await sendMinesweeper(sock, chatId, game, minesweeperText(game));
        return true;
    }
    if (game.flagged.has(key)) {
        await reply(sock, msg, "That square is flagged. Send flag " + move[2].toLowerCase() + move[3] + " again to remove the flag.");
        return true;
    }
    if (!game.started) {
        minesweeperPlaceMines(game, row, col);
        game.started = true;
    }
    if (game.mineAt.has(key)) {
        game.exploded = key;
        clearGameTimers(game);
        minesweeperGames.delete(chatId);
        await sendMinesweeper(sock, chatId, game, tag(senderJid) + " hit a mine!", true, [senderJid]);
        return true;
    }
    minesweeperOpen(game, row, col);
    if (game.opened.size === game.size * game.size - game.mines) {
        clearGameTimers(game);
        minesweeperGames.delete(chatId);
        await sendMinesweeper(sock, chatId, game, tag(senderJid) + " cleared the board!", true, [senderJid]);
        return true;
    }
    armMinesweeperTimer(sock, chatId, game);
    await sendMinesweeper(sock, chatId, game, minesweeperText(game));
    return true;
}

// ----------------------------------------------------
// !crossword
// ----------------------------------------------------

const CROSSWORD_IDLE_MS = 5 * 60 * 1000;
const CROSSWORD_GRID = 15;
const CROSSWORD_CANDIDATES = 12;
const CROSSWORD_MIN_WORDS = 5;
const CROSSWORD_MAX_WORDS = 8;
const CROSSWORD_CELL = 52;
const CROSSWORD_MARGIN = 14;
const CROSSWORD_FONT = "DejaVu Sans, Arial, sans-serif";
const crosswordGames = new Map();
const crosswordMaking = new Set();

function crosswordFits(grid, word, row, col, across) {
    const dr = across ? 0 : 1;
    const dc = across ? 1 : 0;
    const endRow = row + dr * (word.length - 1);
    const endCol = col + dc * (word.length - 1);
    if (row < 0 || col < 0 || endRow >= CROSSWORD_GRID || endCol >= CROSSWORD_GRID) {
        return -1;
    }
    const filled = (r, c) => r >= 0 && c >= 0 && r < CROSSWORD_GRID && c < CROSSWORD_GRID && grid[r][c].letter !== "";
    if (filled(row - dr, col - dc) || filled(endRow + dr, endCol + dc)) {
        return -1;
    }
    let crossings = 0;
    for (let i = 0; i < word.length; i++) {
        const r = row + dr * i;
        const c = col + dc * i;
        const cell = grid[r][c];
        if (cell.letter) {
            if (cell.letter !== word[i] || cell.dirs.includes(across ? "a" : "d")) {
                return -1;
            }
            crossings++;
        } else if (filled(r + dc, c + dr) || filled(r - dc, c - dr)) {
            return -1;
        }
    }
    return crossings;
}

function crosswordBuild(words) {
    const grid = Array.from({ length: CROSSWORD_GRID }, () => Array.from({ length: CROSSWORD_GRID }, () => ({ letter: "", dirs: "" })));
    const placed = [];
    const put = (word, row, col, across) => {
        for (let i = 0; i < word.length; i++) {
            const cell = grid[row + (across ? 0 : i)][col + (across ? i : 0)];
            cell.letter = word[i];
            cell.dirs += across ? "a" : "d";
        }
        placed.push({ word, row, col, across });
    };
    const sorted = [...words].sort((a, b) => b.length - a.length);
    put(sorted[0], Math.floor(CROSSWORD_GRID / 2), Math.floor((CROSSWORD_GRID - sorted[0].length) / 2), true);
    for (const word of sorted.slice(1)) {
        if (placed.length >= CROSSWORD_MAX_WORDS) {
            break;
        }
        const options = [];
        for (let row = 0; row < CROSSWORD_GRID; row++) {
            for (let col = 0; col < CROSSWORD_GRID; col++) {
                for (const across of [true, false]) {
                    if (crosswordFits(grid, word, row, col, across) > 0) {
                        options.push([row, col, across]);
                    }
                }
            }
        }
        if (options.length) {
            const pick = options[randomInt(0, options.length - 1)];
            put(word, pick[0], pick[1], pick[2]);
        }
    }
    return placed;
}

function crosswordKeys(game, entry) {
    return Array.from({ length: entry.word.length }, (_, i) => (entry.row + (entry.across ? 0 : i)) * game.cols + entry.col + (entry.across ? i : 0));
}

function crosswordLayout(placed) {
    const spots = placed.flatMap((p) => Array.from({ length: p.word.length }, (_, i) => [p.row + (p.across ? 0 : i), p.col + (p.across ? i : 0)]));
    const top = Math.min(...spots.map(([r]) => r));
    const left = Math.min(...spots.map(([, c]) => c));
    const rows = Math.max(...spots.map(([r]) => r)) - top + 1;
    const cols = Math.max(...spots.map(([, c]) => c)) - left + 1;
    const words = placed.map((p) => ({ word: p.word, row: p.row - top, col: p.col - left, across: p.across, number: 0, clue: "", solved: false }));
    const starts = [...new Set(words.map((w) => w.row * cols + w.col))].sort((a, b) => a - b);
    for (const w of words) {
        w.number = starts.indexOf(w.row * cols + w.col) + 1;
    }
    const game = { rows, cols, words, letters: new Map(), revealed: new Set(), solvedKeys: new Set(), idleTimeout: null };
    for (const w of words) {
        crosswordKeys(game, w).forEach((key, i) => game.letters.set(key, w.word[i]));
    }
    return game;
}

async function crosswordClues(words) {
    const defs = await Promise.all(words.map((w) => getDefinition(w.word).catch(() => null)));
    const written = {};
    const system = "You write crossword clues. For each word, write one short clue of at most 10 words. Never use the word itself or part of it in the clue. Reply with one line per word in the format word: clue and nothing else.";
    const prompt = words.map((w, i) => w.word + (defs[i] ? " (dictionary: " + defs[i] + ")" : "")).join("\n");
    const answer = await askDesktop(system, prompt, 45 * 1000);
    for (const line of (answer || "").split("\n")) {
        const match = /^\W*([a-z]+)\W*:\s*(.+)$/i.exec(line.trim());
        if (match) {
            written[match[1].toLowerCase()] = match[2].trim();
        }
    }
    words.forEach((w, i) => {
        const ai = written[w.word];
        const usable = ai && !ai.toLowerCase().replace(/[^a-z]/g, "").includes(w.word);
        const plain = defs[i] || "A word with " + w.word.length + " letters starting with " + w.word[0].toUpperCase();
        w.clue = (usable ? ai : plain).slice(0, 70);
    });
}

async function crosswordCreate() {
    const pool = new Set();
    for (let attempt = 0; attempt < 2; attempt++) {
        const lengths = Array.from({ length: CROSSWORD_CANDIDATES }, (_, i) => 4 + (i % 4));
        const found = await Promise.all(lengths.map((length) => randomWord("1", length).catch(() => null)));
        for (const word of found) {
            if (typeof word === "string" && /^[a-z]{4,7}$/i.test(word)) {
                pool.add(word.toLowerCase());
            }
        }
        if (pool.size < CROSSWORD_MIN_WORDS) {
            continue;
        }
        const placed = crosswordBuild([...pool]);
        if (placed.length >= CROSSWORD_MIN_WORDS) {
            const game = crosswordLayout(placed);
            await crosswordClues(game.words);
            return game;
        }
    }
    return null;
}

function crosswordSvg(game, showAll) {
    const width = CROSSWORD_MARGIN * 2 + CROSSWORD_CELL * game.cols;
    const height = CROSSWORD_MARGIN * 2 + CROSSWORD_CELL * game.rows;
    const numbers = new Map(game.words.map((w) => [w.row * game.cols + w.col, w.number]));
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`);
    parts.push(`<rect width="${width}" height="${height}" fill="#2b2b2b"/>`);
    for (const [key, letter] of game.letters) {
        const x = CROSSWORD_MARGIN + (key % game.cols) * CROSSWORD_CELL;
        const y = CROSSWORD_MARGIN + Math.floor(key / game.cols) * CROSSWORD_CELL;
        const solved = game.solvedKeys.has(key);
        parts.push(`<rect x="${x}" y="${y}" width="${CROSSWORD_CELL}" height="${CROSSWORD_CELL}" fill="${solved ? "#86a666" : "#f0d9b5"}" stroke="#8a6d4b" stroke-width="1"/>`);
        if (numbers.has(key)) {
            parts.push(`<text x="${x + 4}" y="${y + 14}" font-family="${CROSSWORD_FONT}" font-size="12" fill="#444444">${numbers.get(key)}</text>`);
        }
        if (showAll || solved || game.revealed.has(key)) {
            parts.push(`<text x="${x + CROSSWORD_CELL / 2}" y="${y + CROSSWORD_CELL / 2 + 12}" font-family="${CROSSWORD_FONT}" font-size="32" text-anchor="middle" fill="#161616">${letter.toUpperCase()}</text>`);
        }
    }
    parts.push("</svg>");
    return parts.join("");
}

async function sendCrossword(sock, chatId, game, caption, mentions = []) {
    const image = await sharp(Buffer.from(crosswordSvg(game, false))).png().toBuffer();
    await sock.sendMessage(chatId, { image, caption, mentions });
}

function crosswordText(game) {
    const solved = game.words.filter((w) => w.solved).length;
    const lines = ["Crossword: " + solved + " of " + game.words.length + " solved. Answer with 1 across word or 3d word."];
    for (const [label, across] of [["Across", true], ["Down", false]]) {
        const list = game.words.filter((w) => w.across === across && !w.solved).sort((a, b) => a.number - b.number);
        if (list.length) {
            lines.push("", label);
            for (const w of list) {
                lines.push(w.number + ". " + w.clue + " (" + w.word.length + ")");
            }
        }
    }
    return lines.join("\n");
}

function crosswordEnded(game) {
    const left = game.words.filter((w) => !w.solved);
    const done = game.words.length - left.length;
    const missed = left.map((w) => w.number + (w.across ? " across " : " down ") + w.word).join(", ");
    return "You solved " + done + " of " + game.words.length + " words." + (left.length ? " Unsolved: " + missed + "." : "");
}

function armCrosswordTimer(sock, chatId, game) {
    armTimer(
        sock,
        crosswordGames,
        chatId,
        game,
        gameMs(chatId, CROSSWORD_IDLE_MS),
        "The crossword has ended because nobody answered in time.",
        crosswordEnded,
        "idleTimeout"
    );
}

async function handleCrossword(sock, msg, ctx) {
    const { chatId, senderJid, text, trusted, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "crossword")) {
        return;
    }
    const argument = text.slice("!crossword".length).trim().toLowerCase();
    const game = crosswordGames.get(chatId);
    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no crossword to cancel.");
            return;
        }
        if (!sameWho(senderIds(msg), game.starterIds) && !trusted) {
            await reply(sock, msg, "Only the player who started the game or a trusted user can cancel it.");
            return;
        }
        clearGameTimers(game);
        crosswordGames.delete(chatId);
        await reply(sock, msg, "The crossword has been cancelled. " + crosswordEnded(game));
        return;
    }
    if (argument === "hint") {
        if (!game) {
            await reply(sock, msg, "There is no crossword running.");
            return;
        }
        const hidden = game.words
            .filter((w) => !w.solved)
            .flatMap((w) => crosswordKeys(game, w))
            .filter((key) => !game.revealed.has(key) && !game.solvedKeys.has(key));
        if (!hidden.length) {
            await reply(sock, msg, "There is nothing left to reveal.");
            return;
        }
        game.revealed.add(hidden[randomInt(0, hidden.length - 1)]);
        armCrosswordTimer(sock, chatId, game);
        await sendCrossword(sock, chatId, game, crosswordText(game));
        return;
    }
    if (argument) {
        await reply(sock, msg, "Usage: " + commandPrefix + "crossword [hint|cancel]");
        return;
    }
    if (game) {
        await sendCrossword(sock, chatId, game, crosswordText(game));
        return;
    }
    if (crosswordMaking.has(chatId)) {
        await reply(sock, msg, "A crossword is already being made.");
        return;
    }
    if (!await canStartGame(sock, msg, chatId, senderJid)) {
        return;
    }
    crosswordMaking.add(chatId);
    try {
        await reply(sock, msg, "Making a crossword, gimme a few seconds.");
        const newGame = await crosswordCreate();
        if (!newGame) {
            await reply(sock, msg, "I could not make a crossword right now. Try again in a moment.");
            return;
        }
        if (!await canStartGame(sock, msg, chatId, senderJid)) {
            return;
        }
        newGame.starterIds = senderIds(msg);
        crosswordGames.set(chatId, newGame);
        log.info("games", `Starting crossword game in ${describeGroup(chatId)}. The answers are: ${newGame.words.map(entry => entry.number + (entry.across ? "a" : "d") + " " + entry.word).join(", ")}`);
        armCrosswordTimer(sock, chatId, newGame);
        await sendCrossword(sock, chatId, newGame, crosswordText(newGame) + "\nAnyone can play. The game ends after five minutes without an answer.");
    } finally {
        crosswordMaking.delete(chatId);
    }
}

async function handleCrosswordAnswer(sock, msg, chatId, senderJid, text) {
    const game = crosswordGames.get(chatId);
    if (!game) {
        return false;
    }
    const move = /^(\d{1,2})(?:\s*(across|down)|(a|d))\s+([a-z]{2,15})$/i.exec(text.trim());
    if (!move) {
        return false;
    }
    const across = (move[2] || move[3]).toLowerCase().startsWith("a");
    const target = game.words.find((w) => w.number === Number(move[1]) && w.across === across);
    if (!target) {
        return false;
    }
    const label = target.number + (across ? " across" : " down");
    if (target.solved) {
        await reply(sock, msg, label + " is already solved.");
        return true;
    }
    if (move[4].toLowerCase() !== target.word) {
        await reply(sock, msg, "That is not the answer for " + label + ".");
        return true;
    }
    target.solved = true;
    for (const key of crosswordKeys(game, target)) {
        game.solvedKeys.add(key);
    }
    if (game.words.every((w) => w.solved)) {
        clearGameTimers(game);
        crosswordGames.delete(chatId);
        await sendCrossword(sock, chatId, game, tag(senderJid) + " solved " + label + ", the crossword is complete!", [senderJid]);
        return true;
    }
    armCrosswordTimer(sock, chatId, game);
    await sendCrossword(sock, chatId, game, tag(senderJid) + " got " + label + "!\n\n" + crosswordText(game), [senderJid]);
    return true;
}

// ----------------------------------------------------
// !connect4 [join|ai|cancel]
// ----------------------------------------------------

const CONNECT4_LOBBY_MS = 60 * 1000;
const CONNECT4_TURN_MS = 3 * 60 * 1000;
const CONNECT4_COLUMNS = 7;
const CONNECT4_ROWS = 6;
const CONNECT4_DEPTH = 5;
const CONNECT4_ORDER = [3, 2, 4, 1, 5, 0, 6];
const CONNECT4_CELL = 64;
const CONNECT4_MARGIN = 32;
const CONNECT4_FONT = "DejaVu Sans, Arial, sans-serif";
const connect4Games = new Map();

const CONNECT4_LINES = (() => {
    const lines = [];
    for (let row = 0; row < CONNECT4_ROWS; row++) {
        for (let col = 0; col < CONNECT4_COLUMNS; col++) {
            for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
                const endRow = row + dr * 3;
                const endCol = col + dc * 3;
                if (endRow < 0 || endRow >= CONNECT4_ROWS || endCol < 0 || endCol >= CONNECT4_COLUMNS) {
                    continue;
                }
                lines.push([0, 1, 2, 3].map((step) => (row + dr * step) * CONNECT4_COLUMNS + col + dc * step));
            }
        }
    }
    return lines;
})();

function connect4Drop(board, col) {
    for (let row = CONNECT4_ROWS - 1; row >= 0; row--) {
        if (!board[row * CONNECT4_COLUMNS + col]) {
            return row;
        }
    }
    return -1;
}

function connect4Winner(board) {
    for (const line of CONNECT4_LINES) {
        const piece = board[line[0]];
        if (piece && piece === board[line[1]] && piece === board[line[2]] && piece === board[line[3]]) {
            return line;
        }
    }
    return null;
}

function connect4Full(board) {
    return board.every(Boolean);
}

function connect4Score(board, me, other) {
    let score = 0;
    for (let row = 0; row < CONNECT4_ROWS; row++) {
        const piece = board[row * CONNECT4_COLUMNS + 3];
        if (piece === me) {
            score += 3;
        } else if (piece === other) {
            score -= 3;
        }
    }
    for (const line of CONNECT4_LINES) {
        let mine = 0;
        let theirs = 0;
        for (const index of line) {
            if (board[index] === me) {
                mine++;
            } else if (board[index] === other) {
                theirs++;
            }
        }
        if (theirs === 0) {
            if (mine === 3) {
                score += 5;
            } else if (mine === 2) {
                score += 2;
            }
        } else if (mine === 0) {
            if (theirs === 3) {
                score -= 6;
            } else if (theirs === 2) {
                score -= 2;
            }
        }
    }
    return score;
}

function connect4Negamax(board, depth, alpha, beta, current, other) {
    let best = -Infinity;
    let moved = false;
    for (const col of CONNECT4_ORDER) {
        const row = connect4Drop(board, col);
        if (row < 0) {
            continue;
        }
        moved = true;
        board[row * CONNECT4_COLUMNS + col] = current;
        let value;
        if (connect4Winner(board)) {
            value = 100000 + depth;
        } else if (depth === 0) {
            value = connect4Score(board, current, other);
        } else {
            value = -connect4Negamax(board, depth - 1, -beta, -alpha, other, current);
        }
        board[row * CONNECT4_COLUMNS + col] = 0;
        if (value > best) {
            best = value;
        }
        if (best > alpha) {
            alpha = best;
        }
        if (alpha >= beta) {
            break;
        }
    }
    return moved ? best : 0;
}

function connect4BotMove(board, bot, human) {
    let bestValue = -Infinity;
    let bestColumns = [];
    for (const col of CONNECT4_ORDER) {
        const row = connect4Drop(board, col);
        if (row < 0) {
            continue;
        }
        board[row * CONNECT4_COLUMNS + col] = bot;
        let value;
        if (connect4Winner(board)) {
            value = 1000000;
        } else {
            value = -connect4Negamax(board, CONNECT4_DEPTH - 1, -Infinity, Infinity, human, bot);
        }
        board[row * CONNECT4_COLUMNS + col] = 0;
        if (value > bestValue) {
            bestValue = value;
            bestColumns = [col];
        } else if (value === bestValue) {
            bestColumns.push(col);
        }
    }
    return bestColumns[randomInt(0, bestColumns.length - 1)];
}

function connect4Svg(game) {
    const width = CONNECT4_COLUMNS * CONNECT4_CELL + CONNECT4_MARGIN * 2;
    const height = CONNECT4_ROWS * CONNECT4_CELL + CONNECT4_MARGIN * 2;
    const boardWidth = CONNECT4_COLUMNS * CONNECT4_CELL;
    const boardHeight = CONNECT4_ROWS * CONNECT4_CELL;
    const winning = new Set(game.winLine || []);
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    parts.push(`<rect width="${width}" height="${height}" fill="#2b2b2b"/>`);
    parts.push(`<rect x="${CONNECT4_MARGIN}" y="${CONNECT4_MARGIN}" width="${boardWidth}" height="${boardHeight}" rx="8" fill="#3b6ea8"/>`);
    for (let col = 0; col < CONNECT4_COLUMNS; col++) {
        const cx = CONNECT4_MARGIN + col * CONNECT4_CELL + CONNECT4_CELL / 2;
        parts.push(`<text x="${cx}" y="${CONNECT4_MARGIN - 10}" font-family="${CONNECT4_FONT}" font-size="15" text-anchor="middle" fill="#cfcfcf">${col + 1}</text>`);
        parts.push(`<text x="${cx}" y="${CONNECT4_MARGIN + boardHeight + 21}" font-family="${CONNECT4_FONT}" font-size="15" text-anchor="middle" fill="#cfcfcf">${col + 1}</text>`);
    }
    for (let row = 0; row < CONNECT4_ROWS; row++) {
        for (let col = 0; col < CONNECT4_COLUMNS; col++) {
            const index = row * CONNECT4_COLUMNS + col;
            const cx = CONNECT4_MARGIN + col * CONNECT4_CELL + CONNECT4_CELL / 2;
            const cy = CONNECT4_MARGIN + row * CONNECT4_CELL + CONNECT4_CELL / 2;
            const piece = game.board[index];
            const fill = piece === 1 ? "#d9453b" : piece === 2 ? "#e8c547" : "#2b2b2b";
            parts.push(`<circle cx="${cx}" cy="${cy}" r="${CONNECT4_CELL * 0.4}" fill="${fill}"/>`);
            if (piece) {
                parts.push(`<circle cx="${cx}" cy="${cy}" r="${CONNECT4_CELL * 0.27}" fill="none" stroke="#000000" stroke-opacity="0.18" stroke-width="3"/>`);
            }
            if (winning.has(index)) {
                parts.push(`<circle cx="${cx}" cy="${cy}" r="${CONNECT4_CELL * 0.4}" fill="none" stroke="#f0d9b5" stroke-width="5"/>`);
            } else if (index === game.last) {
                parts.push(`<circle cx="${cx}" cy="${cy}" r="${CONNECT4_CELL * 0.12}" fill="#2b2b2b" fill-opacity="0.55"/>`);
            }
        }
    }
    parts.push("</svg>");
    return parts.join("");
}

async function connect4Image(game) {
    return sharp(Buffer.from(connect4Svg(game))).png().toBuffer();
}

async function sendConnect4(sock, chatId, game, caption, mentions = []) {
    const image = await connect4Image(game);
    await sock.sendMessage(chatId, { image, caption, mentions });
}

function connect4Names(game) {
    const second = game.vsBot ? "me" : tag(game.players[1]);
    return `${tag(game.players[0])} (red) vs ${second} (yellow)`;
}

function connect4TurnText(game) {
    const colour = game.turn === 0 ? "red" : "yellow";
    return `${tag(game.players[game.turn])}'s turn (${colour}). Send a column number from 1 to 7.`;
}

function armConnect4Timer(sock, chatId, game) {
    armTimer(
        sock,
        connect4Games,
        chatId,
        game,
        gameMs(chatId, CONNECT4_TURN_MS),
        "Time is up, so the connect 4 game ended."
    );
}

async function handleConnect4(sock, msg, ctx) {
    const { chatId, senderJid, text, trusted, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "connect 4")) {
        return;
    }

    const argument = text.slice("!connect4".length).trim().toLowerCase();
    const game = connect4Games.get(chatId);

    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no connect 4 game to cancel.");
            return;
        }
        if (!game.players.includes(senderJid) && !trusted) {
            await reply(sock, msg, "Only a player or a trusted user can cancel the game.");
            return;
        }
        clearGameTimers(game);
        connect4Games.delete(chatId);
        await reply(sock, msg, "The connect 4 game was cancelled.");
        return;
    }

    if (argument === "ai") {
        if (!await canStartGame(sock, msg, chatId, senderJid, "connect 4")) {
            return;
        }
        const botGame = {
            players: [senderJid, null],
            vsBot: true,
            board: Array(CONNECT4_COLUMNS * CONNECT4_ROWS).fill(0),
            turn: 0,
            status: "playing",
            last: null,
            winLine: null,
            timeout: null
        };
        connect4Games.set(chatId, botGame);
        armConnect4Timer(sock, chatId, botGame);
        await sendConnect4(sock, chatId, botGame, `${connect4Names(botGame)}\n${connect4TurnText(botGame)}`, [senderJid]);
        return;
    }

    if (argument === "join") {
        if (!game) {
            await reply(sock, msg, `There is no connect 4 lobby to join. Start one with ${commandPrefix}connect4.`);
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
        armConnect4Timer(sock, chatId, game);
        await sendConnect4(sock, chatId, game, `${connect4Names(game)}\n${connect4TurnText(game)}`, [...game.players]);
        return;
    }

    if (argument) {
        await reply(sock, msg, `Usage: ${commandPrefix}connect4 [join|ai|cancel]`);
        return;
    }

    if (game) {
        const status = game.status === "lobby"
            ? `Waiting for an opponent. Send ${commandPrefix}connect4 join to play.`
            : connect4TurnText(game);
        await sendConnect4(sock, chatId, game, status, game.players.filter(Boolean));
        return;
    }

    if (!await canStartGame(sock, msg, chatId, senderJid, "connect 4")) {
        return;
    }

    const newGame = {
        players: [senderJid, null],
        board: Array(CONNECT4_COLUMNS * CONNECT4_ROWS).fill(0),
        turn: 0,
        status: "lobby",
        last: null,
        winLine: null,
        timeout: null
    };
    connect4Games.set(chatId, newGame);
    armTimer(sock, connect4Games, chatId, newGame, CONNECT4_LOBBY_MS, "Nobody joined, so the connect 4 lobby closed.");
    await sock.sendMessage(chatId, {
        text: `${tag(senderJid)} wants to play connect 4 as red. Send ${commandPrefix}connect4 join to play as yellow.`,
        mentions: [senderJid]
    });
}

async function handleConnect4Move(sock, chatId, senderJid, text) {
    const game = connect4Games.get(chatId);
    if (
        !game ||
        game.status !== "playing" ||
        !/^[1-7]$/.test(text.trim()) ||
        senderJid !== game.players[game.turn]
    ) {
        return false;
    }

    const col = Number(text.trim()) - 1;
    const row = connect4Drop(game.board, col);
    if (row < 0) {
        await sock.sendMessage(chatId, { text: "That column is full." });
        return true;
    }

    game.board[row * CONNECT4_COLUMNS + col] = game.turn + 1;
    game.last = row * CONNECT4_COLUMNS + col;
    const line = connect4Winner(game.board);
    if (line || connect4Full(game.board)) {
        game.winLine = line;
        clearGameTimers(game);
        connect4Games.delete(chatId);
        await sendConnect4(sock, chatId, game, line ? `${tag(senderJid)} wins!` : "It's a draw.", [senderJid]);
        return true;
    }

    if (game.vsBot) {
        const botCol = connect4BotMove(game.board, 2, 1);
        const botRow = connect4Drop(game.board, botCol);
        game.board[botRow * CONNECT4_COLUMNS + botCol] = 2;
        game.last = botRow * CONNECT4_COLUMNS + botCol;
        const botLine = connect4Winner(game.board);
        if (botLine || connect4Full(game.board)) {
            game.winLine = botLine;
            clearGameTimers(game);
            connect4Games.delete(chatId);
            await sendConnect4(sock, chatId, game, `I played ${botCol + 1}. ${botLine ? "I win!" : "It's a draw."}`, [senderJid]);
            return true;
        }
        armConnect4Timer(sock, chatId, game);
        await sendConnect4(sock, chatId, game, `I played ${botCol + 1}. ${connect4TurnText(game)}`, [senderJid]);
        return true;
    }

    game.turn = game.turn === 0 ? 1 : 0;
    armConnect4Timer(sock, chatId, game);
    await sendConnect4(sock, chatId, game, connect4TurnText(game), [...game.players]);
    return true;
}


const HANGMAN_GAME_MS = 3 * 60 * 1000;
const HANGMAN_MAX_MISSES = 6;
const hangmanGames = new Map();

const HANGMAN_PARTS = [
    `<circle cx="250" cy="125" r="25"/>`,
    `<line x1="250" y1="150" x2="250" y2="230"/>`,
    `<line x1="250" y1="170" x2="215" y2="205"/>`,
    `<line x1="250" y1="170" x2="285" y2="205"/>`,
    `<line x1="250" y1="230" x2="220" y2="290"/>`,
    `<line x1="250" y1="230" x2="280" y2="290"/>`
];

function hangmanSvg(game, reveal) {
    const letters = [...game.word].map(letter => (reveal || game.guessed.has(letter) ? letter.toUpperCase() : "_"));
    const wordSize = Math.min(44, Math.floor(440 / (letters.length * 1.3)));
    const missed = game.misses.map(miss => miss.toUpperCase()).join(" ");

    return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="420">` +
        `<rect width="480" height="420" fill="#111111"/>` +
        `<g stroke="#eeeeee" stroke-width="6" stroke-linecap="round" fill="none">` +
        `<line x1="40" y1="320" x2="200" y2="320"/><line x1="120" y1="320" x2="120" y2="60"/>` +
        `<line x1="120" y1="60" x2="250" y2="60"/><line x1="250" y1="60" x2="250" y2="100"/>` +
        `${HANGMAN_PARTS.slice(0, game.misses.length).join("")}</g>` +
        `<text x="240" y="355" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#ff8a8a" text-anchor="middle">${missed ? `Missed: ${missed}` : ""}</text>` +
        `<text x="240" y="400" font-family="DejaVu Sans Mono, monospace" font-size="${wordSize}" font-weight="bold" fill="#ffffff" text-anchor="middle" xml:space="preserve">${letters.join(" ")}</text>` +
        `</svg>`;
}

async function sendHangman(sock, chatId, game, caption, mentions = [], reveal = false) {
    const image = await sharp(Buffer.from(hangmanSvg(game, reveal))).png().toBuffer();
    await sock.sendMessage(chatId, { image, caption, mentions });
}

async function hangmanGuess(sock, msg, chatId, senderJid, game, guess) {
    if (guess.length === 1) {
        if (game.guessed.has(guess) || game.misses.includes(guess)) {
            await reply(sock, msg, `${guess.toUpperCase()} was already guessed.`);
            return;
        }
        if (game.word.includes(guess)) {
            game.guessed.add(guess);
        } else {
            game.misses.push(guess);
        }
    } else {
        for (const letter of game.word) game.guessed.add(letter);
    }

    const won = [...game.word].every(letter => game.guessed.has(letter));
    const lost = !won && game.misses.length >= HANGMAN_MAX_MISSES;
    if (won || lost) {
        clearGameTimers(game);
        hangmanGames.delete(chatId);
        log.info("games", `Hangman in ${describeGroup(chatId)} ended, ${won ? "won" : "lost"}. The word was: ${game.word}`);
        if (won) {
            await sendHangman(sock, chatId, game, `${tag(senderJid)} got it. The word was "${game.word}".`, [senderJid]);
        } else {
            await sendHangman(sock, chatId, game, `The man was hanged. The word was "${game.word}".`, [], true);
        }
        return;
    }

    const hit = game.word.includes(guess);
    await sendHangman(sock, chatId, game, guess.length === 1 ? (hit ? `${guess.toUpperCase()} is in the word.` : `No ${guess.toUpperCase()}.`) : "");
}

async function handleHangman(sock, msg, ctx) {
    const { chatId, senderJid, text, trusted, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "hangman")) {
        return;
    }

    const argument = text.slice("!hangman".length).trim().toLowerCase();
    const game = hangmanGames.get(chatId);

    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no hangman game to cancel.");
            return;
        }
        if (!game.loading && !sameWho(senderIds(msg), game.starterIds) && !trusted) {
            await reply(sock, msg, "Only the player who started the game or a trusted user can cancel it.");
            return;
        }
        clearGameTimers(game);
        hangmanGames.delete(chatId);
        await reply(sock, msg, game.loading ? "The hangman game was cancelled." : `The hangman game was cancelled. The word was "${game.word}".`);
        return;
    }

    if (argument && game && !game.loading && /^[a-z]$/.test(argument)) {
        await hangmanGuess(sock, msg, chatId, senderJid, game, argument);
        return;
    }
    if (argument) {
        await reply(sock, msg, `Usage: ${commandPrefix}hangman [cancel]`);
        return;
    }

    if (game) {
        if (!game.loading) {
            await sendHangman(sock, chatId, game, "");
        }
        return;
    }

    if (!await canStartGame(sock, msg, chatId, senderJid)) {
        return;
    }

    const newGame = { loading: true, word: null, guessed: new Set(), misses: [], starterIds: senderIds(msg), timeout: null };
    hangmanGames.set(chatId, newGame);
    try {
        const word = await randomWord("1", 7);
        if (hangmanGames.get(chatId) !== newGame) {
            return;
        }
        if (typeof word !== "string" || !/^[a-z]{3,}$/i.test(word)) {
            hangmanGames.delete(chatId);
            await reply(sock, msg, "I could not get a word. Please try again.");
            return;
        }

        newGame.word = word.toLowerCase();
        newGame.loading = false;
        log.info("games", `Starting hangman in ${describeGroup(chatId)} with word: ${newGame.word}`);
        armTimer(sock, hangmanGames, chatId, newGame, gameMs(chatId, HANGMAN_GAME_MS), "Time is up, so the hangman game ended.", game => `The word was "${game.word}".`);
        await sendHangman(sock, chatId, newGame, `Hangman. Send a letter to guess, or the whole word. ${HANGMAN_MAX_MISSES} misses and it is over. You have ${formatGameTime(gameMs(chatId, HANGMAN_GAME_MS))}.`);
    } catch (error) {
        if (hangmanGames.get(chatId) === newGame) {
            hangmanGames.delete(chatId);
            clearGameTimers(newGame);
        }
        log.error("games", "Error starting hangman:", error);
        await reply(sock, msg, "Something went wrong starting the hangman game.");
    }
}

async function handleHangmanAnswer(sock, msg, chatId, senderJid, text) {
    const game = hangmanGames.get(chatId);
    if (!game || game.loading) {
        return false;
    }

    const guess = text.trim().toLowerCase();
    if (!/^[a-z]$/.test(guess) && guess !== game.word) {
        return false;
    }

    await hangmanGuess(sock, msg, chatId, senderJid, game, guess);
    return true;
}

const TRIVIA_GAME_MS = 30 * 1000;
const triviaGames = new Map();

async function fetchTriviaQuestion() {
    const response = await fetch("https://opentdb.com/api.php?amount=1&type=multiple&encode=url3986", {
        signal: AbortSignal.timeout(6000),
        headers: { "User-Agent": "khoibot (whatsapp bot)" }
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data.response_code === 5) {
        return "busy";
    }
    const item = data.results?.[0];
    if (!item) {
        throw new Error("no question in the response");
    }

    const decode = value => decodeURIComponent(value);
    const answers = [decode(item.correct_answer), ...item.incorrect_answers.map(decode)];
    for (let index = answers.length - 1; index > 0; index--) {
        const other = randomInt(0, index);
        [answers[index], answers[other]] = [answers[other], answers[index]];
    }
    return {
        question: decode(item.question),
        category: decode(item.category),
        difficulty: decode(item.difficulty),
        answers,
        correct: answers.indexOf(decode(item.correct_answer))
    };
}

const TRIVIA_LETTERS = ["A", "B", "C", "D"];

function triviaText(game) {
    const options = game.answers.map((answer, index) => `${TRIVIA_LETTERS[index]}) ${answer}`);
    return `Trivia (${game.category}, ${game.difficulty})\n${game.question}\n\n${options.join("\n")}`;
}

function triviaAnswerText(game) {
    return `${TRIVIA_LETTERS[game.correct]}) ${game.answers[game.correct]}`;
}

async function handleTrivia(sock, msg, ctx) {
    const { chatId, senderJid, text, trusted, commandPrefix } = ctx;
    if (!await gameAllowed(sock, msg, ctx, "trivia")) {
        return;
    }

    const argument = text.slice("!trivia".length).trim().toLowerCase();
    const game = triviaGames.get(chatId);

    if (argument === "cancel") {
        if (!game) {
            await reply(sock, msg, "There is no trivia question to cancel.");
            return;
        }
        if (!game.loading && !sameWho(senderIds(msg), game.starterIds) && !trusted) {
            await reply(sock, msg, "Only the player who started the question or a trusted user can cancel it.");
            return;
        }
        clearGameTimers(game);
        triviaGames.delete(chatId);
        await reply(sock, msg, game.loading ? "The trivia question was cancelled." : `The trivia question was cancelled. The answer was ${triviaAnswerText(game)}.`);
        return;
    }
    if (argument) {
        await reply(sock, msg, `Usage: ${commandPrefix}trivia [cancel]`);
        return;
    }

    if (game) {
        if (!game.loading) {
            await reply(sock, msg, triviaText(game));
        }
        return;
    }

    if (!await canStartGame(sock, msg, chatId, senderJid)) {
        return;
    }

    const newGame = { loading: true, tried: new Set(), starterIds: senderIds(msg), timeout: null };
    triviaGames.set(chatId, newGame);
    try {
        const question = await fetchTriviaQuestion();
        if (triviaGames.get(chatId) !== newGame) {
            return;
        }
        if (question === "busy") {
            triviaGames.delete(chatId);
            await reply(sock, msg, "Trivia is busy right now. Please try again in a few seconds.");
            return;
        }

        Object.assign(newGame, question, { loading: false });
        log.info("games", `Starting trivia in ${describeGroup(chatId)}: ${question.question} The answer is ${triviaAnswerText(newGame)}`);
        armTimer(sock, triviaGames, chatId, newGame, gameMs(chatId, TRIVIA_GAME_MS), "Time is up, so nobody got it.", game => `The answer was ${triviaAnswerText(game)}.`);
        await reply(sock, msg, `${triviaText(newGame)}\n\nSend A, B, C or D. You have ${formatGameTime(gameMs(chatId, TRIVIA_GAME_MS))}.`);
    } catch (error) {
        if (triviaGames.get(chatId) === newGame) {
            triviaGames.delete(chatId);
            clearGameTimers(newGame);
        }
        log.error("games", "Error starting trivia:", error);
        await reply(sock, msg, "I could not get a trivia question. Please try again later.");
    }
}

async function handleTriviaAnswer(sock, msg, chatId, senderJid, text) {
    const game = triviaGames.get(chatId);
    if (!game || game.loading) {
        return false;
    }

    const pick = text.trim().toUpperCase();
    const index = /^[A-D]$/.test(pick) ? TRIVIA_LETTERS.indexOf(pick) : /^[1-4]$/.test(pick) ? Number(pick) - 1 : -1;
    if (index === -1) {
        return false;
    }
    if (game.tried.has(senderJid)) {
        return true;
    }

    if (index === game.correct) {
        clearGameTimers(game);
        triviaGames.delete(chatId);
        log.info("games", `${describeSender(msg)} got the trivia question in ${describeGroup(chatId)}`);
        await sock.sendMessage(chatId, {
            text: `${tag(senderJid)} got it first. The answer was ${triviaAnswerText(game)}.`,
            mentions: [senderJid]
        });
        return true;
    }

    game.tried.add(senderJid);
    await reply(sock, msg, "Wrong. You are out for this question.");
    return true;
}

// chess keeps its own games, it only borrows the timer and tag helpers from here, plus the saved map so a restart doesnt wipe its games
const chess = chessgame.create({ gameAllowed, canStartGame, armTimer, clearGameTimers, tag, GameMap: SavedMap });

const EXTRA_COMMANDS = {
    "!coin": handleCoin,
    "!roll": handleRoll,
    "!rps": handleRps,
    "!ttt": handleTtt,
    "!connect4": handleConnect4,
    "!chess": chess.handleChess,
    "!numguess": handleNumGuess,
    "!wordle": handleWordle,
    "!anagram": handleAnagram,
    "!hotpotato": handleHotPotato,
    "!pass": handlePass,
    "!blackjack": handleBlackjack,
    "!slots": handleSlots,
    "!wordchain": handleWordChain,
    "!minesweeper": handleMinesweeper,
    "!crossword": handleCrossword,
    "!hangman": handleHangman,
    "!trivia": handleTrivia
};


// ============================================================
// Called from index.js
// ============================================================

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
        if (await handleConnect4Move(sock, chatId, senderJid, text)) return true;
        if (await chess.handleMove(sock, chatId, senderJid, text)) return true;
        if (await handleNumGuessAnswer(sock, msg, chatId, senderJid, text)) return true;
        if (await handleAnagramAnswer(sock, msg, chatId, senderJid, text)) return true;
        if (await handleBlackjackMove(sock, msg, chatId, senderJid, text)) return true;
        if (await handleWordChainAnswer(sock, msg, chatId, senderJid, text)) return true;
        if (await handleHangmanAnswer(sock, msg, chatId, senderJid, text)) return true;
        if (await handleTriviaAnswer(sock, msg, chatId, senderJid, text)) return true;
        if (await handleMinesweeperAnswer(sock, msg, chatId, senderJid, text)) return true;
            if (await handleCrosswordAnswer(sock, msg, chatId, senderJid, text)) return true;
    }

    return false;
}

// Game commands. The original ones are untouched, the extra ones only run
// when ENABLE_EXTRA_GAMES=1.
async function handleCommand(sock, msg, ctx) {
    const timed = /^(!(?:decrypt|math|wordle|anagram|numguess)\b.*?)\s+(\d{1,4})\s*([sm])$/i.exec(ctx.text.trim());
    if (!timed) {
        return handleCommandNow(sock, msg, ctx);
    }

    const seconds = Number(timed[2]) * (timed[3].toLowerCase() === "m" ? 60 : 1);
    if (seconds < GAME_TIME_MIN_SECONDS || seconds > GAME_TIME_MAX_SECONDS) {
        await reply(sock, msg, `The game time has to be between ${GAME_TIME_MIN_SECONDS} seconds and ${GAME_TIME_MAX_SECONDS / 60} minutes.`);
        return true;
    }

    askedGameTime.set(ctx.chatId, seconds * 1000);
    try {
        return await handleCommandNow(sock, msg, { ...ctx, text: timed[1] });
    } finally {
        askedGameTime.delete(ctx.chatId);
    }
}

async function handleCommandNow(sock, msg, { chatId, senderJid, text, isGroup, trusted, commandPrefix }) {
    // The original game commands know nothing about the extra games, so check here.
    if (extraGamesEnabled()) {
        const [name, action] = text.trim().split(/\s+/);
        // a tournament waits for every running game, anything else only waits on the games this person is stuck in
        const extraGame = name === "!tournament" ? activeExtraGame(chatId) : blockingExtraGame(chatId, senderJid);
        if (
            extraGame &&
            ((name === "!decrypt" && action !== "hint") || (name === "!math" && action !== "cancel") || (name === "!tournament" && action === "create"))
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

    if (text === "!math" || text.startsWith("!math ")) {
        if (!isGroup) {
            await reply(sock, msg, "The math game can only be played in a group.");
            return true;
        }

        const wanted = text.trim().split(/\s+/)[1]?.toLowerCase();
        if (wanted === "cancel") {
            const game = activeMathGames.get(chatId);
            if (!game) {
                await reply(sock, msg, "There is no math game to cancel.");
                return true;
            }
            if (game.tournamentRound) {
                await reply(sock, msg, `That math game is part of a tournament, use ${commandPrefix}tournament cancel instead.`);
                return true;
            }
            if (lastMathStart.get(chatId)?.by !== senderJid && !trusted) {
                await reply(sock, msg, "Only whoever started the game or a trusted user can cancel it.");
                return true;
            }

            activeMathGames.delete(chatId);
            await reply(sock, msg, `The math game was cancelled. The answer was ${game.answer}.`);
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

        // !math [easy|medium|hard|impossible|asian], no level means a random one
        if (wanted && !MATH_LEVELS.includes(wanted)) {
            await reply(sock, msg, `Usage: ${commandPrefix}math [${MATH_LEVELS.join("|")}|cancel]`);
            return true;
        }

        const waitMs = (lastMathStart.get(chatId)?.at ?? 0) + mathCooldownMs() - Date.now();
        if (waitMs > 0 && !activeMathGames.has(chatId)) {
            await reply(sock, msg, `please wait, the next math game can start in ${Math.ceil(waitMs / 1000)}s.`);
            return true;
        }

        if (await startMathGame(sock, chatId, null, wanted)) {
            lastMathStart.set(chatId, { at: Date.now(), by: senderJid });
        }
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