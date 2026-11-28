const fs = require("node:fs");

function keepBrokenCopy(file) {
    try {
        const copy = `${file}.broken-${Date.now()}`;
        fs.copyFileSync(file, copy);
        console.error(`[backup] ${file} could not be read, kept a copy at ${copy}`);
        return copy;
    } catch {
        return null;
    }
}

module.exports = { keepBrokenCopy };
