// !chess, two people in a group or one person against the bot.
// moves are just plain messages like e4, Nf3, O-O or e2e4, same idea as blackjack and tic-tac-toe.
// games.js hands us the little helpers it already has (timers, tags, the one-game-at-a-time check).

const { Chess } = require("chess.js");
const sharp = require("sharp");
const { reply } = require("./utils.js");
const { log } = require("./logging.js");
const { findMove, LEVELS } = require("./chessengine.js");

const LOBBY_MS = 2 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };


// the literal board


const SQUARE = 60;
const MARGIN = 26;
const BOARD_SIZE = SQUARE * 8 + MARGIN * 2;

// the solid glyphs for both colours, the colour comes from the fill.
// the variation selector on the end tells phones to draw it as text and not as an emoji
const GLYPHS = { k: "\u265A", q: "\u265B", r: "\u265C", b: "\u265D", n: "\u265E", p: "\u265F" };
const FONT = "DejaVu Sans, Noto Sans Symbols 2, Symbola, FreeSerif, sans-serif";

function boardSvg(chess, flip, last) {
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${BOARD_SIZE}" height="${BOARD_SIZE}">`);
    parts.push(`<rect width="${BOARD_SIZE}" height="${BOARD_SIZE}" fill="#2b2b2b"/>`);

    const board = chess.board();
    const checked = chess.inCheck() ? chess.turn() : null;

    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            // row 0 is the top of the picture, board[0] is rank 8
            const rank = flip ? row : 7 - row;
            const file = flip ? 7 - col : col;
            const x = MARGIN + col * SQUARE;
            const y = MARGIN + row * SQUARE;
            const name = "abcdefgh"[file] + (rank + 1);

            const dark = (file + rank) % 2 === 0;
            parts.push(`<rect x="${x}" y="${y}" width="${SQUARE}" height="${SQUARE}" fill="${dark ? "#b58863" : "#f0d9b5"}"/>`);

            if (last && (name === last.from || name === last.to)) {
                parts.push(`<rect x="${x}" y="${y}" width="${SQUARE}" height="${SQUARE}" fill="#f7ec5a" fill-opacity="0.55"/>`);
            }

            const piece = board[7 - rank][file];
            if (!piece) {
                continue;
            }
            if (piece.type === "k" && piece.color === checked) {
                parts.push(`<circle cx="${x + SQUARE / 2}" cy="${y + SQUARE / 2}" r="${SQUARE * 0.46}" fill="#e63232" fill-opacity="0.55"/>`);
            }
            const glyph = GLYPHS[piece.type] + "\uFE0E";
            const cx = x + SQUARE / 2;
            const baseline = y + SQUARE * 0.76;
            const white = piece.color === "w";
            // outline first and the fill on top of it, so white pieces still show on light squares
            parts.push(`<text x="${cx}" y="${baseline}" font-family="${FONT}" font-size="48" text-anchor="middle" fill="none" stroke="${white ? "#1a1a1a" : "#f2f2f2"}" stroke-width="${white ? 3 : 1.5}" stroke-linejoin="round">${glyph}</text>`);
            parts.push(`<text x="${cx}" y="${baseline}" font-family="${FONT}" font-size="48" text-anchor="middle" fill="${white ? "#ffffff" : "#161616"}">${glyph}</text>`);
        }
    }

    // a to h along the bottom, 1 to 8 down the side
    for (let i = 0; i < 8; i++) {
        const file = flip ? 7 - i : i;
        const rank = flip ? i : 7 - i;
        const fx = MARGIN + i * SQUARE + SQUARE / 2;
        const ry = MARGIN + i * SQUARE + SQUARE / 2 + 5;
        parts.push(`<text x="${fx}" y="${BOARD_SIZE - 7}" font-family="${FONT}" font-size="15" text-anchor="middle" fill="#cfcfcf">${"abcdefgh"[file]}</text>`);
        parts.push(`<text x="${MARGIN / 2}" y="${ry}" font-family="${FONT}" font-size="15" text-anchor="middle" fill="#cfcfcf">${rank + 1}</text>`);
    }

    parts.push("</svg>");
    return parts.join("");
}

async function renderBoard(chess, flip, last) {
    return sharp(Buffer.from(boardSvg(chess, flip, last))).png().toBuffer();
}

// if the picture cant be made (missing font library or whatever) the board still shows up as text
function textBoard(chess, flip) {
    const rows = [];
    const board = chess.board();
    for (let row = 0; row < 8; row++) {
        const rank = flip ? row : 7 - row;
        const cells = [];
        for (let col = 0; col < 8; col++) {
            const file = flip ? 7 - col : col;
            const piece = board[7 - rank][file];
            if (!piece) {
                cells.push((file + rank) % 2 === 0 ? "\u00B7" : " ");
            } else {
                cells.push(piece.color === "w" ? piece.type.toUpperCase() : piece.type);
            }
        }
        rows.push(`${rank + 1}  ${cells.join(" ")}`);
    }
    const files = flip ? "h g f e d c b a" : "a b c d e f g h";
    return "```\n" + rows.join("\n") + `\n   ${files}\n` + "```";
}


// reading the moves people type


// looks like it could be a chess move, so random chatting never gets treated as one
const SAN_SHAPE = /^(?:[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=?[QRBN])?|O-O(?:-O)?|0-0(?:-0)?)[+#]?[!?]{0,2}$/i;
const COORD_SHAPE = /^([a-h][1-8])\s*-?\s*([a-h][1-8])\s*=?\s*([qrbn])?$/i;

// gives back { kind: "ignore" } when it isnt a move at all, "illegal" when it looks
// like one but doesnt work in this position, or "ok" with the move that got played
function playText(chess, text) {
    const word = text.trim();
    if (word.length < 2 || word.length > 9) {
        return { kind: "ignore" };
    }

    const coords = COORD_SHAPE.exec(word);
    if (coords) {
        try {
            const move = chess.move({
                from: coords[1].toLowerCase(),
                to: coords[2].toLowerCase(),
                promotion: (coords[3] || "q").toLowerCase()
            });
            return { kind: "ok", move };
        } catch (error) {
            return { kind: "illegal" };
        }
    }

    if (!SAN_SHAPE.test(word)) {
        return { kind: "ignore" };
    }

    // people type nf3 or 0-0 or forget to say what the pawn becomes, so try a few spellings
    const clean = word.replace(/[!?]+$/, "").replace(/0/g, "O");
    const tries = [clean];
    tries.push(clean.charAt(0).toUpperCase() + clean.slice(1));
    if (/^[a-h]?x?[a-h][18]$/i.test(clean)) {
        tries.push(clean + "=Q");
    }
    // o-o in lowercase, and promotions written like e8q
    if (/^o-o/i.test(clean)) {
        tries.push(clean.toUpperCase());
    }
    const shortPromo = /^([a-h]?x?[a-h][18])([qrbn])$/i.exec(clean);
    if (shortPromo) {
        tries.push(`${shortPromo[1]}=${shortPromo[2].toUpperCase()}`);
    }
    for (const attempt of tries) {
        try {
            const move = chess.move(attempt);
            return { kind: "ok", move };
        } catch (error) {
            // try the next spelling
        }
    }
    return { kind: "illegal" };
}


// the game itself


function create({ gameAllowed, canStartGame, armTimer, clearGameTimers, tag, GameMap = Map }) {
    const chessGames = new GameMap();

    function isActive(chatId) {
        return chessGames.has(chatId);
    }

    function nameOf(game, side) {
        return game.players[side] ? tag(game.players[side]) : "the bot";
    }

    function colourOf(side) {
        return side === 0 ? "white" : "black";
    }

    // the side that is not the bot, only means something in a game against the bot
    function humanSide(game) {
        return game.players[0] ? 0 : 1;
    }

    function mentionsFor(game, ...sides) {
        return sides.map(side => game.players[side]).filter(Boolean);
    }

    function armIdle(sock, chatId, game, ms = IDLE_MS) {
        // remember when the last move was so a restart can work out how much idle time is left
        game.lastMoveAt = Date.now();
        armTimer(
            sock,
            chessGames,
            chatId,
            game,
            ms,
            "Nobody moved for 10 minutes, so the chess game ended.",
            undefined,
            "idleTimeout"
        );
    }

    async function sendBoard(sock, chatId, game, caption, mentions) {
        // white at the bottom, unless one person is playing the black pieces against the bot
        const flip = game.vsBot && humanSide(game) === 1;
        const last = game.last ? { from: game.last.from, to: game.last.to } : null;
        try {
            const image = await renderBoard(game.chess, flip, last);
            await sock.sendMessage(chatId, { image, caption, mentions });
        } catch (error) {
            log.error("games", "couldnt draw the chess board, sending text instead:", error.message);
            await sock.sendMessage(chatId, {
                text: `${textBoard(game.chess, flip)}\n${caption}`,
                mentions
            });
        }
    }

    function describeEnd(game) {
        const chess = game.chess;
        if (chess.isCheckmate()) {
            // the side to move is the one that got mated
            const loser = chess.turn() === "w" ? 0 : 1;
            return { winner: 1 - loser, text: "Checkmate!" };
        }
        if (chess.isStalemate()) {
            return { winner: null, text: "Stalemate, so it's a draw." };
        }
        if (chess.isInsufficientMaterial()) {
            return { winner: null, text: "Not enough pieces left to checkmate, so it's a draw." };
        }
        if (chess.isThreefoldRepetition()) {
            return { winner: null, text: "The same position came up three times, so it's a draw." };
        }
        if (chess.isDrawByFiftyMoves()) {
            return { winner: null, text: "Fifty moves without a capture or pawn move, so it's a draw." };
        }
        return null;
    }

    async function finishGame(sock, chatId, game, headline, winner) {
        clearGameTimers(game);
        if (chessGames.get(chatId) === game) {
            chessGames.delete(chatId);
        }
        let result = headline;
        if (winner !== null && winner !== undefined) {
            const who = game.players[winner] ? tag(game.players[winner]) : "The bot";
            result += ` ${who} (${colourOf(winner)}) wins.`;
        }
        await sendBoard(sock, chatId, game, result, mentionsFor(game, 0, 1));
    }

    function turnText(game) {
        const side = game.chess.turn() === "w" ? 0 : 1;
        const check = game.chess.inCheck() ? " Check!" : "";
        return `${nameOf(game, side)} to move (${colourOf(side)}).${check}`;
    }

    // the bot works out its move and plays it, then the board goes out with everything that happened
    async function botTurn(sock, chatId, game, humanSan) {
        const side = game.chess.turn() === "w" ? 0 : 1;
        let picked;
        try {
            picked = await findMove(game.chess.fen(), game.level);
        } catch (error) {
            log.error("games", "the chess bot couldnt find a move:", error.message);
            if (chessGames.get(chatId) === game) {
                clearGameTimers(game);
                chessGames.delete(chatId);
            }
            await sock.sendMessage(chatId, { text: "My chess engine broke, so the game ended." });
            return;
        }

        // the game could have been cancelled or timed out while the bot was thinking
        if (chessGames.get(chatId) !== game) {
            return;
        }

        let botMove;
        try {
            botMove = game.chess.move({
                from: picked.slice(0, 2),
                to: picked.slice(2, 4),
                promotion: picked.slice(4, 5) || undefined
            });
        } catch (error) {
            log.error("games", "the chess bot picked a move that doesnt work:", picked);
            clearGameTimers(game);
            chessGames.delete(chatId);
            await sock.sendMessage(chatId, { text: "My chess engine broke, so the game ended." });
            return;
        }
        game.last = botMove;

        const ended = describeEnd(game);
        if (ended) {
            // the human is the other side
            const humanFirst = humanSan ? `You played ${humanSan}, I played ${botMove.san}. ` : `I played ${botMove.san}. `;
            await finishGame(sock, chatId, game, humanFirst + ended.text, ended.winner);
            return;
        }

        armIdle(sock, chatId, game);
        const played = humanSan ? `You played ${humanSan}, I played ${botMove.san}.` : `I opened with ${botMove.san}.`;
        const human = game.players[1 - side];
        await sendBoard(
            sock,
            chatId,
            game,
            `${played}\n${turnText(game)}`,
            human ? [human] : []
        );
    }


    // plain messages, the moves etc etc


    async function handleMove(sock, chatId, senderJid, text) {
        const game = chessGames.get(chatId);
        if (!game || game.status !== "playing") {
            return false;
        }
        const side = game.chess.turn() === "w" ? 0 : 1;
        // when it is the bots turn players[side] is null so nobody matches
        if (!game.players[side] || game.players[side] !== senderJid) {
            return false;
        }

        const attempt = playText(game.chess, text);
        if (attempt.kind === "ignore") {
            return false;
        }
        if (attempt.kind === "illegal") {
            await sock.sendMessage(chatId, {
                text: "That isn't a legal move. If two of your pieces could go there, say which one, like Nbd2 or b1d2."
            });
            return true;
        }

        game.last = attempt.move;
        // any move at all lets an old draw offer lapse
        game.drawOffer = null;

        const ended = describeEnd(game);
        if (ended) {
            await finishGame(sock, chatId, game, `${attempt.move.san}. ${ended.text}`, ended.winner);
            return true;
        }

        armIdle(sock, chatId, game);

        if (game.vsBot) {
            await botTurn(sock, chatId, game, attempt.move.san);
            return true;
        }

        const next = game.chess.turn() === "w" ? 0 : 1;
        await sendBoard(
            sock,
            chatId,
            game,
            `${attempt.move.san}\n${turnText(game)}`,
            mentionsFor(game, next)
        );
        return true;
    }


    // !chess


    async function startBotGame(sock, msg, chatId, senderJid, words) {
        let level = "medium";
        let human = 0;
        for (const word of words) {
            if (Object.hasOwn(LEVELS, word)) {
                level = word;
            } else if (word === "white" || word === "w") {
                human = 0;
            } else if (word === "black" || word === "b") {
                human = 1;
            } else {
                await reply(sock, msg, "Usage: !chess ai [easy|medium|hard] [white|black]");
                return;
            }
        }

        const players = [null, null];
        players[human] = senderJid;
        const game = {
            players,
            vsBot: true,
            level,
            status: "playing",
            chess: new Chess(),
            last: null,
            drawOffer: null,
            timeout: null,
            idleTimeout: null
        };
        chessGames.set(chatId, game);
        armIdle(sock, chatId, game);

        if (human === 1) {
            // the bot is white so it goes first
            await sock.sendMessage(chatId, {
                text: `${tag(senderJid)} is playing the black pieces against me (${level}). I'll start.`,
                mentions: [senderJid]
            });
            await botTurn(sock, chatId, game, null);
            return;
        }

        await sendBoard(
            sock,
            chatId,
            game,
            `${tag(senderJid)} is playing white against me (${level}). Send your move, like e4 or Nf3.`,
            [senderJid]
        );
    }

    async function handleChess(sock, msg, ctx) {
        const { chatId, senderJid, text, trusted, isGroup, commandPrefix } = ctx;
        if (!await gameAllowed(sock, msg, ctx)) {
            return;
        }

        const words = text.trim().split(/\s+/).slice(1).map(word => word.toLowerCase());
        const action = words[0] || "";
        const game = chessGames.get(chatId);
        const playing = game && game.status === "playing";
        const isPlayer = game && game.players.includes(senderJid);

        if (action === "cancel") {
            if (!game) {
                await reply(sock, msg, "There is no chess game to cancel.");
                return;
            }
            if (!isPlayer && !trusted) {
                await reply(sock, msg, "Only a player or a trusted user can cancel the game.");
                return;
            }
            clearGameTimers(game);
            chessGames.delete(chatId);
            await reply(sock, msg, "The chess game was cancelled.");
            return;
        }

        if (action === "resign") {
            if (!playing || !isPlayer) {
                await reply(sock, msg, "You're not in a chess game right now.");
                return;
            }
            const side = game.players[0] === senderJid ? 0 : 1;
            await finishGame(sock, chatId, game, `${nameOf(game, side)} resigned.`, 1 - side);
            return;
        }

        if (action === "draw") {
            if (!playing || !isPlayer) {
                await reply(sock, msg, "You're not in a chess game right now.");
                return;
            }
            const side = game.players[0] === senderJid ? 0 : 1;
            if (game.vsBot) {
                // the bot takes a draw when it isnt ahead in material
                let balance = 0;
                for (const row of game.chess.board()) {
                    for (const piece of row) {
                        if (piece) {
                            balance += (piece.color === "w" ? 1 : -1) * PIECE_VALUES[piece.type];
                        }
                    }
                }
                const botBalance = side === 0 ? -balance : balance;
                if (botBalance <= 0) {
                    await finishGame(sock, chatId, game, "I'll take the draw.", null);
                } else {
                    await reply(sock, msg, "No draw, I'm doing fine. Keep playing or resign.");
                }
                return;
            }
            if (game.drawOffer === side) {
                await reply(sock, msg, "You already offered a draw, wait for your opponent to answer.");
                return;
            }
            if (game.drawOffer === 1 - side) {
                await finishGame(sock, chatId, game, "Draw agreed.", null);
                return;
            }
            game.drawOffer = side;
            await sock.sendMessage(chatId, {
                text: `${nameOf(game, side)} offers a draw. ${nameOf(game, 1 - side)}, send ${commandPrefix}chess draw to accept, or just make your move to decline.`,
                mentions: mentionsFor(game, 0, 1)
            });
            return;
        }

        if (action === "join") {
            if (!isGroup) {
                await reply(sock, msg, `Chess against another person needs a group. Here you can play with me with ${commandPrefix}chess ai.`);
                return;
            }
            if (!game || game.status !== "lobby") {
                await reply(sock, msg, `There is no chess lobby to join. Start one with ${commandPrefix}chess.`);
                return;
            }
            if (game.players[0] === senderJid) {
                await reply(sock, msg, `You can't play against yourself. Wait for someone to join, or play chess with me with ${commandPrefix}chess ai.`);
                return;
            }
            // colours are picked at random so the person who opened the lobby doesnt always get white
            const starter = game.players[0];
            game.players = Math.random() < 0.5 ? [starter, senderJid] : [senderJid, starter];
            game.status = "playing";
            game.chess = new Chess();
            game.last = null;
            game.drawOffer = null;
            clearGameTimers(game);
            armIdle(sock, chatId, game);
            await sendBoard(
                sock,
                chatId,
                game,
                `${nameOf(game, 0)} plays white and ${nameOf(game, 1)} plays black.\n${turnText(game)}\nSend moves like e4, Nf3 or O-O.`,
                mentionsFor(game, 0, 1)
            );
            return;
        }

        if (action === "board") {
            if (!game || game.status !== "playing") {
                await reply(sock, msg, "There is no chess game going on right now.");
                return;
            }
            await sendBoard(sock, chatId, game, turnText(game), mentionsFor(game, game.chess.turn() === "w" ? 0 : 1));
            return;
        }

        if (action === "ai") {
            // somebody with an open lobby can turn it into a game against the bot
            if (game && game.status === "lobby" && game.players[0] === senderJid) {
                clearGameTimers(game);
                chessGames.delete(chatId);
            } else if (!await canStartGame(sock, msg, chatId, senderJid, "chess")) {
                return;
            }
            await startBotGame(sock, msg, chatId, senderJid, words.slice(1));
            return;
        }

        if (action) {
            await reply(sock, msg, `Usage: ${commandPrefix}chess [join | ai [easy|medium|hard] [white|black] | resign | draw | board | cancel]`);
            return;
        }

        // just !chess
        if (game) {
            if (game.status === "lobby") {
                await reply(sock, msg, `Waiting for an opponent. Send ${commandPrefix}chess join to play.`);
            } else {
                await sendBoard(sock, chatId, game, turnText(game), mentionsFor(game, game.chess.turn() === "w" ? 0 : 1));
            }
            return;
        }
        if (!await canStartGame(sock, msg, chatId, senderJid, "chess")) {
            return;
        }
        if (!isGroup) {
            // nobody else is in a dm, so it can only be against the bot
            await startBotGame(sock, msg, chatId, senderJid, []);
            return;
        }
        const lobby = {
            players: [senderJid, null],
            status: "lobby",
            vsBot: false,
            timeout: null,
            idleTimeout: null
        };
        chessGames.set(chatId, lobby);
        armTimer(sock, chessGames, chatId, lobby, LOBBY_MS, "Nobody joined, so the chess lobby closed.");
        await sock.sendMessage(chatId, {
            text: `${tag(senderJid)} wants to play chess. Send ${commandPrefix}chess join to play them, or play the bot yourself with ${commandPrefix}chess ai.`,
            mentions: [senderJid]
        });
    }

    // what gets written to games-state.json. lobbies are left out, they only last 2 minutes anyway
    function snapshot() {
        const out = {};
        for (const [chatId, game] of chessGames) {
            if (game.status !== "playing") {
                continue;
            }
            out[chatId] = {
                players: game.players,
                vsBot: game.vsBot,
                level: game.level,
                // the pgn keeps every move so draws by repetition still work after a restart
                pgn: game.chess.pgn(),
                last: game.last ? { from: game.last.from, to: game.last.to, san: game.last.san } : null,
                drawOffer: game.drawOffer ?? null,
                lastMoveAt: game.lastMoveAt
            };
        }
        return out;
    }

    // brings the saved games back after a restart. one thats been sitting idle for 10 minutes is dropped,
    // same as if its timer had run out while the bot was down
    function restore(sock, saved) {
        let count = 0;
        for (const [chatId, s] of Object.entries(saved || {})) {
            const left = IDLE_MS - (Date.now() - (Number(s.lastMoveAt) || 0));
            if (left <= 0 || !Array.isArray(s.players) || typeof s.pgn !== "string") {
                continue;
            }

            try {
                const chess = new Chess();
                chess.loadPgn(s.pgn);
                const game = {
                    players: s.players,
                    vsBot: Boolean(s.vsBot),
                    level: s.level,
                    status: "playing",
                    chess,
                    last: s.last || null,
                    drawOffer: s.drawOffer ?? null,
                    timeout: null,
                    idleTimeout: null
                };
                chessGames.set(chatId, game);
                armIdle(sock, chatId, game, left);
                game.lastMoveAt = s.lastMoveAt;
                count += 1;

                // the restart might have hit while the bot was thinking, so it still owes a move
                const side = chess.turn() === "w" ? 0 : 1;
                if (game.vsBot && !game.players[side]) {
                    botTurn(sock, chatId, game, game.last ? game.last.san : null).catch(error => {
                        log.error("games", "the chess bot couldnt carry on after the restart:", error.message);
                    });
                }
            } catch (error) {
                log.error("games", "couldnt bring back a saved chess game:", error.message);
            }
        }
        return count;
    }

    // the jids of whoever is in the game here, so the start check knows who is busy
    function playersOf(chatId) {
        return chessGames.get(chatId)?.players.filter(Boolean) ?? [];
    }

    return { handleChess, handleMove, isActive, playersOf, snapshot, restore };
}

module.exports = { create, playText, boardSvg, renderBoard };
