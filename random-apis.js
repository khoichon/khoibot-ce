// If minecraft is creative, this is uhh more creative??
// random and slightly useless APIs for khoibot!!
const {
    setTimeout
} = require('node:timers/promises');

/**
 * Fetches a random cat photo from the Cat API.
 * @param {string} [baseUrl="api.thecatapi.com"] - The base URL of the Cat API (default: "api.thecatapi.com").
 * @param {string} [path="/v1/images/search"] - The API endpoint path (default: "/v1/images/search").
 * @param {"url" | "binary"} [returnType="url"] - The type of data to return ("url" or "binary", default: "url").
 * @returns {Promise<string|Uint8Array>} - A promise that resolves to the cat photo URL or binary data.
 */
function getCatPhoto(baseUrl = "api.thecatapi.com", path = "/v1/images/search", returnType = "url") {
    return fetch(`https://${baseUrl}${path}`)
        .then(response => response.json())
        .then(data => {
            if (returnType === "url") {
                return data[0].url;
            } else if (returnType === "binary") {
                return fetch(data[0].url)
                    .then(res => res.arrayBuffer())
                    .then(buffer => new Uint8Array(buffer));
            } else {
                throw new Error("Invalid returnType specified. Use 'url' or 'binary'.");
            }
        });
}

// The dog API is literally the cat api with api.thedogapi.com instead of api.thecatapi.com, so we can just reuse the function
/**
 * Fetches a random dog photo from the Dog API.
 * @param {string} [baseUrl="api.thedogapi.com"] - The base URL of the Dog API (default: "api.thedogapi.com").
 * @param {string} [path="/v1/images/search"] - The API endpoint path (default: "/v1/images/search").
 * @param {"url" | "binary"} [returnType="url"] - The type of data to return ("url" or "binary", default: "url").
 * @returns {Promise<string|Uint8Array>} - A promise that resolves to the dog photo URL or binary data.
 */
function getDogPhoto(baseUrl = "api.thedogapi.com", path = "/v1/images/search", returnType = "url") {
    return getCatPhoto(baseUrl, path, returnType);
}

// Example usage:
// getCatPhoto().then(url => console.log("Cat photo URL:", url));
// getDogPhoto().then(url => console.log("Dog photo URL:", url));

const MEME_SUBREDDITS = ["wholesomememes", "ProgrammerHumor", "AdviceAnimals", "HistoryMemes", "PrequelMemes", "lotrmemes", "CatMemes", "dogmemes", "mathmemes", "sciencememes"];

/**
 * fetches a random meme from meme-api.com
 * @param {{imagesOnly?: boolean}} [options] imagesOnly skips gifs
 * @returns {Promise<{url: string, title: string, isGif: boolean, subreddit: string}>} the meme url, its title, if its a gif and the subreddit
 */
async function getMeme({ imagesOnly = false } = {}) {
    const allowed = imagesOnly ? /\.(jpe?g|png)$/i : /\.(jpe?g|png|gif)$/i;

    const subreddits = [...MEME_SUBREDDITS].sort(() => Math.random() - 0.5);
    let lastError = null;

    for (const subreddit of subreddits) {
        try {
            const response = await fetch(`https://meme-api.com/gimme/${subreddit}/30`, { signal: AbortSignal.timeout(10000) });

            if (!response.ok) {
                throw new Error(`Meme API returned ${response.status}`);
            }

            const data = await response.json();
            const usable = (data.memes || []).filter(meme =>
                !meme.nsfw && !meme.spoiler && allowed.test(String(meme.url).split("?")[0])
            );

            if (usable.length > 0) {
                const meme = usable[Math.floor(Math.random() * usable.length)];
                return { url: meme.url, title: meme.title, isGif: /\.gif$/i.test(String(meme.url).split("?")[0]), subreddit: meme.subreddit };
            }
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Could not find a usable meme");
}

/**
 * @param {string} url the gif url
 * @returns {Promise<Buffer>} the mp4 file
 */
async function getMemeVideo(url) {
    const { gifToMp4 } = require("./animation.js");
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });

    if (!response.ok) {
        throw new Error(`Meme gif download returned ${response.status}`);
    }

    return gifToMp4(Buffer.from(await response.arrayBuffer()));
}

function calculateEquation(expression) {
    try {
        // tidy the text 
        expression = String(expression)
            .toLowerCase()
            .replace(/\s+/g, "")
            .replace(/π/g, "pi")
            .replace(/×/g, "*")
            .replace(/÷/g, "/")
            .replace(/\*\*/g, "^")
            .replace(/[\[{]/g, "(")
            .replace(/[\]}]/g, ")")
            .replace(/(?<=[0-9)!%])x(?=[0-9.(a-z])/g, "*");

        if (expression.length > 300) {
            throw new Error("Expression is too long");
        }

        const constants = {
            pi: Math.PI,
            e: Math.E,
            tau: Math.PI * 2
        };

        const tidy = (n) => Math.round(n * 1e12) / 1e12;
        const toRad = (d) => (d * Math.PI) / 180;
        const toDeg = (r) => (r * 180) / Math.PI;
        const sind = (d) => tidy(Math.sin(toRad(d)));
        const cosd = (d) => tidy(Math.cos(toRad(d)));

        function factorial(n) {
            if (!Number.isInteger(n) || n < 0) {
                throw new Error("Factorial only works on whole numbers that are 0 or more");
            }
            if (n > 170) {
                throw new Error("That factorial is too big");
            }
            let result = 1;
            for (let i = 2; i <= n; i++) {
                result *= i;
            }
            return result;
        }

        const one = (run) => ({ min: 1, max: 1, run: (args) => run(args[0]) });

        const functions = {
            sqrt: one(Math.sqrt),
            cbrt: one(Math.cbrt),
            abs: one(Math.abs),
            exp: one(Math.exp),
            sin: one(Math.sin),
            cos: one(Math.cos),
            tan: one(Math.tan),
            asin: one(Math.asin),
            acos: one(Math.acos),
            atan: one(Math.atan),
            sinh: one(Math.sinh),
            cosh: one(Math.cosh),
            tanh: one(Math.tanh),
            asinh: one(Math.asinh),
            acosh: one(Math.acosh),
            atanh: one(Math.atanh),
            sind: one(sind),
            cosd: one(cosd),
            tand: one((d) => {
                const c = cosd(d);
                return c === 0 ? Infinity : sind(d) / c;
            }),
            asind: one((x) => tidy(toDeg(Math.asin(x)))),
            acosd: one((x) => tidy(toDeg(Math.acos(x)))),
            atand: one((x) => tidy(toDeg(Math.atan(x)))),
            rad: one(toRad),
            deg: one(toDeg),
            ln: one(Math.log),
            log2: one(Math.log2),
            log10: one(Math.log10),
            log: {
                min: 1,
                max: 2,
                run: ([x, base]) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base))
            },
            floor: one(Math.floor),
            ceil: one(Math.ceil),
            trunc: one(Math.trunc),
            sign: one(Math.sign),
            fact: one(factorial),
            round: {
                min: 1,
                max: 2,
                run: ([x, digits]) => {
                    if (digits === undefined) {
                        return Math.round(x);
                    }
                    if (!Number.isInteger(digits) || digits < 0 || digits > 15) {
                        throw new Error("round wants a whole number of digits from 0 to 15");
                    }
                    const scale = 10 ** digits;
                    return Math.round(x * scale) / scale;
                }
            },
            pow: { min: 2, max: 2, run: ([a, b]) => Math.pow(a, b) },
            atan2: { min: 2, max: 2, run: ([y, x]) => Math.atan2(y, x) },
            min: { min: 1, max: Infinity, run: (args) => Math.min(...args) },
            max: { min: 1, max: Infinity, run: (args) => Math.max(...args) },
            hypot: { min: 1, max: Infinity, run: (args) => Math.hypot(...args) }
        };

        const known = (name) => Object.hasOwn(functions, name) || Object.hasOwn(constants, name);

        let position = 0;

        function peek() {
            return expression[position] ?? "";
        }

        function consume(char) {
            if (expression[position] === char) {
                position++;
                return true;
            }

            return false;
        }

        function parseNumber() {
            const start = position;

            while (/[0-9.]/.test(peek())) {
                position++;
            }

            if (peek() === "e" && /^[+-]?[0-9]/.test(expression.slice(position + 1, position + 3))) {
                position++;
                if (peek() === "+" || peek() === "-") {
                    position++;
                }
                while (/[0-9]/.test(peek())) {
                    position++;
                }
            }

            const value = Number(expression.slice(start, position));

            if (Number.isNaN(value)) {
                throw new Error("Invalid number");
            }

            return value;
        }

        function parseIdentifier() {
            const start = position;

            while (/[a-z]/.test(peek())) {
                position++;
            }

            const letters = expression.slice(start, position);

            let end = position;
            while (/[0-9]/.test(expression[end] ?? "")) {
                end++;
            }
            const withDigits = expression.slice(start, end);
            if (end > position && Object.hasOwn(functions, withDigits)) {
                position = end;
                return withDigits;
            }

            if (!known(letters) && letters.endsWith("mod") && known(letters.slice(0, -3))) {
                position -= 3;
                return letters.slice(0, -3);
            }

            return letters;
        }

        function parsePrimary() {
            // Parentheses
            if (consume("(")) {
                const value = parseAddSub();

                if (!consume(")")) {
                    throw new Error("Missing closing parenthesis");
                }

                return value;
            }

            // Number
            if (/[0-9.]/.test(peek())) {
                return parseNumber();
            }

            // Identifier
            if (/[a-z]/.test(peek())) {
                const name = parseIdentifier();

                // Function
                if (Object.hasOwn(functions, name)) {
                    if (!consume("(")) {
                        throw new Error(`Expected '(' after ${name}`);
                    }

                    const args = [];

                    if (!consume(")")) {
                        do {
                            args.push(parseAddSub());
                        } while (consume(","));

                        if (!consume(")")) {
                            throw new Error(`Missing ')' after ${name}`);
                        }
                    }

                    const { min, max, run } = functions[name];

                    if (args.length < min || args.length > max) {
                        throw new Error(`${name} got the wrong number of arguments`);
                    }

                    return run(args);
                }

                // Constant
                if (Object.hasOwn(constants, name)) {
                    return constants[name];
                }

                throw new Error(`Unknown identifier: ${name}`);
            }

            throw new Error(
                `Unexpected character '${peek() || "end of expression"}'`
            );
        }

        function startsOperand(char) {
            return /[0-9.(a-z]/.test(char ?? "");
        }

        function parsePostfix() {
            let value = parsePrimary();

            while (true) {
                if (consume("!")) {
                    value = factorial(value);
                } else if (peek() === "%" && !startsOperand(expression[position + 1])) {
                    position++;
                    value = value / 100;
                } else {
                    break;
                }
            }

            return value;
        }

        function parsePower() {
            const base = parsePostfix();

            if (consume("^")) {
                return Math.pow(base, parseUnary());
            }

            return base;
        }

        function parseUnary() {
            if (consume("-")) {
                return -parseUnary();
            }

            if (consume("+")) {
                return parseUnary();
            }

            return parsePower();
        }

        function remainder(a, b) {
            if (b === 0) {
                throw new Error("Cannot take a remainder by zero");
            }

            return ((a % b) + b) % b;
        }

        function startsImplicitMultiply() {
            const char = peek();

            if (/[0-9.(]/.test(char)) {
                return true;
            }

            return /[a-z]/.test(char) && !expression.startsWith("mod", position);
        }

        function parseMulDiv() {
            let value = parseUnary();

            while (true) {
                if (consume("*")) {
                    value *= parseUnary();
                } else if (consume("/")) {
                    value /= parseUnary();
                } else if (consume("%")) {
                    value = remainder(value, parseUnary());
                } else if (expression.startsWith("mod", position)) {
                    position += 3;
                    value = remainder(value, parseUnary());
                } else if (startsImplicitMultiply()) {
                    value *= parsePower();
                } else {
                    break;
                }
            }

            return value;
        }

        function parseAddSub() {
            let value = parseMulDiv();

            while (true) {
                if (consume("+")) {
                    value += parseMulDiv();
                } else if (consume("-")) {
                    value -= parseMulDiv();
                } else {
                    break;
                }
            }

            return value;
        }

        if (!expression) {
            throw new Error("Expression is empty");
        }

        let result = parseAddSub();

        if (position !== expression.length) {
            throw new Error(
                `Unexpected character '${expression[position]}' at position ${position}`
            );
        }

        if (!Number.isFinite(result)) {
            throw new Error("Result is not a finite number");
        }

        // stops 0.1+0.2 from showing up as 0.30000000000000004
        if (Math.abs(result) < 1e15) {
            result = Number(result.toPrecision(15));
        }

        return [result, null];

    } catch (error) {
        return [null, error.message];
    }
}

async function sleep(ms) {
  await setTimeout(ms); 
}

module.exports = {
    getCatPhoto,
    getDogPhoto,
    getMeme,
    getMemeVideo,
    calculateEquation,
    sleep
};

