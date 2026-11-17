const { betterLoggingEnabled } = require("./logging.js");

const API_URL = "http://localhost:8000/api/v1/analyze";

// Keep only the original odd lookalikes that aren't part of standard math blocks
const baseAlpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const baseLookalikes = "аᖯсԁеғɡһіјкӏｍпорզгѕтսνωху𝗓ΑΒСDΕҒＧНІЈΚLMΝОΡQRЅΤՍ𝖵𝖶ΧΥΖ";

function deobfuscate(text) {
    if (!text) return "";
    
    // 1. Universally strips out ALL math fonts (bold, italic, monospace 𝖽𝖺𝗆𝗇, etc.)
    let normalized = text.normalize("NFKC");
    
    // 2. Fallback loop for custom alphabets/lookalikes (like Cyrillic/Armenian swaps)
    return Array.from(normalized).map(char => {
        const index = baseLookalikes.indexOf(char);
        return index !== -1 ? baseAlpha[index] : char;
    }).join('');
}




async function analyzeText(text) {
    const apiKey = process.env.BADWORD_API_KEY;

    if (!apiKey) {
        throw new Error("BADWORD_API_KEY is not configured");
    }

    const response = await fetch(API_URL, {
        method: "POST",
        // dont wait forever if the model api hangs, errors already fail open
        signal: AbortSignal.timeout(8000),

        headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey
        },

        body: JSON.stringify({
            text
        })
    });

    if (!response.ok) {
        throw new Error(
            `Moderation API returned ${response.status}`
        );
    }

    return response.json();
}

// one or two short words get flagged way too easily by the multilingual model (a plain "look" got deleted),
// so they need a much higher score before anything is removed. chinese, japanese and korean are left alone
// because a whole sentence can be one "word" there
const SHORT_MESSAGE_THRESHOLD = Number(process.env.BADWORD_SHORT_THRESHOLD) || 0.98;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

function thresholdFor(cleaned, threshold) {
    const trimmed = cleaned.trim();
    const words = trimmed.split(/\s+/).length;
    if (words <= 2 && trimmed.length <= 12 && !CJK.test(trimmed)) {
        return Math.max(threshold, SHORT_MESSAGE_THRESHOLD);
    }
    return threshold;
}

// messages with nothing but numbers and basic punctuation (game answers, math)
// cant be toxic, so we dont bother the model with them
async function isToxic(text, threshold = 0.7) {
    const cleaned = deobfuscate(text);
    if (!/[^0-9 .,!?+*/=%()-]/.test(cleaned)) {
        return { toxic: false, score: 0, scores: {} };
    }

    if (!betterLoggingEnabled()) console.log("Analyzing text: " + cleaned);
    const result = await analyzeText(cleaned);

    return {
        toxic: result.scores.toxicity >= thresholdFor(cleaned, threshold),
        score: result.scores.toxicity,
        scores: result.scores
    };
}


// pictures
const IMAGE_API_URL = "http://localhost:8000/api/v1/analyze-image";

// how sure the picture model has to be before a picture counts as explicit
const NSFW_THRESHOLD = Number(process.env.BADWORD_NSFW_THRESHOLD) || 0.85;

// sends one jpeg to the api, it answers with an explicit score and the text it read inside the picture
async function analyzeImage(buffer) {
    const apiKey = process.env.BADWORD_API_KEY;

    if (!apiKey) {
        throw new Error("BADWORD_API_KEY is not configured");
    }

    const response = await fetch(IMAGE_API_URL, {
        method: "POST",
        // the pi needs a few seconds for a picture, but dont wait forever
        signal: AbortSignal.timeout(20000),
        headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey
        },
        body: JSON.stringify({
            image: buffer.toString("base64")
        })
    });

    if (!response.ok) {
        throw new Error(
            "Picture moderation API returned " + response.status
        );
    }

    return response.json();
}

// bad means explicit, or the words inside the picture are as toxic as a bad text message would be
async function isImageBad(buffer, threshold = 0.7) {
    const result = await analyzeImage(buffer);
    const text = deobfuscate(result.text || "");

    if (result.nsfw >= NSFW_THRESHOLD) {
        return { bad: true, reason: "explicit", score: result.nsfw, text };
    }

    const toxicity = result.scores ? result.scores.toxicity : undefined;
    if (text.trim() && typeof toxicity === "number" && toxicity >= thresholdFor(text, threshold)) {
        return { bad: true, reason: "text", score: toxicity, text };
    }

    return { bad: false, reason: null, score: result.nsfw, text };
}

module.exports = {
    analyzeText,
    analyzeImage,
    isToxic,
    isImageBad
};
