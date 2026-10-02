'use strict';

const sharp = require('sharp');

const DEFAULT_OPTIONS = {
    width: 900,
    height: 700,

    xMin: -10,
    xMax: 10,
    yMin: -10,
    yMax: 10,

    background: '#111318',

    grid: true,
    axes: true,
    labels: true,

    gridColor: '#292d36',
    axisColor: '#c7ccd6',
    textColor: '#dfe4ee',

    lineWidth: 3,

    samples: 1400,
    implicitResolution: 260,

    tMin: -Math.PI * 2,
    tMax: Math.PI * 2,

    thetaMin: 0,
    thetaMax: Math.PI * 2,

    inequalityOpacity: 0.18,

    fontFamily: 'Arial, Helvetica, sans-serif',

    fallbackFillEntireScreen: true
};


// =============================================================================
// UTILITY
// =============================================================================

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function randomColor() {
    return {
        r: Math.floor(Math.random() * 256),
        g: Math.floor(Math.random() * 256),
        b: Math.floor(Math.random() * 256),
        a: 255
    };
}

function colorToCss(c) {
    const a = clamp(c.a / 255, 0, 1);

    if (a >= 0.999) {
        return `rgb(${c.r},${c.g},${c.b})`;
    }

    return `rgba(${c.r},${c.g},${c.b},${a})`;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function splitTopLevel(text, separator = ',') {
    const result = [];

    let start = 0;
    let depth = 0;
    let quote = null;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (quote) {
            if (ch === '\\') {
                i++;
                continue;
            }

            if (ch === quote) {
                quote = null;
            }

            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }

        if ('([{'.includes(ch)) {
            depth++;
            continue;
        }

        if (')]}'.includes(ch)) {
            depth--;
            continue;
        }

        if (ch === separator && depth === 0) {
            result.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }

    const last = text.slice(start).trim();

    if (last) {
        result.push(last);
    }

    return result;
}

function findTopLevelOperator(text, operators) {
    let depth = 0;
    let quote = null;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (quote) {
            if (ch === '\\') {
                i++;
                continue;
            }

            if (ch === quote) {
                quote = null;
            }

            continue;
        }

        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }

        if ('([{'.includes(ch)) {
            depth++;
            continue;
        }

        if (')]}'.includes(ch)) {
            depth--;
            continue;
        }

        if (depth !== 0) {
            continue;
        }

        for (const op of operators) {
            if (text.startsWith(op, i)) {
                return {
                    index: i,
                    operator: op
                };
            }
        }
    }

    return null;
}


// =============================================================================
// TOKENIZER
// =============================================================================

class Tokenizer {
    constructor(input) {
        this.input = input;
        this.index = 0;
    }

    tokenize() {
        const tokens = [];

        while (this.index < this.input.length) {
            const ch = this.input[this.index];

            if (/\s/.test(ch)) {
                this.index++;
                continue;
            }

            if (ch === '"' || ch === "'") {
                tokens.push(this.readString());
                continue;
            }

            if (/[0-9.]/.test(ch)) {
                tokens.push(this.readNumber());
                continue;
            }

            if (/[A-Za-z_]/.test(ch)) {
                tokens.push(this.readIdentifier());
                continue;
            }

            const two = this.input.slice(
                this.index,
                this.index + 2
            );

            if (
                two === '<=' ||
                two === '>=' ||
                two === '!=' ||
                two === '=='
            ) {
                tokens.push({
                    type: 'operator',
                    value: two
                });

                this.index += 2;
                continue;
            }

            if ('+-*/%^!<>=?:(),[]{}'.includes(ch)) {
                tokens.push({
                    type: 'operator',
                    value: ch
                });

                this.index++;
                continue;
            }

            throw new Error(
                `Unexpected character: "${ch}"`
            );
        }

        tokens.push({
            type: 'eof',
            value: ''
        });

        return tokens;
    }

    readNumber() {
        const start = this.index;

        let hasDot = false;
        let hasExponent = false;

        while (this.index < this.input.length) {
            const ch = this.input[this.index];

            if (/[0-9]/.test(ch)) {
                this.index++;
                continue;
            }

            if (ch === '.' && !hasDot) {
                hasDot = true;
                this.index++;
                continue;
            }

            if (
                (ch === 'e' || ch === 'E') &&
                !hasExponent
            ) {
                hasExponent = true;
                this.index++;

                if (
                    this.input[this.index] === '+' ||
                    this.input[this.index] === '-'
                ) {
                    this.index++;
                }

                continue;
            }

            break;
        }

        const raw = this.input.slice(
            start,
            this.index
        );

        const value = Number(raw);

        if (!Number.isFinite(value)) {
            throw new Error(`Invalid number: ${raw}`);
        }

        return {
            type: 'number',
            value
        };
    }

    readIdentifier() {
        const start = this.index;

        this.index++;

        while (
            this.index < this.input.length &&
            /[A-Za-z0-9_]/.test(this.input[this.index])
        ) {
            this.index++;
        }

        return {
            type: 'identifier',
            value: this.input.slice(
                start,
                this.index
            )
        };
    }

    readString() {
        const quote = this.input[this.index];

        this.index++;

        let result = '';

        while (this.index < this.input.length) {
            const ch = this.input[this.index];

            if (ch === '\\') {
                const next =
                    this.input[this.index + 1];

                if (next === 'n') {
                    result += '\n';
                } else if (next === 't') {
                    result += '\t';
                } else if (next === 'r') {
                    result += '\r';
                } else {
                    result += next;
                }

                this.index += 2;
                continue;
            }

            if (ch === quote) {
                this.index++;

                return {
                    type: 'string',
                    value: result
                };
            }

            result += ch;
            this.index++;
        }

        throw new Error(
            'Unterminated string literal'
        );
    }
}


// =============================================================================
// ENVIRONMENT
// =============================================================================

class Environment {
    constructor(parent = null) {
        this.parent = parent;
        this.variables = new Map();
        this.functions = new Map();
    }

    getVariable(name) {
        if (this.variables.has(name)) {
            return this.variables.get(name);
        }

        if (this.parent) {
            return this.parent.getVariable(name);
        }

        throw new Error(
            `Unknown variable: ${name}`
        );
    }

    hasVariable(name) {
        return (
            this.variables.has(name) ||
            (
                this.parent &&
                this.parent.hasVariable(name)
            )
        );
    }

    setVariable(name, value) {
        this.variables.set(name, value);
    }

    setFunction(name, args, body) {
        this.functions.set(name, {
            args,
            body
        });
    }

    getFunction(name) {
        if (this.functions.has(name)) {
            return this.functions.get(name);
        }

        if (this.parent) {
            return this.parent.getFunction(name);
        }

        return null;
    }
}


// =============================================================================
// BUILT-INS
// =============================================================================

function factorial(n) {
    if (!Number.isFinite(n)) return NaN;

    n = Math.round(n);

    if (n < 0 || n > 170) return NaN;

    let result = 1;

    for (let i = 2; i <= n; i++) {
        result *= i;
    }

    return result;
}

function gcd(a, b) {
    a = Math.abs(Math.trunc(a));
    b = Math.abs(Math.trunc(b));

    while (b !== 0) {
        [a, b] = [b, a % b];
    }

    return a;
}

function lcm(a, b) {
    if (a === 0 || b === 0) return 0;

    return Math.abs(a * b) / gcd(a, b);
}

function choose(n, k) {
    n = Math.round(n);
    k = Math.round(k);

    if (k < 0 || n < 0 || k > n) {
        return NaN;
    }

    k = Math.min(k, n - k);

    let result = 1;

    for (let i = 1; i <= k; i++) {
        result *= (n - k + i) / i;
    }

    return result;
}

function permute(n, k) {
    n = Math.round(n);
    k = Math.round(k);

    if (k < 0 || n < 0 || k > n) {
        return NaN;
    }

    let result = 1;

    for (let i = 0; i < k; i++) {
        result *= n - i;
    }

    return result;
}

const BUILTINS = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,

    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,

    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,

    asinh: Math.asinh,
    acosh: Math.acosh,
    atanh: Math.atanh,

    sec: x => 1 / Math.cos(x),
    csc: x => 1 / Math.sin(x),
    cot: x => 1 / Math.tan(x),

    sech: x => 1 / Math.cosh(x),
    csch: x => 1 / Math.sinh(x),
    coth: x => 1 / Math.tanh(x),

    sqrt: Math.sqrt,
    cbrt: Math.cbrt,

    abs: Math.abs,
    sign: Math.sign,

    exp: Math.exp,

    ln: Math.log,
    log: Math.log10,

    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    trunc: Math.trunc,

    min: Math.min,
    max: Math.max,

    pow: Math.pow,
    hypot: Math.hypot,
    atan2: Math.atan2,

    radians: x => x * Math.PI / 180,
    degrees: x => x * 180 / Math.PI,

    fact: factorial,
    factorial,

    gcd,
    lcm,

    choose,
    nCr: choose,

    permute,
    nPr: permute,

    random: Math.random,

    clamp
};

const CONSTANTS = {
    pi: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
    phi: (1 + Math.sqrt(5)) / 2
};


// =============================================================================
// PARSER
// =============================================================================

class Parser {
    constructor(input) {
        this.input = input;
        this.tokens =
            new Tokenizer(input).tokenize();

        this.index = 0;
    }

    current() {
        return this.tokens[this.index];
    }

    consume(value = null) {
        const token = this.current();

        if (
            value !== null &&
            token.value !== value
        ) {
            throw new Error(
                `Expected "${value}", got "${token.value}"`
            );
        }

        this.index++;

        return token;
    }

    parse() {
        const result =
            this.parseConditional();

        if (
            this.current().type !== 'eof'
        ) {
            throw new Error(
                `Unexpected token "${this.current().value}"`
            );
        }

        return result;
    }

    parseConditional() {
        let condition =
            this.parseComparison();

        if (this.current().value === '?') {
            this.consume('?');

            const whenTrue =
                this.parseConditional();

            this.consume(':');

            const whenFalse =
                this.parseConditional();

            return {
                type: 'conditional',
                condition,
                whenTrue,
                whenFalse
            };
        }

        return condition;
    }

    parseComparison() {
        let left =
            this.parseAdditive();

        while (
            [
                '=',
                '==',
                '!=',
                '<',
                '>',
                '<=',
                '>='
            ].includes(this.current().value)
        ) {
            const operator =
                this.consume().value;

            const right =
                this.parseAdditive();

            left = {
                type: 'binary',
                operator,
                left,
                right
            };
        }

        return left;
    }

    parseAdditive() {
        let left =
            this.parseMultiplicative();

        while (
            this.current().value === '+' ||
            this.current().value === '-'
        ) {
            const operator =
                this.consume().value;

            const right =
                this.parseMultiplicative();

            left = {
                type: 'binary',
                operator,
                left,
                right
            };
        }

        return left;
    }

    parseMultiplicative() {
        let left =
            this.parsePower();

        while (
            this.current().value === '*' ||
            this.current().value === '/' ||
            this.current().value === '%'
        ) {
            const operator =
                this.consume().value;

            const right =
                this.parsePower();

            left = {
                type: 'binary',
                operator,
                left,
                right
            };
        }

        while (this.canStartImplicitMultiplication()) {
            const right =
                this.parsePower();

            left = {
                type: 'binary',
                operator: '*',
                left,
                right
            };
        }

        return left;
    }

    canStartImplicitMultiplication() {
        const token =
            this.current();

        return (
            token.type === 'number' ||
            token.type === 'identifier' ||
            token.value === '(' ||
            token.value === '['
        );
    }

    parsePower() {
        let left =
            this.parseUnary();

        if (this.current().value === '^') {
            this.consume('^');

            const right =
                this.parsePower();

            left = {
                type: 'binary',
                operator: '^',
                left,
                right
            };
        }

        return left;
    }

    parseUnary() {
        if (
            this.current().value === '+' ||
            this.current().value === '-'
        ) {
            const operator =
                this.consume().value;

            return {
                type: 'unary',
                operator,
                value: this.parseUnary()
            };
        }

        let node =
            this.parsePrimary();

        while (this.current().value === '!') {
            this.consume('!');

            node = {
                type: 'factorial',
                value: node
            };
        }

        return node;
    }

    parsePrimary() {
        const token =
            this.current();

        if (token.type === 'number') {
            this.consume();

            return {
                type: 'number',
                value: token.value
            };
        }

        if (token.type === 'string') {
            this.consume();

            return {
                type: 'string',
                value: token.value
            };
        }

        if (token.type === 'identifier') {
            this.consume();

            const name = token.value;

            if (this.current().value === '(') {
                this.consume('(');

                const args = [];

                if (
                    this.current().value !== ')'
                ) {
                    while (true) {
                        args.push(
                            this.parseConditional()
                        );

                        if (
                            this.current().value !== ','
                        ) {
                            break;
                        }

                        this.consume(',');
                    }
                }

                this.consume(')');

                return {
                    type: 'call',
                    name,
                    args
                };
            }

            return {
                type: 'variable',
                name
            };
        }

        if (token.value === '(') {
            this.consume('(');

            const first =
                this.parseConditional();

            if (this.current().value === ',') {
                const values = [first];

                while (
                    this.current().value === ','
                ) {
                    this.consume(',');

                    values.push(
                        this.parseConditional()
                    );
                }

                this.consume(')');

                return {
                    type: 'tuple',
                    values
                };
            }

            this.consume(')');

            return first;
        }

        if (token.value === '[') {
            this.consume('[');

            const values = [];

            if (
                this.current().value !== ']'
            ) {
                while (true) {
                    values.push(
                        this.parseConditional()
                    );

                    if (
                        this.current().value !== ','
                    ) {
                        break;
                    }

                    this.consume(',');
                }
            }

            this.consume(']');

            return {
                type: 'list',
                values
            };
        }

        throw new Error(
            `Unexpected token "${token.value}"`
        );
    }
}

function parseExpression(input) {
    return new Parser(input).parse();
}

// =============================================================================
// EVALUATOR
// =============================================================================

function evaluate(node, env) {
    switch (node.type) {
        case 'number':
            return node.value;

        case 'string':
            return node.value;

        case 'variable': {
            const name = node.name;

            if (
                Object.prototype.hasOwnProperty.call(
                    CONSTANTS,
                    name
                )
            ) {
                return CONSTANTS[name];
            }

            if (env.hasVariable(name)) {
                return env.getVariable(name);
            }

            if (name === 'true') return 1;
            if (name === 'false') return 0;

            throw new Error(
                `Unknown variable: ${name}`
            );
        }

        case 'list':
            return node.values.map(
                value => evaluate(value, env)
            );

        case 'tuple':
            return node.values.map(
                value => evaluate(value, env)
            );

        case 'unary': {
            const value =
                evaluate(node.value, env);

            if (node.operator === '+') {
                return +value;
            }

            if (node.operator === '-') {
                return -value;
            }

            throw new Error(
                `Unknown unary operator: ${node.operator}`
            );
        }

        case 'factorial':
            return factorial(
                evaluate(node.value, env)
            );

        case 'conditional':
            return evaluate(
                evaluate(node.condition, env)
                    ? node.whenTrue
                    : node.whenFalse,
                env
            );

        case 'binary': {
            const a =
                evaluate(node.left, env);

            const b =
                evaluate(node.right, env);

            switch (node.operator) {
                case '+':
                    return a + b;

                case '-':
                    return a - b;

                case '*':
                    return a * b;

                case '/':
                    return a / b;

                case '%':
                    return a % b;

                case '^':
                    return Math.pow(a, b);

                case '=':
                case '==':
                    return Math.abs(a - b) < 1e-9
                        ? 1
                        : 0;

                case '!=':
                    return Math.abs(a - b) >= 1e-9
                        ? 1
                        : 0;

                case '<':
                    return a < b ? 1 : 0;

                case '>':
                    return a > b ? 1 : 0;

                case '<=':
                    return a <= b ? 1 : 0;

                case '>=':
                    return a >= b ? 1 : 0;

                default:
                    throw new Error(
                        `Unknown operator: ${node.operator}`
                    );
            }
        }

        case 'call': {
            const builtin =
                BUILTINS[node.name];

            const args =
                node.args.map(
                    arg => evaluate(arg, env)
                );

            if (builtin) {
                return builtin(...args);
            }

            const fn =
                env.getFunction(node.name);

            if (!fn) {
                throw new Error(
                    `Unknown function: ${node.name}`
                );
            }

            if (
                fn.args.length !== args.length
            ) {
                throw new Error(
                    `${node.name} expected ` +
                    `${fn.args.length} arguments`
                );
            }

            const child =
                new Environment(env);

            for (let i = 0; i < fn.args.length; i++) {
                child.setVariable(
                    fn.args[i],
                    args[i]
                );
            }

            return evaluate(fn.body, child);
        }

        default:
            throw new Error(
                `Unknown AST node: ${node.type}`
            );
    }
}


// =============================================================================
// COLOR / FILL SUFFIXES
// =============================================================================

function parseColorArgs(raw) {
    const values =
        raw
            .split(',')
            .map(v => Number(v.trim()));

    if (
        values.length !== 4 ||
        values.some(
            v => !Number.isFinite(v)
        )
    ) {
        throw new Error(
            `Invalid color: ${raw}`
        );
    }

    return {
        r: clamp(
            Math.round(values[0]),
            0,
            255
        ),
        g: clamp(
            Math.round(values[1]),
            0,
            255
        ),
        b: clamp(
            Math.round(values[2]),
            0,
            255
        ),
        a: clamp(
            Math.round(values[3]),
            0,
            255
        )
    };
}

function parseRenderModifiers(input) {
    let expression =
        input.trim();

    let color = null;
    let fill = null;

    /*
     * Keep consuming modifiers from the RIGHT SIDE.
     *
     * This means:
     *
     *   expr+col(...)+fill(...)
     *
     * and:
     *
     *   expr+fill(...)+col(...)
     *
     * both work.
     *
     * But:
     *
     *   expr+col(...)+5
     *
     * does not.
     */
    while (true) {
        const match =
            expression.match(
                /\+([A-Za-z]+)\(\s*([^()]*)\s*\)\s*$/
            );

        if (!match) {
            break;
        }

        const name = match[1];
        const args = match[2];

        if (
            name !== 'col' &&
            name !== 'fill'
        ) {
            break;
        }

        if (name === 'col') {
            color =
                parseColorArgs(args);
        } else {
            fill =
                parseColorArgs(args);
        }

        expression =
            expression
                .slice(0, match.index)
                .trim();
    }

    if (!color) {
        color = randomColor();
    }

    return {
        expression,
        color,
        fill
    };
}


// =============================================================================
// RELATIONS / ASSIGNMENTS
// =============================================================================

function splitDomain(text) {
    const trimmed =
        text.trim();

    if (!trimmed.endsWith('}')) {
        return {
            expression: trimmed,
            domain: null
        };
    }

    let depth = 0;

    for (
        let i = trimmed.length - 1;
        i >= 0;
        i--
    ) {
        const ch = trimmed[i];

        if (ch === '}') {
            depth++;
        } else if (ch === '{') {
            depth--;

            if (depth === 0) {
                return {
                    expression:
                        trimmed.slice(0, i).trim(),
                    domain:
                        trimmed.slice(i + 1, -1).trim()
                };
            }
        }
    }

    return {
        expression: trimmed,
        domain: null
    };
}

function parseRelation(text) {
    const found =
        findTopLevelOperator(
            text,
            [
                '<=',
                '>=',
                '!=',
                '==',
                '=',
                '<',
                '>'
            ]
        );

    if (!found) {
        return null;
    }

    const left =
        text.slice(
            0,
            found.index
        ).trim();

    const right =
        text.slice(
            found.index +
            found.operator.length
        ).trim();

    if (!left || !right) {
        return null;
    }

    return {
        left,
        right,
        operator: found.operator
    };
}

function parseAssignment(text) {
    const relation =
        parseRelation(text);

    if (!relation) {
        return null;
    }

    if (
        relation.operator !== '=' &&
        relation.operator !== '=='
    ) {
        return null;
    }

    const fnMatch =
        relation.left.match(
            /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)$/
        );

    if (fnMatch) {
        const name = fnMatch[1];

        const args =
            fnMatch[2]
                .split(',')
                .map(v => v.trim())
                .filter(Boolean);

        if (
            args.every(
                v =>
                    /^[A-Za-z_][A-Za-z0-9_]*$/.test(v)
            )
        ) {
            return {
                type: 'function',
                name,
                args,
                body: relation.right
            };
        }
    }

    /*
     * x, y, r, theta and t are deliberately excluded
     * because these are useful graphing equations.
     */
    if (
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(
            relation.left
        ) &&
        ![
            'x',
            'y',
            'r',
            'theta',
            't'
        ].includes(relation.left)
    ) {
        return {
            type: 'variable',
            name: relation.left,
            body: relation.right
        };
    }

    return null;
}


// =============================================================================
// SVG RENDERER
// =============================================================================

class SVGRenderer {
    constructor(options) {
        this.options = options;

        this.width = options.width;
        this.height = options.height;

        this.elements = [];
    }

    sx(x) {
        return (
            (x - this.options.xMin) /
            (this.options.xMax - this.options.xMin)
        ) * this.width;
    }

    sy(y) {
        return (
            1 -
            (
                (y - this.options.yMin) /
                (this.options.yMax - this.options.yMin)
            )
        ) * this.height;
    }

    graphPoint(x, y) {
        return [
            this.sx(x),
            this.sy(y)
        ];
    }

    line(
        x1,
        y1,
        x2,
        y2,
        color,
        width = this.options.lineWidth
    ) {
        const [px1, py1] =
            this.graphPoint(x1, y1);

        const [px2, py2] =
            this.graphPoint(x2, y2);

        this.elements.push(
            `<line ` +
            `x1="${px1}" y1="${py1}" ` +
            `x2="${px2}" y2="${py2}" ` +
            `stroke="${colorToCss(color)}" ` +
            `stroke-width="${width}" ` +
            `stroke-linecap="round"/>`
        );
    }

    polyline(
        points,
        color,
        width = this.options.lineWidth
    ) {
        if (points.length < 2) {
            return;
        }

        const d =
            points
                .map((p, i) => {
                    const [x, y] =
                        this.graphPoint(
                            p[0],
                            p[1]
                        );

                    return `${
                        i === 0 ? 'M' : 'L'
                    } ${x} ${y}`;
                })
                .join(' ');

        this.elements.push(
            `<path d="${d}" ` +
            `fill="none" ` +
            `stroke="${colorToCss(color)}" ` +
            `stroke-width="${width}" ` +
            `stroke-linecap="round" ` +
            `stroke-linejoin="round"/>`
        );
    }

    polygon(points, color) {
        if (points.length < 3) {
            return;
        }

        const value =
            points
                .map(p => {
                    const [x, y] =
                        this.graphPoint(
                            p[0],
                            p[1]
                        );

                    return `${x},${y}`;
                })
                .join(' ');

        this.elements.push(
            `<polygon ` +
            `points="${value}" ` +
            `fill="${colorToCss(color)}" ` +
            `stroke="none"/>`
        );
    }

    fullScreenFill(color) {
        this.elements.push(
            `<rect x="0" y="0" ` +
            `width="${this.width}" ` +
            `height="${this.height}" ` +
            `fill="${colorToCss(color)}"/>`
        );
    }

    text(
        x,
        y,
        value,
        size,
        color
    ) {
        const [px, py] =
            this.graphPoint(x, y);

        this.elements.push(
            `<text ` +
            `x="${px}" y="${py}" ` +
            `font-family="${escapeXml(
                this.options.fontFamily
            )}" ` +
            `font-size="${size * 20}px" ` +
            `fill="${colorToCss(color)}" ` +
            `text-anchor="middle" ` +
            `dominant-baseline="middle">` +
            `${escapeXml(value)}` +
            `</text>`
        );
    }

    render() {
        return `
<svg
    xmlns="http://www.w3.org/2000/svg"
    width="${this.width}"
    height="${this.height}"
    viewBox="0 0 ${this.width} ${this.height}"
>
    <rect
        x="0"
        y="0"
        width="${this.width}"
        height="${this.height}"
        fill="${escapeXml(this.options.background)}"
    />

    ${this.elements.join('\n')}
</svg>
`;
    }
}


// =============================================================================
// HELP
// =============================================================================

const HELP_SECTIONS = [
    {
        title: 'BASIC GRAPHING',
        lines: [
            'y=x^2',
            'x^2+y^2=25',
            'x=3',
            'x^2'
        ]
    },

    {
        title: 'MULTIPLE EXPRESSIONS',
        lines: [
            'y=x^2, y=-x^2, x=2',
            'Expressions are rendered BACK → FRONT.'
        ]
    },

    {
        title: 'VARIABLES',
        lines: [
            'a=3',
            'b=5',
            'y=a*x+b'
        ]
    },

    {
        title: 'FUNCTIONS',
        lines: [
            'f(x)=sin(x)',
            'y=f(x)',
            'g(x,y)=x^2+y^2'
        ]
    },

    {
        title: 'IMPLICIT EQUATIONS',
        lines: [
            'x^2+y^2=25',
            '(x^2+y^2-1)^3-x^2*y^3=0'
        ]
    },

    {
        title: 'INEQUALITIES',
        lines: [
            'y>x^2',
            'x^2+y^2<25',
            'x^2+y^2>=4'
        ]
    },

    {
        title: 'PARAMETRIC',
        lines: [
            '(cos(t),sin(t))',
            '(t,t^2)'
        ]
    },

    {
        title: 'POLAR',
        lines: [
            'r=2sin(theta)',
            'r=1+cos(theta)'
        ]
    },

    {
        title: 'DOMAINS',
        lines: [
            'y=x^2{-5<x<5}',
            'y=sin(x){0<x<pi}',
            '(cos(t),sin(t)){0<t<pi}'
        ]
    },

    {
        title: 'TEXT',
        lines: [
            'text("TEST TEXT",0,-4,0.8)',
            'text("Hello!",2,3,1)'
        ]
    },

    {
        title: 'COLORS',
        lines: [
            'y=x^2 +col(255,0,0,255)',
            'col(r,g,b,a)'
        ]
    },

    {
        title: 'FILL',
        lines: [
            'x^2+y^2=25 +fill(50,150,255,100)',
            'fill(r,g,b,a)'
        ]
    },

    {
        title: 'COLOR + FILL',
        lines: [
            'x^2+y^2=25 +col(255,0,0,255)+fill(255,0,0,80)',
            'The two modifiers can be in either order.'
        ]
    },

    {
        title: 'MODIFIER RULE',
        lines: [
            '+col(...) and +fill(...) MUST be at the end.',
            'No col → random color.',
            'No fill → no fill.',
            'Invalid/non-closed fill → entire graph is filled.'
        ]
    },

    {
        title: 'RENDER ORDER',
        lines: [
            'Expressions are rendered in the order given.',
            'First expression = BACK.',
            'Last expression = FRONT.',
            '',
            'circle, heart, text("HELLO!",0,0,1)'
        ]
    },

    {
        title: 'MATH FUNCTIONS',
        lines: [
            'sin cos tan',
            'asin acos atan',
            'sinh cosh tanh',
            'sqrt cbrt abs sign',
            'ln log exp',
            'floor ceil round trunc',
            'min max pow hypot atan2',
            'gcd lcm choose nCr permute nPr',
            'radians degrees'
        ]
    },

    {
        title: 'CONSTANTS',
        lines: [
            'pi',
            'e',
            'tau',
            'phi'
        ]
    },

    {
        title: 'EXAMPLES',
        lines: [
            'Heart:',
            '(x^2+y^2-1)^3-x^2*y^3=0',
            '',
            'Heart + color + fill:',
            '(x^2+y^2-1)^3-x^2*y^3=0 +col(255,50,100,255)+fill(255,50,100,90)',
            '',
            'Heart + encouragement:',
            '(x^2+y^2-1)^3-x^2*y^3=0,text("YOU GOT THIS!",0,-4,0.8)'
        ]
    }
];

function createHelpSvg(options) {
    const width = options.width;

    const lineHeight = 24;
    const sectionGap = 18;

    const left = 45;
    const top = 55;

    const titleSize = 30;
    const sectionSize = 17;
    const bodySize = 14;

    let y = top;

    const elements = [];

    elements.push(
        `<rect x="0" y="0" width="${width}" height="100%" fill="${options.background}"/>`
    );

    elements.push(
        `<text
            x="${left}"
            y="${y}"
            font-family="${escapeXml(options.fontFamily)}"
            font-size="${titleSize}px"
            font-weight="bold"
            fill="${options.textColor}"
        >MATHPLOTS HELP</text>`
    );

    y += 42;

    for (const section of HELP_SECTIONS) {
        elements.push(
            `<text
                x="${left}"
                y="${y}"
                font-family="${escapeXml(options.fontFamily)}"
                font-size="${sectionSize}px"
                font-weight="bold"
                fill="rgb(120,180,255)"
            >${escapeXml(section.title)}</text>`
        );

        y += 25;

        for (const line of section.lines) {
            if (line === '') {
                y += 10;
                continue;
            }

            const safe =
                escapeXml(line);

            /*
             * Long lines are rendered smaller so the help
             * remains useful on a single image.
             */
            const fontSize =
                line.length > 85
                    ? 11
                    : bodySize;

            elements.push(
                `<text
                    x="${left + 8}"
                    y="${y}"
                    font-family="${escapeXml(options.fontFamily)}"
                    font-size="${fontSize}px"
                    fill="${options.textColor}"
                >${safe}</text>`
            );

            y += lineHeight;
        }

        y += sectionGap;
    }

    const height =
        Math.max(
            options.height,
            y + 35
        );

    /*
     * Fix the temporary 100% rectangle now that
     * the final height is known.
     */
    elements[0] =
        `<rect x="0" y="0" width="${width}" height="${height}" fill="${options.background}"/>`;

    return {
        svg: `
<svg
    xmlns="http://www.w3.org/2000/svg"
    width="${width}"
    height="${height}"
    viewBox="0 0 ${width} ${height}"
>
    ${elements.join('\n')}
</svg>
`,
        width,
        height
    };
}

async function renderHelp(options) {
    const {
        svg,
        width,
        height
    } = createHelpSvg(options);

    return sharp(
        Buffer.from(svg)
    )
        .png()
        .toBuffer();
}


// =============================================================================
// SAMPLING
// =============================================================================

function sampleFunction(
    fn,
    options,
    axis = 'x'
) {
    const points = [];

    const count =
        options.samples;

    const min =
        axis === 'x'
            ? options.xMin
            : options.yMin;

    const max =
        axis === 'x'
            ? options.xMax
            : options.yMax;

    let previous = null;

    for (let i = 0; i <= count; i++) {
        const value =
            min +
            (max - min) * i / count;

        let result;

        try {
            result = fn(value);
        } catch {
            result = NaN;
        }

        if (!Number.isFinite(result)) {
            previous = null;
            continue;
        }

        const point =
            axis === 'x'
                ? [value, result]
                : [result, value];

        if (previous) {
            const jump =
                Math.abs(
                    point[1] - previous[1]
                ) +
                Math.abs(
                    point[0] - previous[0]
                );

            const maxJump =
                Math.max(
                    options.xMax -
                        options.xMin,
                    options.yMax -
                        options.yMin
                ) * 2;

            if (jump > maxJump) {
                previous = point;
                continue;
            }
        }

        points.push(point);
        previous = point;
    }

    return points;
}


// =============================================================================
// MARCHING SQUARES
// =============================================================================

function interpolatePoint(
    x1,
    y1,
    v1,
    x2,
    y2,
    v2
) {
    if (
        !Number.isFinite(v1) ||
        !Number.isFinite(v2)
    ) {
        return [
            (x1 + x2) / 2,
            (y1 + y2) / 2
        ];
    }

    if (v1 === v2) {
        return [
            (x1 + x2) / 2,
            (y1 + y2) / 2
        ];
    }

    const t =
        (0 - v1) /
        (v2 - v1);

    return [
        x1 + (x2 - x1) * t,
        y1 + (y2 - y1) * t
    ];
}

function marchingSquares(fn, options) {
    const resolution =
        options.implicitResolution;

    const xStep =
        (options.xMax - options.xMin) /
        resolution;

    const yStep =
        (options.yMax - options.yMin) /
        resolution;

    const segments = [];

    for (
        let iy = 0;
        iy < resolution;
        iy++
    ) {
        const y0 =
            options.yMin +
            iy * yStep;

        const y1 =
            y0 + yStep;

        for (
            let ix = 0;
            ix < resolution;
            ix++
        ) {
            const x0 =
                options.xMin +
                ix * xStep;

            const x1 =
                x0 + xStep;

            let a;
            let b;
            let c;
            let d;

            try {
                a = fn(x0, y0);
                b = fn(x1, y0);
                c = fn(x1, y1);
                d = fn(x0, y1);
            } catch {
                continue;
            }

            if (
                ![
                    a,
                    b,
                    c,
                    d
                ].every(
                    Number.isFinite
                )
            ) {
                continue;
            }

            const edges = [];

            if ((a < 0) !== (b < 0)) {
                edges.push(
                    interpolatePoint(
                        x0,
                        y0,
                        a,
                        x1,
                        y0,
                        b
                    )
                );
            }

            if ((b < 0) !== (c < 0)) {
                edges.push(
                    interpolatePoint(
                        x1,
                        y0,
                        b,
                        x1,
                        y1,
                        c
                    )
                );
            }

            if ((c < 0) !== (d < 0)) {
                edges.push(
                    interpolatePoint(
                        x1,
                        y1,
                        c,
                        x0,
                        y1,
                        d
                    )
                );
            }

            if ((d < 0) !== (a < 0)) {
                edges.push(
                    interpolatePoint(
                        x0,
                        y1,
                        d,
                        x0,
                        y0,
                        a
                    )
                );
            }

            if (edges.length === 2) {
                segments.push([
                    edges[0],
                    edges[1]
                ]);
            } else if (edges.length === 4) {
                segments.push([
                    edges[0],
                    edges[1]
                ]);

                segments.push([
                    edges[2],
                    edges[3]
                ]);
            }
        }
    }

    return segments;
}

function pointKey(point) {
    return (
        `${Math.round(point[0] * 100000)},` +
        `${Math.round(point[1] * 100000)}`
    );
}

function connectSegments(segments) {
    const adjacency = new Map();

    function add(key, index) {
        if (!adjacency.has(key)) {
            adjacency.set(key, []);
        }

        adjacency
            .get(key)
            .push(index);
    }

    segments.forEach(
        (segment, index) => {
            add(
                pointKey(segment[0]),
                index
            );

            add(
                pointKey(segment[1]),
                index
            );
        }
    );

    const used = new Set();
    const lines = [];

    for (
        let i = 0;
        i < segments.length;
        i++
    ) {
        if (used.has(i)) {
            continue;
        }

        const segment =
            segments[i];

        let line = [
            segment[0],
            segment[1]
        ];

        used.add(i);

        let changed = true;

        while (changed) {
            changed = false;

            const startKey =
                pointKey(line[0]);

            const endKey =
                pointKey(
                    line[line.length - 1]
                );

            for (
                const key of [
                    startKey,
                    endKey
                ]
            ) {
                const candidates =
                    adjacency.get(key) || [];

                for (
                    const candidate
                    of candidates
                ) {
                    if (
                        used.has(candidate)
                    ) {
                        continue;
                    }

                    const s =
                        segments[candidate];

                    const s0 =
                        pointKey(s[0]);

                    const s1 =
                        pointKey(s[1]);

                    if (s0 === key) {
                        if (
                            key === startKey
                        ) {
                            line.unshift(
                                s[1]
                            );
                        } else {
                            line.push(
                                s[1]
                            );
                        }
                    } else if (s1 === key) {
                        if (
                            key === startKey
                        ) {
                            line.unshift(
                                s[0]
                            );
                        } else {
                            line.push(
                                s[0]
                            );
                        }
                    } else {
                        continue;
                    }

                    used.add(candidate);
                    changed = true;
                    break;
                }

                if (changed) {
                    break;
                }
            }
        }

        lines.push(line);
    }

    return lines;
}


// =============================================================================
// DOMAINS
// =============================================================================

function parseDomain(text, env) {
    const relation =
        parseRelation(text);

    if (!relation) {
        return null;
    }

    const variable =
        relation.left;

    if (
        ![
            'x',
            'y',
            't',
            'theta'
        ].includes(variable)
    ) {
        return null;
    }

    return {
        variable,
        operator: relation.operator,
        valueAst:
            parseExpression(
                relation.right
            ),
        env
    };
}

function domainAllows(
    domain,
    value
) {
    if (!domain) {
        return true;
    }

    const env =
        new Environment(domain.env);

    env.setVariable(
        domain.variable,
        value
    );

    const bound =
        evaluate(
            domain.valueAst,
            env
        );

    switch (domain.operator) {
        case '<':
            return value < bound;

        case '>':
            return value > bound;

        case '<=':
            return value <= bound;

        case '>=':
            return value >= bound;

        case '=':
        case '==':
            return Math.abs(
                value - bound
            ) < 1e-9;

        case '!=':
            return Math.abs(
                value - bound
            ) >= 1e-9;

        default:
            return true;
    }
}


// =============================================================================
// EXPRESSION TYPES
// =============================================================================

function makeAstEvaluator(
    ast,
    env,
    variable
) {
    return value => {
        const local =
            new Environment(env);

        local.setVariable(
            variable,
            value
        );

        return evaluate(
            ast,
            local
        );
    };
}

function makeXYEvaluator(
    leftAst,
    rightAst,
    operator,
    env
) {
    return (x, y) => {
        const local =
            new Environment(env);

        local.setVariable('x', x);
        local.setVariable('y', y);

        const left =
            evaluate(leftAst, local);

        const right =
            evaluate(rightAst, local);

        switch (operator) {
            case '=':
            case '==':
                return left - right;

            case '!=':
                return (
                    Math.abs(left - right)
                    < 1e-9
                )
                    ? 1
                    : -1;

            case '<':
                return left < right
                    ? -1
                    : 1;

            case '>':
                return left > right
                    ? -1
                    : 1;

            case '<=':
                return left <= right
                    ? -1
                    : 1;

            case '>=':
                return left >= right
                    ? -1
                    : 1;

            default:
                return left - right;
        }
    };
}


// =============================================================================
// TEXT
// =============================================================================

function parseTextExpression(text) {
    const ast =
        parseExpression(text);

    if (
        ast.type !== 'call' ||
        ast.name !== 'text' ||
        ast.args.length !== 4
    ) {
        return null;
    }

    if (
        ast.args[0].type !== 'string'
    ) {
        throw new Error(
            'text() first argument must be a string'
        );
    }

    return {
        text: ast.args[0].value,
        x: ast.args[1],
        y: ast.args[2],
        size: ast.args[3]
    };
}

function renderText(
    renderer,
    expression,
    env
) {
    const x =
        evaluate(expression.x, env);

    const y =
        evaluate(expression.y, env);

    const size =
        evaluate(expression.size, env);

    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(size)
    ) {
        return;
    }

    renderer.text(
        x,
        y,
        expression.text,
        size,
        expression.color
    );
}


// =============================================================================
// PARAMETRIC / POLAR
// =============================================================================

function parseTupleExpression(text) {
    const ast =
        parseExpression(text);

    if (
        ast.type === 'tuple' &&
        ast.values.length === 2
    ) {
        return ast.values;
    }

    return null;
}

function tryParseParametric(
    text,
    env
) {
    let domain = null;

    const domainInfo =
        splitDomain(text);

    if (domainInfo.domain) {
        domain =
            parseDomain(
                domainInfo.domain,
                env
            );

        text =
            domainInfo.expression;
    }

    const tuple =
        parseTupleExpression(text);

    if (!tuple) {
        return null;
    }

    const [xAst, yAst] =
        tuple;

    const vars = new Set();

    collectVariables(xAst, vars);
    collectVariables(yAst, vars);

    if (!vars.has('t')) {
        return null;
    }

    return {
        xAst,
        yAst,
        domain
    };
}

function tryParsePolar(
    text,
    env
) {
    let domain = null;

    const domainInfo =
        splitDomain(text);

    if (domainInfo.domain) {
        domain =
            parseDomain(
                domainInfo.domain,
                env
            );

        text =
            domainInfo.expression;
    }

    const relation =
        parseRelation(text);

    if (!relation) {
        return null;
    }

    if (
        relation.left !== 'r' &&
        relation.left !== 'rho'
    ) {
        return null;
    }

    const ast =
        parseExpression(
            relation.right
        );

    const vars = new Set();

    collectVariables(ast, vars);

    if (!vars.has('theta')) {
        return null;
    }

    return {
        ast,
        domain
    };
}

function collectVariables(
    ast,
    result
) {
    if (!ast || typeof ast !== 'object') {
        return;
    }

    if (ast.type === 'variable') {
        result.add(ast.name);
    }

    for (const value of Object.values(ast)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                collectVariables(
                    item,
                    result
                );
            }
        } else if (
            value &&
            typeof value === 'object'
        ) {
            collectVariables(
                value,
                result
            );
        }
    }
}


// =============================================================================
// RENDER EXPLICIT
// =============================================================================

function renderExplicit(
    renderer,
    ast,
    env,
    expression
) {
    const fn =
        makeAstEvaluator(
            ast,
            env,
            'x'
        );

    const points =
        sampleFunction(
            fn,
            renderer.options,
            'x'
        );

    /*
     * A y=f(x) graph does not necessarily define a closed
     * region, so requested fill uses the specified fallback.
     */
    if (
        expression.fill &&
        renderer.options
            .fallbackFillEntireScreen
    ) {
        renderer.fullScreenFill(
            expression.fill
        );
    }

    renderer.polyline(
        points,
        expression.color
    );
}


// =============================================================================
// RENDER VERTICAL
// =============================================================================

function renderVertical(
    renderer,
    ast,
    env,
    expression
) {
    const fn =
        makeAstEvaluator(
            ast,
            env,
            'y'
        );

    const points =
        sampleFunction(
            fn,
            renderer.options,
            'y'
        );

    if (
        expression.fill &&
        renderer.options
            .fallbackFillEntireScreen
    ) {
        renderer.fullScreenFill(
            expression.fill
        );
    }

    renderer.polyline(
        points,
        expression.color
    );
}


// =============================================================================
// RENDER IMPLICIT
// =============================================================================

function renderImplicit(
    renderer,
    leftAst,
    rightAst,
    operator,
    env,
    expression
) {
    const fn =
        makeXYEvaluator(
            leftAst,
            rightAst,
            operator,
            env
        );

    const segments =
        marchingSquares(
            fn,
            renderer.options
        );

    const lines =
        connectSegments(
            segments
        );

    let hasClosedRegion = false;

    if (expression.fill) {
        for (const line of lines) {
            if (line.length < 4) {
                continue;
            }

            const first =
                pointKey(line[0]);

            const last =
                pointKey(
                    line[line.length - 1]
                );

            if (first !== last) {
                continue;
            }

            hasClosedRegion = true;

            renderer.polygon(
                line,
                expression.fill
            );
        }

        if (
            !hasClosedRegion &&
            renderer.options
                .fallbackFillEntireScreen
        ) {
            renderer.fullScreenFill(
                expression.fill
            );
        }
    }

    /*
     * Outline always goes AFTER fill.
     */
    for (const line of lines) {
        renderer.polyline(
            line,
            expression.color
        );
    }
}


// =============================================================================
// PARAMETRIC
// =============================================================================

function renderParametric(
    renderer,
    parametric,
    env,
    expression
) {
    let tMin =
        renderer.options.tMin;

    let tMax =
        renderer.options.tMax;

    if (
        parametric.domain &&
        parametric.domain.variable === 't'
    ) {
        const bound =
            evaluate(
                parametric.domain.valueAst,
                env
            );

        if (
            parametric.domain.operator === '<' ||
            parametric.domain.operator === '<='
        ) {
            tMax = bound;
        } else if (
            parametric.domain.operator === '>' ||
            parametric.domain.operator === '>='
        ) {
            tMin = bound;
        }
    }

    const points = [];

    const count =
        renderer.options.samples;

    for (
        let i = 0;
        i <= count;
        i++
    ) {
        const t =
            tMin +
            (tMax - tMin) *
            i / count;

        if (
            parametric.domain &&
            !domainAllows(
                parametric.domain,
                t
            )
        ) {
            continue;
        }

        const local =
            new Environment(env);

        local.setVariable(
            't',
            t
        );

        let x;
        let y;

        try {
            x =
                evaluate(
                    parametric.xAst,
                    local
                );

            y =
                evaluate(
                    parametric.yAst,
                    local
                );
        } catch {
            continue;
        }

        if (
            Number.isFinite(x) &&
            Number.isFinite(y)
        ) {
            points.push([x, y]);
        }
    }

    if (
        expression.fill &&
        renderer.options
            .fallbackFillEntireScreen
    ) {
        renderer.fullScreenFill(
            expression.fill
        );
    }

    renderer.polyline(
        points,
        expression.color
    );
}


// =============================================================================
// POLAR
// =============================================================================

function renderPolar(
    renderer,
    polar,
    env,
    expression
) {
    const min =
        renderer.options.thetaMin;

    const max =
        renderer.options.thetaMax;

    const points = [];

    const count =
        renderer.options.samples;

    for (
        let i = 0;
        i <= count;
        i++
    ) {
        const theta =
            min +
            (max - min) *
            i / count;

        if (
            polar.domain &&
            !domainAllows(
                polar.domain,
                theta
            )
        ) {
            continue;
        }

        const local =
            new Environment(env);

        local.setVariable(
            'theta',
            theta
        );

        let r;

        try {
            r =
                evaluate(
                    polar.ast,
                    local
                );
        } catch {
            continue;
        }

        if (!Number.isFinite(r)) {
            continue;
        }

        const x =
            r * Math.cos(theta);

        const y =
            r * Math.sin(theta);

        points.push([x, y]);
    }

    if (
        expression.fill &&
        renderer.options
            .fallbackFillEntireScreen
    ) {
        renderer.fullScreenFill(
            expression.fill
        );
    }

    renderer.polyline(
        points,
        expression.color
    );
}


// =============================================================================
// INEQUALITIES
// =============================================================================

function renderInequality(
    renderer,
    leftAst,
    rightAst,
    operator,
    env,
    expression
) {
    const fn =
        makeXYEvaluator(
            leftAst,
            rightAst,
            operator,
            env
        );

    const fillColor =
        expression.fill || {
            ...expression.color,
            a: Math.round(
                expression.color.a *
                renderer.options
                    .inequalityOpacity
            )
        };

    const resolution =
        renderer.options
            .implicitResolution;

    const xStep =
        (
            renderer.options.xMax -
            renderer.options.xMin
        ) / resolution;

    const yStep =
        (
            renderer.options.yMax -
            renderer.options.yMin
        ) / resolution;

    for (
        let iy = 0;
        iy < resolution;
        iy++
    ) {
        const y =
            renderer.options.yMin +
            iy * yStep;

        for (
            let ix = 0;
            ix < resolution;
            ix++
        ) {
            const x =
                renderer.options.xMin +
                ix * xStep;

            const cx =
                x + xStep / 2;

            const cy =
                y + yStep / 2;

            let value;

            try {
                value =
                    fn(cx, cy);
            } catch {
                continue;
            }

            let inside = false;

            switch (operator) {
                case '<':
                case '<=':
                    inside =
                        value < 0;
                    break;

                case '>':
                case '>=':
                    inside =
                        value > 0;
                    break;
            }

            if (!inside) {
                continue;
            }

            renderer.polygon(
                [
                    [x, y],
                    [x + xStep, y],
                    [
                        x + xStep,
                        y + yStep
                    ],
                    [x, y + yStep]
                ],
                fillColor
            );
        }
    }

    /*
     * Boundary.
     */
    renderImplicit(
        renderer,
        leftAst,
        rightAst,
        '=',
        env,
        {
            ...expression,
            fill: null
        }
    );
}


// =============================================================================
// SINGLE EXPRESSION
// =============================================================================

function renderExpression(
    renderer,
    rawExpression,
    env
) {
    const modifiers =
        parseRenderModifiers(
            rawExpression
        );

    const text =
        modifiers.expression;

    const expression = {
        color: modifiers.color,
        fill: modifiers.fill
    };

    if (!text) {
        return;
    }

    /*
     * text(...)
     */
    if (
        /^text\s*\(/i.test(text)
    ) {
        const parsed =
            parseTextExpression(text);

        if (!parsed) {
            throw new Error(
                'Invalid text() expression'
            );
        }

        renderText(
            renderer,
            {
                ...parsed,
                color: expression.color
            },
            env
        );

        return;
    }

    /*
     * Polar.
     */
    const polar =
        tryParsePolar(
            text,
            env
        );

    if (polar) {
        renderPolar(
            renderer,
            polar,
            env,
            expression
        );

        return;
    }

    /*
     * Parametric.
     */
    const parametric =
        tryParseParametric(
            text,
            env
        );

    if (parametric) {
        renderParametric(
            renderer,
            parametric,
            env,
            expression
        );

        return;
    }

    const domainInfo =
        splitDomain(text);

    const mainText =
        domainInfo.expression;

    const relation =
        parseRelation(mainText);

    if (relation) {
        const leftAst =
            parseExpression(
                relation.left
            );

        const rightAst =
            parseExpression(
                relation.right
            );

        if (
            [
                '<',
                '>',
                '<=',
                '>='
            ].includes(
                relation.operator
            )
        ) {
            renderInequality(
                renderer,
                leftAst,
                rightAst,
                relation.operator,
                env,
                expression
            );

            return;
        }

        /*
         * y=f(x)
         */
        if (relation.left === 'y') {
            renderExplicit(
                renderer,
                rightAst,
                env,
                expression
            );

            return;
        }

        /*
         * x=f(y)
         */
        if (relation.left === 'x') {
            renderVertical(
                renderer,
                rightAst,
                env,
                expression
            );

            return;
        }

        /*
         * General implicit equation.
         */
        renderImplicit(
            renderer,
            leftAst,
            rightAst,
            relation.operator,
            env,
            expression
        );

        return;
    }

    /*
     * Plain expression = y=f(x)
     */
    const ast =
        parseExpression(mainText);

    renderExplicit(
        renderer,
        ast,
        env,
        expression
    );
}


// =============================================================================
// ASSIGNMENTS
// =============================================================================

function processAssignments(
    expressions,
    env
) {
    const remaining = [];

    for (const expression of expressions) {
        const modifiers =
            parseRenderModifiers(
                expression
            );

        const assignment =
            parseAssignment(
                modifiers.expression
            );

        if (!assignment) {
            remaining.push(expression);
            continue;
        }

        if (
            assignment.type === 'variable'
        ) {
            const ast =
                parseExpression(
                    assignment.body
                );

            const value =
                evaluate(ast, env);

            env.setVariable(
                assignment.name,
                value
            );

            continue;
        }

        if (
            assignment.type === 'function'
        ) {
            const ast =
                parseExpression(
                    assignment.body
                );

            env.setFunction(
                assignment.name,
                assignment.args,
                ast
            );

            continue;
        }
    }

    return remaining;
}


// =============================================================================
// GRID / AXES
// =============================================================================

function renderGrid(
    renderer,
    options
) {
    if (!options.grid) {
        return;
    }

    const color = {
        r: 41,
        g: 45,
        b: 54,
        a: 255
    };

    for (
        let x = Math.ceil(options.xMin);
        x <= Math.floor(options.xMax);
        x++
    ) {
        if (x === 0) continue;

        renderer.line(
            x,
            options.yMin,
            x,
            options.yMax,
            color,
            1
        );
    }

    for (
        let y = Math.ceil(options.yMin);
        y <= Math.floor(options.yMax);
        y++
    ) {
        if (y === 0) continue;

        renderer.line(
            options.xMin,
            y,
            options.xMax,
            y,
            color,
            1
        );
    }
}

function renderAxes(
    renderer,
    options
) {
    if (!options.axes) {
        return;
    }

    const color = {
        r: 199,
        g: 204,
        b: 214,
        a: 255
    };

    if (
        options.xMin <= 0 &&
        options.xMax >= 0
    ) {
        renderer.line(
            0,
            options.yMin,
            0,
            options.yMax,
            color,
            2
        );
    }

    if (
        options.yMin <= 0 &&
        options.yMax >= 0
    ) {
        renderer.line(
            options.xMin,
            0,
            options.xMax,
            0,
            color,
            2
        );
    }
}


// =============================================================================
// MAIN PLOT
// =============================================================================

async function plot(
    input,
    options = {}
) {
    const merged = {
        ...DEFAULT_OPTIONS,
        ...options
    };

    if (
        typeof input !== 'string'
    ) {
        throw new Error(
            'plot() requires an expression string'
        );
    }

    /*
     * IMPORTANT:
     *
     * ONLY the exact string "help" triggers help.
     *
     * "help+1"
     * "help(x)"
     * "Help"
     * "helpful"
     *
     * all go through the normal parser.
     */
    if (input === 'help') {
        return renderHelp(
            merged
        );
    }

    if (!input.trim()) {
        throw new Error(
            'plot() requires an expression string'
        );
    }

    let expressions =
        splitTopLevel(input);

    const env =
        new Environment();

    /*
     * Variable/function definitions are processed first.
     *
     * Actual renderable expressions retain their original
     * order and therefore their back-to-front order.
     */
    expressions =
        processAssignments(
            expressions,
            env
        );

    const renderer =
        new SVGRenderer(merged);

    /*
     * Graph UI is underneath all expressions.
     */
    renderGrid(
        renderer,
        merged
    );

    renderAxes(
        renderer,
        merged
    );

    /*
     * BACK → FRONT.
     *
     * The first renderable expression is drawn first.
     * The final expression is drawn last.
     */
    for (
        const expression
        of expressions
    ) {
        try {
            renderExpression(
                renderer,
                expression,
                env
            );
        } catch (error) {
            throw new Error(
                `Error plotting expression ` +
                `"${expression}": ` +
                error.message
            );
        }
    }

    const svg =
        renderer.render();

    return sharp(
        Buffer.from(svg)
    )
        .png()
        .toBuffer();
}


// =============================================================================
// PUBLIC PARSER API
// =============================================================================

function parseDesmosExpression(
    input
) {
    const expressions =
        splitTopLevel(input);

    return expressions.map(raw => {
        const modifiers =
            parseRenderModifiers(raw);

        return {
            raw,
            expression:
                modifiers.expression,
            color:
                modifiers.color,
            fill:
                modifiers.fill
        };
    });
}


// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    plot,
    Parser,
    Environment,
    evaluate,
    parseDesmosExpression,
    DEFAULT_OPTIONS
};