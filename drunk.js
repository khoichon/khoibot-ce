const SWAPS = { p: "b", b: "p", t: "d", d: "t", k: "g", g: "k" };
const VOWELS = "aeiou";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const HIC_BITS = ["**hic**"];

function chance(rng, odds) {
    return rng() < odds;
}

function pick(rng, list) {
    return list[Math.floor(rng() * list.length)];
}

function keepAsIs(token) {
    return token.startsWith("@") || /^(https?:\/\/|www\.)/i.test(token) || /\d/.test(token);
}

function scrambleCore(core, rng) {
    let out = "";
    for (const ch of core) {
        const lower = ch.toLowerCase();
        if (!/[a-z]/.test(lower)) {
            out += ch;
            continue;
        }
        if (SWAPS[lower] && chance(rng, 0.35)) {
            out += SWAPS[lower];
        } else if (lower === "s" && chance(rng, 0.3)) {
            out += "sh";
        } else {
            out += lower;
        }
        if (VOWELS.includes(lower) && chance(rng, 0.2)) {
            out += lower;
        }
        if (chance(rng, 0.06)) {
            out += pick(rng, LETTERS);
        }
    }
    if (out.length > 3 && chance(rng, 0.15)) {
        const at = Math.floor(rng() * (out.length - 1));
        out = out.slice(0, at) + out[at + 1] + out[at] + out.slice(at + 2);
    }
    if (/^[a-z]/.test(out) && chance(rng, 0.3)) {
        out = out[0] + out;
    }
    if (out.length > 4 && chance(rng, 0.12)) {
        out = out.slice(0, -1);
    }
    return out;
}

function scrambleToken(token, rng) {
    const [, lead, core, tail] = token.match(/^(\W*)(.*?)(\W*)$/);
    if (!core) {
        return token;
    }
    return lead + scrambleCore(core, rng) + tail;
}

function drunkLine(line, rng) {
    if (!/[a-z]/i.test(line)) {
        return line;
    }
    const parts = line.trim().split(/\s+/);
    let out = "";
    let stickyBefore = true;
    parts.forEach((part, index) => {
        const protectedPart = keepAsIs(part);
        if (index > 0) {
            const merge = !protectedPart && !stickyBefore && chance(rng, 0.45);
            if (!merge) {
                out += " ";
            }
        }
        out += protectedPart ? part : scrambleToken(part, rng);
        stickyBefore = protectedPart;
        if (index < parts.length - 1 && chance(rng, 0.18)) {
            out += " " + pick(rng, HIC_BITS);
            stickyBefore = true;
        }
    });
    if (chance(rng, 0.1)) {
        out += "!!";
    }
    if (chance(rng, 0.85)) {
        out += " " + (chance(rng, 0.8) ? "**hic**" : pick(rng, HIC_BITS));
    }
    return out;
}

function drunkify(text, rng = Math.random) {
    return String(text)
        .split("\n")
        .map((line) => drunkLine(line, rng))
        .join("\n");
}

module.exports = { drunkify };
