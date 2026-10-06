// ============================================================
// Storage entry point
// ============================================================
// Picks the backend from STORAGE_BACKEND (default: file),
// creates its adapter, and hands it to the write-behind store.
// index.js calls initStorage() once before startSock().

const store = require("./store");

// name -> adapter module (lazily required so selecting a
// backend never loads the other drivers)
const REGISTRY = {
    file: () => require("./adapters/file"),
    mysql: () => require("./adapters/mysql"),
    mariadb: () => require("./adapters/mysql"),
    postgres: () => require("./adapters/postgres"),
    supabase: () => require("./adapters/postgres"),
    redis: () => require("./adapters/redis")
};


function createAdapter(name, url, opts) {

    const loadAdapter =
        REGISTRY[name ?? "file"];

    if (!loadAdapter) {
        throw new Error(
            `Unknown storage backend "${name}". ` +
            `Valid backends: ${Object.keys(REGISTRY).join(", ")}.`
        );
    }

    return loadAdapter().create(url, opts);
}


async function initStorage(opts = {}) {

    const backend =
        opts.backend ||
        process.env.STORAGE_BACKEND ||
        "file";

    const url =
        opts.url !== undefined
            ? opts.url
            : process.env.STORAGE_URL || undefined;

    const adapter = createAdapter(backend, url);

    await adapter.init();

    await store.attach(adapter);

    console.log(
        `[storage] Using backend: ${backend}`
    );
}


module.exports = {
    initStorage,
    createAdapter,
    flushNow: store.flushNow,
    closeStore: store.closeStore
};
