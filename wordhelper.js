async function randomWord(difficulty="2", length=8) {
    try {
        const params = new URLSearchParams({
            number: "1",
            length: String(length),
            diff: String(difficulty)
        });
        const response = await fetch(
            `https://random-word-api.herokuapp.com/word?${params}`
        );

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(
                `Random word API returned HTTP ${response.status}: ${errorBody}`
            );
        }

        const data = await response.json();
        if (!Array.isArray(data) || typeof data[0] !== "string") {
            throw new Error("Random word API returned an invalid response.");
        }

        return data[0];
    } catch (error) {
        console.error("Error fetching random word:", error);
        return null;
    }
}

module.exports = {
    randomWord
};