// ============================================================
// Write-behind config store
// ============================================================
// Callers (config.js) read and mutate the in-memory document
// synchronously — exactly like the old config.js singleton.
// Mutations mark the store dirty; a debounced flusher writes
// the whole document to the active backend adapter. Durability:
// human-issued commands flush immediately, signals flush on
// shutdown, and a failed flush keeps the dirty flag so the next
// trigger retries.

const { normalizeDoc } = require("./normalize");

const FLUSH_DELAY_MS = 1000;
const RETRY_DELAY_MS = 1000;
const SHUTDOWN_TIMEOUT_MS = 3000;

let doc = null;          // canonical in-memory document
let adapter = null;      // active adapter instance (null until attached)
let dirty = false;
let flushTimer = null;
let flushing = null;     // in-flight flush promise (serializes saves)
let signalsRegistered = false;


// ============================================================
// Hydration
// ============================================================

// Returns the live document. Callers mutate it directly and
// then call markDirty().
function getStoreDoc() {

    if (doc) {
        return doc;
    }

    // Async backends can't hydrate here; they are loaded by
    // initStorage() before the bot starts handling messages.
    const backend =
        process.env.STORAGE_BACKEND || "file";

    if (backend !== "file") {
        throw new Error(
            `Storage backend "${backend}" loads asynchronously; ` +
            "initStorage() must complete before the config is used."
        );
    }

    hydrateSyncFromFile();

    return doc;
}


// The file backend hydrates lazily and synchronously on first
// access, preserving the old config.js require-time behavior
// with zero async plumbing on the default path.
function hydrateSyncFromFile() {

    const fileAdapter = require("./adapters/file").create(
        process.env.STORAGE_URL
    );

    let raw = null;

    try {
        raw = fileAdapter.loadAllSync();
    } catch (error) {
        console.error("Failed to load config from file:");
        console.error(error);
        console.log("Using default configuration.");
    }

    const { doc: normalized, changed } =
        normalizeDoc(raw);

    doc = normalized;

    if (changed && raw !== null) {
        // The stored document needed repair (old format, string
        // booleans, ...) — write the repaired form back once the
        // adapter is attached.
        dirty = true;
    }
}


// Called by storage/index.js after adapter.init() resolved.
async function attach(adapterInstance) {

    if (!doc) {

        let raw = null;

        try {
            raw = await adapterInstance.loadAll();
        } catch (error) {
            console.error("Failed to load config from backend:");
            console.error(error);
            console.log("Using default configuration.");
        }

        const { doc: normalized, changed } =
            normalizeDoc(raw);

        doc = normalized;

        if (changed && raw !== null) {
            dirty = true;
        }
    }

    adapter = adapterInstance;
    registerSignalHandlers();

    if (dirty) {
        // Await the repair write so a caller that exits right
        // after initStorage() can't cut it off mid-flight.
        await flushNow();
    }
}


// ============================================================
// Dirty tracking and flushing
// ============================================================

function markDirty({ immediate = false } = {}) {

    dirty = true;

    if (immediate) {

        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }

        // Fire-and-forget; if a flush is already in flight, the
        // tail re-flush below picks this up.
        flushNow();

    } else if (!flushTimer && !flushing) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushNow();
        }, FLUSH_DELAY_MS);
    }
}


// Writes the document to the backend if dirty. Never overlaps
// another flush: if one is in flight, the dirty flag makes the
// in-flight flush chain one more write. Errors are logged and
// the dirty flag retained for a delayed retry — a transient
// backend outage must never lose a mutation.
function flushNow() {

    if (!adapter) {
        return Promise.resolve();
    }

    // An in-flight write covers this call: awaiting it waits
    // for the write (and its tail re-flush if dirtied mid-write).
    if (flushing) {
        return flushing;
    }

    if (!dirty) {
        return Promise.resolve();
    }

    dirty = false;

    const snapshot = structuredClone(doc);
    let failed = false;

    flushing = adapter
        .saveAll(snapshot)
        .catch(error => {
            failed = true;
            console.error(
                "[storage] Failed to flush config " +
                    "(will retry):",
                error.message || error
            );
        })
        .then(() => {
            flushing = null;

            if (failed) {
                dirty = true;
                if (!flushTimer) {
                    flushTimer = setTimeout(() => {
                        flushTimer = null;
                        flushNow();
                    }, RETRY_DELAY_MS);
                }
            } else if (dirty) {
                // Dirtied while the write was in flight.
                flushNow();
            }
        });

    return flushing;
}


async function closeStore() {

    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    // Drain in-flight and pending writes before disconnecting —
    // closing the adapter mid-write would drop it. Bounded so a
    // dead backend can't hang shutdown forever.
    let attempts = 0;

    while (
        (dirty || flushing) &&
        attempts++ < 3
    ) {
        await flushNow();
    }

    if (adapter) {

        try {
            await adapter.close();
        } catch (error) {
            console.error(
                "[storage] Error closing backend:",
                error.message || error
            );
        }

        adapter = null;
    }
}


// ============================================================
// Shutdown flush
// ============================================================

function registerSignalHandlers() {

    if (signalsRegistered) {
        return;
    }
    signalsRegistered = true;

    const shutdown = exitCode => {
        Promise.race([
            closeStore(),
            new Promise(resolve =>
                setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)
            )
        ]).finally(() => process.exit(exitCode));
    };

    process.on("SIGINT", () => shutdown(130));
    process.on("SIGTERM", () => shutdown(143));

    process.on("beforeExit", () => {
        if (dirty) {
            flushNow();
        }
    });
}


module.exports = {
    getStoreDoc,
    attach,
    markDirty,
    flushNow,
    closeStore
};
