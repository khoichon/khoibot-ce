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

function calculateEquation(expression) {
    try {
        expression = expression
            .replace(/\s+/g, "")
            .replace(/π/g, "pi")
            .toLowerCase();

        const constants = {
            pi: Math.PI,
            e: Math.E
        };

        const functions = {
            sqrt: Math.sqrt,
            cbrt: Math.cbrt,
            abs: Math.abs,
            sin: Math.sin,
            cos: Math.cos,
            tan: Math.tan,
            asin: Math.asin,
            acos: Math.acos,
            atan: Math.atan,
            log: Math.log10,
            ln: Math.log,
            floor: Math.floor,
            ceil: Math.ceil,
            round: Math.round
        };

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

            return expression.slice(start, position);
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

            // Unary operators
            if (consume("+")) {
                return parsePrimary();
            }

            if (consume("-")) {
                return -parsePrimary();
            }

            // Number
            if (/[0-9.]/.test(peek())) {
                return parseNumber();
            }

            // Identifier
            if (/[a-z]/.test(peek())) {
                const name = parseIdentifier();

                // Function
                if (name in functions) {
                    if (!consume("(")) {
                        throw new Error(`Expected '(' after ${name}`);
                    }

                    const value = parseAddSub();

                    if (!consume(")")) {
                        throw new Error(`Missing ')' after ${name}`);
                    }

                    return functions[name](value);
                }

                // Constant
                if (name in constants) {
                    return constants[name];
                }

                throw new Error(`Unknown identifier: ${name}`);
            }

            throw new Error(
                `Unexpected character '${peek() ?? "end of expression"}'`
            );
        }

        function parsePower() {
            const left = parsePrimary();

            if (consume("^")) {
                const right = parsePower();
                return Math.pow(left, right);
            }

            return left;
        }

        function parseMulDiv() {
            let value = parsePower();

            while (true) {
                if (consume("*")) {
                    value *= parsePower();
                } else if (consume("/")) {
                    value /= parsePower();
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

        const result = parseAddSub();

        if (position !== expression.length) {
            throw new Error(
                `Unexpected character '${expression[position]}' at position ${position}`
            );
        }

        if (!Number.isFinite(result)) {
            throw new Error("Result is not a finite number");
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
    calculateEquation,
    sleep
};

