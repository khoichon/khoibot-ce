// the bot's side of chess. findMove() is what the game code calls.
// the search runs in a worker thread so a long think doesnt freeze the whole bot,
// and if STOCKFISH_PATH is set in .env it asks stockfish instead and only falls
// back to the built in search when stockfish fails.

const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const { Chess } = require("chess.js");

// depth is how many half moves ahead it looks, ms is the most time it may spend,
// slack means it can pick a move that is a bit worse than the best one so easy is actually easy
const LEVELS = {
    easy: { depth: 1, ms: 500, slack: 150, skill: 1, moveTime: 200 },
    medium: { depth: 2, ms: 2000, slack: 15, skill: 8, moveTime: 600 },
    hard: { depth: 3, ms: 5000, slack: 0, skill: 16, moveTime: 1500 }
};

const VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;


// built in search

// pieces like the middle of the board, so give them a little bonus for being there
function centreBonus(row, col) {
    const dRow = Math.min(row, 7 - row);
    const dCol = Math.min(col, 7 - col);
    return (dRow + dCol) * 4;
}

// score from the point of view of the side to move
function evaluate(chess) {
    let score = 0;
    const board = chess.board();
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const piece = board[row][col];
            if (!piece) {
                continue;
            }
            let value = VALUES[piece.type];
            if (piece.type === "p") {
                // pawns get better the further they walk
                const steps = piece.color === "w" ? 6 - row : row - 1;
                value += steps * 6;
            } else if (piece.type === "n" || piece.type === "b") {
                value += centreBonus(row, col);
            }
            score += piece.color === "w" ? value : -value;
        }
    }
    return chess.turn() === "w" ? score : -score;
}

// captures of big pieces by small pieces first, makes the pruning work wayyyyyyyy better
function orderMoves(moves) {
    return moves
        .map(move => {
            let rank = 0;
            if (move.captured) {
                rank += 10 * VALUES[move.captured] - VALUES[move.piece];
            }
            if (move.promotion) {
                rank += VALUES[move.promotion];
            }
            return { move, rank };
        })
        .sort((a, b) => b.rank - a.rank)
        .map(entry => entry.move);
}

class OutOfTime extends Error {}

function search(state, depth, alpha, beta, ply) {
    if (Date.now() > state.deadline) {
        throw new OutOfTime();
    }
    const chess = state.chess;
    if (chess.isCheckmate()) {
        return -MATE + ply;
    }
    if (chess.isDraw()) {
        return 0;
    }
    if (depth <= 0) {
        return quiet(state, alpha, beta, 0);
    }
    for (const move of orderMoves(chess.moves({ verbose: true }))) {
        chess.move(move);
        const score = -search(state, depth - 1, -beta, -alpha, ply + 1);
        chess.undo();
        if (score >= beta) {
            return beta;
        }
        if (score > alpha) {
            alpha = score;
        }
    }
    return alpha;
}

// at the end of the search keep going while there are captures, otherwise it
// happily walks its queen into a trade it didnt see (lol)
function quiet(state, alpha, beta, depth) {
    const chess = state.chess;
    const standing = evaluate(chess);
    if (standing >= beta) {
        return beta;
    }
    if (standing > alpha) {
        alpha = standing;
    }
    if (depth >= 4) {
        return alpha;
    }
    const captures = chess.moves({ verbose: true }).filter(move => move.captured);
    for (const move of orderMoves(captures)) {
        chess.move(move);
        const score = -quiet(state, -beta, -alpha, depth + 1);
        chess.undo();
        if (score >= beta) {
            return beta;
        }
        if (score > alpha) {
            alpha = score;
        }
    }
    return alpha;
}

// returns a move like "e2e4" (or "e7e8q" for promotions), null if there is nothing to play
function searchMove(fen, levelName) {
    const level = LEVELS[levelName] || LEVELS.medium;
    const chess = new Chess(fen);
    const rootMoves = orderMoves(chess.moves({ verbose: true }));
    if (rootMoves.length === 0) {
        return null;
    }

    const state = { chess, deadline: Date.now() + level.ms };
    let scored = rootMoves.map(move => ({ move, score: 0 }));

    // look one move deeper each time, so if time runs out there is still a result from the last full pass
    for (let depth = 1; depth <= level.depth; depth++) {
        const pass = [];
        try {
            let bestSoFar = -MATE * 2;
            for (const entry of scored) {
                chess.move(entry.move);
                // when slack is 0 only the best move matters, so the moves that cant beat it get cut off fast.
                // with slack every score has to be exact, so those get the full window
                const floor = level.slack === 0 ? bestSoFar : -MATE * 2;
                const score = -search(state, depth - 1, -MATE * 2, -floor, 1);
                chess.undo();
                pass.push({ move: entry.move, score });
                if (score > bestSoFar) {
                    bestSoFar = score;
                }
            }
        } catch (error) {
            if (!(error instanceof OutOfTime)) {
                throw error;
            }
            // the board is in the middle of a line, put it back
            while (chess.history().length > 0) {
                chess.undo();
            }
            break;
        }
        pass.sort((a, b) => b.score - a.score);
        scored = pass;
    }

    const best = scored[0].score;
    const pool = scored.filter(entry => entry.score >= best - level.slack);
    const pick = pool[Math.floor(Math.random() * pool.length)].move;
    return pick.from + pick.to + (pick.promotion || "");
}


// stooooockfish, only used when STOCKFISH_PATH is set


function askStockfish(fen, levelName) {
    const level = LEVELS[levelName] || LEVELS.medium;
    return new Promise((resolve, reject) => {
        const engine = spawn(process.env.STOCKFISH_PATH, [], { stdio: ["pipe", "pipe", "ignore"] });
        let output = "";
        let finished = false;

        const finish = (error, move) => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            engine.kill();
            if (error) {
                reject(error);
            } else {
                resolve(move);
            }
        };
        const timer = setTimeout(() => finish(new Error("stockfish took too long")), level.moveTime + 8000);

        engine.on("error", finish);
        engine.on("exit", () => finish(new Error("stockfish quit before it picked a move")));
        engine.stdout.on("data", chunk => {
            output += chunk;
            const found = /^bestmove (\S+)/m.exec(output);
            if (found) {
                finish(null, found[1] === "(none)" ? null : found[1]);
            }
        });

        engine.stdin.write(
            `uci\nsetoption name Skill Level value ${level.skill}\nisready\n` +
            `position fen ${fen}\ngo movetime ${level.moveTime}\n`
        );
    });
}


// what the game code calls


function searchInWorker(fen, levelName) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData: { fen, level: levelName } });
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error("the chess search took too long"));
        }, 15 * 1000);
        worker.once("message", move => {
            clearTimeout(timer);
            resolve(move);
        });
        worker.once("error", error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function findMove(fen, levelName) {
    if (process.env.STOCKFISH_PATH) {
        try {
            return await askStockfish(fen, levelName);
        } catch (error) {
            // stockfish isnt working, the built in one still can play
            console.error("stockfish failed, using the built in engine:", error.message);
        }
    }
    return searchInWorker(fen, levelName);
}

if (!isMainThread) {
    parentPort.postMessage(searchMove(workerData.fen, workerData.level));
}

module.exports = { findMove, searchMove, LEVELS };
