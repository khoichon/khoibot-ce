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
        toxic: result.scores.toxicity >= threshold,
        score: result.scores.toxicity,
        scores: result.scores
    };
}

module.exports = {
    analyzeText,
    isToxic
};
