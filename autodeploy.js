const { execFile } = require("child_process");
const { log } = require("./logging.js");

// how often we look for new commits, in minutes
const CHECK_MINUTES = Math.max(1, Number(process.env.AUTO_DEPLOY_MINUTES) || 2);

let started = false;
let busy = false;
// the commit we already failed to pull, so a broken pull doesnt spam the log every check
let failedAt = null;

function git(...args) {
    return run("git", args, 60 * 1000);
}

function run(command, args, timeout) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { cwd: __dirname, timeout }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(String(stderr || error.message).trim()));
            } else {
                resolve(String(stdout).trim());
            }
        });
    });
}

// saves the pm2 process list so the bot comes back after a reboot too.
// only runs under pm2, and if it fails we just log it and restart anyway
async function pm2Save() {
    if (process.env.pm_id === undefined) {
        return;
    }

    try {
        await run("pm2", ["save"], 30 * 1000);
        log.info("deploy", "ran pm2 save");
    } catch (error) {
        log.error("deploy", "pm2 save failed, restarting anyway:", error.message);
    }
}

async function check(beforeRestart) {
    if (busy) {
        return;
    }
    busy = true;

    try {
        await git("fetch", "--quiet");
        const behind = Number(await git("rev-list", "--count", "HEAD..@{u}"));
        if (!behind) {
            return;
        }

        const latest = await git("rev-parse", "@{u}");
        if (latest === failedAt) {
            return;
        }

        const before = await git("rev-parse", "HEAD");
        log.info("deploy", `found ${behind} new commit${behind === 1 ? "" : "s"}, pulling`);
        try {
            await git("pull", "--ff-only");
        } catch (error) {
            failedAt = latest;
            log.error("deploy", "couldnt pull, fix it by hand on the pi:", error.message);
            return;
        }

        const changed = await git("diff", "--name-only", before, "HEAD");
        if (/^package(-lock)?\.json$/m.test(changed)) {
            log.info("deploy", "dependencies changed, running npm install");
            await run("npm", ["install"], 5 * 60 * 1000);
        }

        await pm2Save();

        if (beforeRestart) {
            beforeRestart();
        }
        log.info("deploy", "update finished, restarting the bot");
        process.exit(0);
    } catch (error) {
        log.error("deploy", "auto deploy check failed:", error.message);
    } finally {
        busy = false;
    }
}

// beforeRestart runs right before the process exits, so it can save things like running games
function start({ beforeRestart } = {}) {
    if (started || process.env.ENABLE_AUTO_DEPLOY !== "1") {
        return;
    }
    started = true;

    log.info("deploy", `auto deploy is on, checking github every ${CHECK_MINUTES} minute${CHECK_MINUTES === 1 ? "" : "s"}`);
    setInterval(() => check(beforeRestart), CHECK_MINUTES * 60 * 1000).unref();
}

module.exports = { start };
