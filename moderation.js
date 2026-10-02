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



// Example usage in a bot event listener:
const inputMessage = "hеllо սsеr"; // Contains Cyrillic 'е', 'о' and Armenian 'ս'
const cleanMessage = deobfuscate(inputMessage);

async function analyzeText(text) {
    const apiKey = process.env.BADWORD_API_KEY;

    if (!apiKey) {
        throw new Error("BADWORD_API_KEY is not configured");
    }

    const response = await fetch(API_URL, {
        method: "POST",

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

async function isToxic(text, threshold = 0.7) {
    console.log(`Analyzing text: ${deobfuscate(text)}`);
    const result = await analyzeText(deobfuscate(text));

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