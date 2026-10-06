#!/usr/bin/env node
// ============================================================
// Data transfer CLI — move config between any two backends
// ============================================================
//   node storage/migrate.js --from file [--from-url <url>]
//                           --to mysql --to-url <url>
//                           [--dry-run] [--yes]
//
// Both sides go through the same adapter registry the bot uses,
// with the normalized in-memory document as the pivot, so any
// backend can transfer to any other (including file -> file,
// which doubles as the backup command). The source is never
// written to. The destination is fully REPLACED — there is no
// merge mode — so a non-empty destination requires --yes (or an
// interactive confirmation). After writing, the destination is
// re-read and deep-compared against the source; any mismatch
// fails the run.

const readline = require("readline/promises");
const { createAdapter } = require("./index");
const {
    normalizeDoc,
    stableStringify
} = require("./normalize");


// ============================================================
// Arguments
// ============================================================

function parseArgs(argv) {

    const args = {
        from: "file",
        fromUrl: undefined,
        to: undefined,
        toUrl: undefined,
        dryRun: false,
        yes: false
    };

    for (let i = 0; i < argv.length; i++) {

        const arg = argv[i];

        switch (arg) {
            case "--from":
                args.from = argv[++i];
                break;
            case "--from-url":
                args.fromUrl = argv[++i];
                break;
            case "--to":
                args.to = argv[++i];
                break;
            case "--to-url":
                args.toUrl = argv[++i];
                break;
            case "--dry-run":
                args.dryRun = true;
                break;
            case "--yes":
            case "-y":
                args.yes = true;
                break;
            default:
                fail(`Unknown argument: ${arg}`);
        }
    }

    if (!args.to) {
        fail(
            "Missing --to <backend>. Usage: node storage/migrate.js " +
            "--from <backend> [--from-url <url>] --to <backend> " +
            "[--to-url <url>] [--dry-run] [--yes]"
        );
    }

    return args;
}

function fail(message) {
    console.error(`Error: ${message}`);
    process.exit(1);
}


// ============================================================
// Helpers
// ============================================================

// Never print credentials: mask the password in any URL shown.
function maskUrl(url) {

    if (!url) {
        return "(default)";
    }

    return url.replace(
        /^([a-z]+:\/\/[^:/@]+):[^@]*@/,
        "$1:****@"
    );
}


function describeDoc(doc) {
    return (
        `${doc.trusted.length} trusted, ` +
        `${doc.enabledGroups.length} enabled groups, ` +
        `${Object.keys(doc.groupSettings).length} group settings`
    );
}


function firstDivergingPath(a, b, path = "$") {

    if (stableStringify(a) === stableStringify(b)) {
        return null;
    }

    if (
        typeof a !== "object" ||
        a === null ||
        typeof b !== "object" ||
        b === null
    ) {
        return path;
    }

    const keys = new Set([
        ...Object.keys(a),
        ...Object.keys(b)
    ]);

    for (const key of keys) {
        const diverging = firstDivergingPath(
            a[key],
            b[key],
            `${path}.${key}`
        );

        if (diverging) {
            return diverging;
        }
    }

    return path;
}


async function confirmOverwrite() {

    if (!process.stdin.isTTY) {
        console.error(
            "Destination is not empty. Re-run with --yes to " +
            "replace it (requires a terminal for confirmation)."
        );
        return false;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const answer =
        await rl.question(
            "Destination is not empty. Replace it? [y/N] "
        );

    rl.close();

    return answer.trim().toLowerCase() === "y";
}


// ============================================================
// Main
// ============================================================

async function main() {

    const args = parseArgs(process.argv.slice(2));

    // URL flags win; omitted ones fall back to STORAGE_URL from
    // the environment (e.g. node --env-file=.env storage/migrate.js).
    // The file backend is exempt from the fallback: with a
    // database URL in STORAGE_URL it would treat that URL as a
    // filesystem path, silently read an empty source, and clobber
    // the destination with default config. No URL means "the
    // default bot-config.json".
    const envUrl = process.env.STORAGE_URL;
    const fromUrl =
        args.fromUrl ??
        (args.from === "file" ? undefined : envUrl);
    const toUrl =
        args.toUrl ??
        (args.to === "file" ? undefined : envUrl);


    // ---- Load source --------------------------------------

    const source = createAdapter(args.from, fromUrl);

    await source.init();

    let raw;

    try {
        raw = await source.loadAll();
    } catch (error) {
        fail(
            `Could not read from source: ${error.message}`
        );
    }

    const { doc } = normalizeDoc(raw);

    console.log(
        `Source:      ${args.from} (${maskUrl(fromUrl)})`
    );

    console.log(
        `Destination: ${args.to} (${maskUrl(toUrl)})`
    );

    console.log(
        `Payload:     ${describeDoc(doc)}`
    );

    if (raw === null) {
        console.log(
            "Warning: source is empty — the destination " +
            "will receive default config."
        );
    }


    // ---- Preview / dry run --------------------------------

    if (args.dryRun) {
        console.log(
            "Dry run: nothing was written."
        );
        await source.close();
        return;
    }


    // ---- Prepare destination ------------------------------

    const dest = createAdapter(args.to, toUrl);

    await dest.init();

    let destRaw = null;

    try {
        destRaw = await dest.loadAll();
    } catch (error) {
        // An unreadable destination is treated as empty; the
        // replace below will (re)initialize it.
    }

    if (destRaw !== null && !args.yes) {

        const destDoc = normalizeDoc(destRaw).doc;

        console.log(
            `Destination currently holds: ${describeDoc(destDoc)}`
        );

        if (!(await confirmOverwrite())) {
            console.log("Aborted — nothing was written.");
            await source.close();
            await dest.close();
            return;
        }
    }


    // ---- Write and verify ---------------------------------

    await dest.saveAll(doc);

    const verify = normalizeDoc(
        await dest.loadAll()
    ).doc;

    if (
        stableStringify(verify) !==
        stableStringify(doc)
    ) {
        fail(
            "Verification failed: destination does not match " +
            `source (first difference at ${
                firstDivergingPath(doc, verify) ?? "?"
            }).`
        );
    }

    console.log(
        `Transferred and verified: ${describeDoc(doc)}.`
    );

    await source.close();
    await dest.close();
}


main().catch(error => {
    console.error("Migration failed:", error.message);
    process.exit(1);
});
