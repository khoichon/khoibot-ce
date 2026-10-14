const { log } = require("./logging.js");
const { isToxic } = require("./moderation.js");

// how many words we pull before giving up if they keep coming back toxic or arent real words
const MAX_TRIES = 8;
// single words score a bit oddly on detoxify, so this sits lower than the chat filter
const TOXIC_THRESHOLD = 0.5;

// definitions of the words we picked, so hints can use them later without asking the dictionary again
const definitions = new Map();
const MAX_CACHED = 200;
// how long each dictionary gets to answer, in ms
const LOOKUP_TIMEOUT_MS = 4000;

// how long each word site gets before we try the next one, in ms
const WORD_API_TIMEOUT_MS = 5000;

// asks a site for json, and keeps the error short (heroku sends a whole html page when its down)
async function getJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(WORD_API_TIMEOUT_MS) });
    if (!response.ok) {
        const body = (await response.text()).replace(/\s+/g, " ").slice(0, 80);
        throw new Error(`HTTP ${response.status} ${body}`);
    }
    return response.json();
}

// the places we get random words from, tried in order. if one is down we just move to the next
const WORD_SOURCES = [
    {
        name: "random-word-api",
        async get(difficulty, length) {
            const params = new URLSearchParams({ number: "1", length: String(length), diff: String(difficulty) });
            const data = await getJson(`https://random-word-api.herokuapp.com/word?${params}`);
            return data[0];
        }
    },
    {
        // same people as the one above but hosted somewhere else, so it usually survives when heroku doesnt
        name: "random-word-api mirror",
        async get(difficulty, length) {
            const data = await getJson(`https://random-word-api.vercel.app/api?words=1&length=${length}`);
            return data[0];
        }
    },
    {
        // gives back up to 1000 words that fit the pattern, so we pick one ourselves
        name: "datamuse",
        async get(difficulty, length) {
            const pattern = encodeURIComponent("?".repeat(length));
            const data = await getJson(`https://api.datamuse.com/words?sp=${pattern}&max=1000`);
            // it has some hyphenated and multi word stuff in there, so only keep plain words
            const plain = data.map(entry => entry.word).filter(word => /^[a-z]+$/.test(word));
            return plain[Math.floor(Math.random() * plain.length)];
        }
    }
];

// grabs one word, trying each site until one works. no dictionary or toxic checking here
async function fetchWord(difficulty, length) {
    for (const source of WORD_SOURCES) {
        try {
            const word = await source.get(difficulty, length);
            if (typeof word !== "string" || !/^[a-z]+$/i.test(word) || word.length !== Number(length)) {
                throw new Error("it sent back something that isnt a word");
            }
            return word;
        } catch (error) {
            log.warn("games", `${source.name} couldnt give us a word, trying the next one:`, error.message);
        }
    }

    log.error("games", "every random word site failed");
    return null;
}

// "noun: a thing; verb: to do a thing", from the first couple of meanings
function summarize(entries) {
    const meanings = entries.flatMap(entry => entry.meanings || []).slice(0, 2);
    const parts = meanings
        .map(meaning => {
            const text = meaning.definitions?.[0]?.definition;
            return text ? `${meaning.partOfSpeech}: ${text}` : null;
        })
        .filter(Boolean);
    return parts.length ? parts.join("; ") : null;
}

// wiktionary sends its definitions as html, so strip the tags
function stripHtml(html) {
    return String(html || "")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();
}

// each of these gives { real, definition } and throws if it couldnt get an answer
async function askDictionary(word) {
    const response = await fetch(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
        { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) }
    );

    if (response.status === 404) {
        return { real: false, definition: null };
    }
    if (!response.ok) {
        throw new Error(`Dictionary API returned HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data) || !data.length) {
        return { real: false, definition: null };
    }
    return { real: true, definition: summarize(data) };
}

// wiktionary is the backup, the dictionary api is slow a lot of the time
async function askWiktionary(word) {
    const response = await fetch(
        `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`,
        {
            signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
            headers: { "User-Agent": "khoibot (whatsapp bot)" }
        }
    );

    if (response.status === 404) {
        return { real: false, definition: null };
    }
    if (!response.ok) {
        throw new Error(`Wiktionary returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const parts = (data?.en || []).slice(0, 2)
        .map(part => {
            const text = stripHtml(part.definitions?.[0]?.definition);
            return text ? `${String(part.partOfSpeech).toLowerCase()}: ${text}` : null;
        })
        .filter(Boolean);
    return parts.length
        ? { real: true, definition: parts.join("; ") }
        : { real: false, definition: null };
}

// asks both at the same time and goes with whichever says yes first. real is true if either
// knows the word and false only if both say no. it's null when nobody could answer (down, slow,
// rate limited) because then we cant blame the word
function lookupWord(word) {
    return new Promise(resolve => {
        let left = 2;
        // what went wrong with each one, so we only complain when neither of them could answer
        const problems = [];

        const done = () => {
            left -= 1;
            if (left === 0) {
                if (problems.length === 2) {
                    log.warn("games", "neither dictionary could check the word:", problems.join(" / "));
                }
                resolve(problems.length ? { real: null, definition: null } : { real: false, definition: null });
            }
        };

        for (const ask of [askDictionary, askWiktionary]) {
            ask(word).then(result => {
                if (result.real) {
                    resolve(result);
                }
                done();
            }).catch(error => {
                problems.push(`${ask.name}: ${error.message}`);
                done();
            });
        }
    });
}

function remember(word, definition) {
    definitions.set(word, definition);
    // no need to keep every word forever
    if (definitions.size > MAX_CACHED) {
        definitions.delete(definitions.keys().next().value);
    }
}

// the dictionary definition of a word with the word itself blanked out, or null if there isnt one.
// hints use this so the ai rewords a real definition instead of guessing what the word means
async function getDefinition(word) {
    const key = String(word || "").toLowerCase();
    if (!/^[a-z]+$/.test(key)) {
        return null;
    }

    if (!definitions.has(key)) {
        const result = await lookupWord(key);
        // a dictionary hiccup isnt remembered, so the next hint gets another chance
        if (result.real === null) {
            return null;
        }
        remember(key, result.definition);
    }

    const definition = definitions.get(key);
    if (!definition) {
        return null;
    }
    return definition.replace(new RegExp(`\\b${key}\\w*`, "gi"), "___").slice(0, 300);
}

// grabs a word, throws it back if it isnt in the dictionary or detoxify thinks it's toxic
async function randomWord(difficulty = "2", length = 8) {
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        const word = await fetchWord(difficulty, length);
        if (!word) {
            return null;
        }

        // it has to be a real word. if the dictionary cant answer we let it through
        const found = await lookupWord(word);
        if (found.real === false) {
            log.info("games", `skipped a random word that isn't in the dictionary (try ${attempt} of ${MAX_TRIES})`);
            continue;
        }

        try {
            const result = await isToxic(word, TOXIC_THRESHOLD);
            if (!result.toxic) {
                if (found.real) {
                    remember(word.toLowerCase(), found.definition);
                }
                return word;
            }
            log.info("games", `skipped a toxic random word (try ${attempt} of ${MAX_TRIES})`);
        } catch (error) {
            // the moderation api is down or has no key, so don't break the games over it
            log.warn("games", "couldn't check the random word, using it anyway:", error);
            if (found.real) {
                remember(word.toLowerCase(), found.definition);
            }
            return word;
        }
    }
    return null;
}

module.exports = {
    randomWord,
    getDefinition
};
