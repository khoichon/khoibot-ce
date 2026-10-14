// ============================================================
// File adapter (default backend)
// ============================================================
// Stores the whole config document as one pretty-printed JSON
// file. Writes go to a temp file first and are then renamed
// over the target, so a crash mid-write can never truncate the
// previous config.

const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(
    __dirname,
    "..",
    "..",
    "bot-config.json"
);


// Accepts no URL (default bot-config.json at the repo root), a
// plain filesystem path, or a file:// URL. Any other URL scheme
// (postgres://, mysql://, ...) is a misconfiguration — usually
// STORAGE_URL leaking in — and must fail loudly rather than be
// treated as a filename.
function resolveFilePath(url) {

    if (!url) {
        return DEFAULT_FILE;
    }

    if (url.startsWith("file://")) {
        return decodeURIComponent(
            new URL(url).pathname
        );
    }

    const foreignScheme =
        url.match(/^[a-z][a-z0-9+.-]*:\/\//i);

    if (foreignScheme) {
        throw new Error(
            `File backend received a ${foreignScheme[0]} URL; ` +
            "expected a filesystem path, a file:// URL, or no " +
            "URL. (Was STORAGE_URL meant for a database backend?)"
        );
    }

    return url;
}


module.exports = {
    name: "file",
    aliases: [],

    create(url) {

        const filePath = resolveFilePath(url);


        // Synchronous read so the store can hydrate the default
        // file backend at require time without any async dance.
        // Returns null when the file doesn't exist yet; throws
        // on a corrupt file (the caller decides how to recover).
        function loadAllSync() {

            let content;

            try {
                content = fs.readFileSync(
                    filePath,
                    "utf8"
                );
            } catch (error) {
                if (error.code === "ENOENT") {
                    return null;
                }
                throw error;
            }

            return JSON.parse(content);
        }


        return {

            async init() {
                // Nothing to set up; the directory must already
                // exist (repo root or a user-provided path).
            },

            async loadAll() {
                return loadAllSync();
            },

            async saveAll(doc) {

                const tmp = `${filePath}.tmp`;

                await fs.promises.writeFile(
                    tmp,
                    JSON.stringify(doc, null, 4),
                    "utf8"
                );

                await fs.promises.rename(
                    tmp,
                    filePath
                );
            },

            async close() {
                // Nothing to release.
            },

            loadAllSync
        };
    }
};
