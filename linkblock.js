// decides if a message has a link that should be deleted. this file only checks,
// index.js is the one that actually deletes the message

const dns = require("node:dns");

// this one is never blocked, no matter what the group settings say
const ALWAYS_ALLOWED = "khoichon.dev";

// how long a dns answer gets remembered, so the same link posted over and over doesnt hit the dns servers every time
const CACHE_MS = 10 * 60 * 1000;

// the most domains we look up in one message, anything past that just counts as blocked so nobody can make the pi spam dns
const MAX_LOOKUPS = 5;

// short timeout so a dead dns server cant hold the whole bot up
const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
const cache = new Map();

// something dot something, like apple.com or www.apple.com/page. the ending has to be letters, so 3.14 and 1.5x are fine
const WEBSITE_LIKE = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![a-z0-9-])/gi;

// these two errors mean the dns servers answered and said it isnt there. anything else (timeout, servfail, offline) means they didnt really answer
const NOT_THERE = new Set(["ENOTFOUND", "ENODATA"]);

// turns whatever an admin typed (https://www.Apple.com/store) into a plain domain (apple.com), or null if it doesnt look like one
function cleanDomain(input) {
    let host = String(input || "").trim().toLowerCase();
    host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
    host = host.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.+$/, "");
    const valid = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(host);
    return valid ? host : null;
}

// a listed domain covers its subdomains too, so apple.com also catches music.apple.com but not pineapple.com
function matches(host, domain) {
    return host === domain || host.endsWith("." + domain);
}

function isListed(host, list) {
    return (list || []).some(domain => matches(host, domain));
}

function isAlwaysAllowed(host) {
    return matches(host, ALWAYS_ALLOWED);
}

// asks dns for the address and mail records of one name. "yes", "no", or "unsure" when the servers never really answered
async function lookupName(name) {
    const answers = await Promise.allSettled([
        resolver.resolve4(name),
        resolver.resolve6(name),
        resolver.resolveMx(name)
    ]);
    if (answers.some(answer => answer.status === "fulfilled")) {
        return "yes";
    }
    return answers.some(answer => !NOT_THERE.has(answer.reason?.code)) ? "unsure" : "no";
}

// is this a real domain? tries the name as typed, then each parent, so a made up subdomain of a real site still counts as that site
async function domainStatus(host) {
    const cached = cache.get(host);
    if (cached && Date.now() - cached.time < CACHE_MS) {
        return cached.status;
    }

    let status = "no";
    const labels = host.split(".");
    for (let start = 0; start <= labels.length - 2; start += 1) {
        const found = await lookupName(labels.slice(start).join("."));
        if (found === "yes") {
            status = "yes";
            break;
        }
        if (found === "unsure") {
            status = "unsure";
        }
    }

    // an unsure answer is probably the dns being down for a moment, so dont remember it
    if (status !== "unsure") {
        cache.set(host, { status, time: Date.now() });
    }
    return status;
}

// returns the first domain in the text that should be blocked, or null if the message is fine.
// the whitelist always wins. with a blocklist only those domains are blocked, without one every real domain is
async function findBlockedLink(text, { blocklist = [], whitelist = [] } = {}) {
    const found = new Set(String(text).toLowerCase().match(WEBSITE_LIKE) || []);
    let lookups = 0;

    for (const host of found) {
        if (isAlwaysAllowed(host) || isListed(host, whitelist)) {
            continue;
        }

        if (blocklist.length > 0) {
            // admin named it, so no need to ask dns if its real
            if (isListed(host, blocklist)) {
                return host;
            }
            continue;
        }

        if (lookups >= MAX_LOOKUPS) {
            return host;
        }
        lookups += 1;

        // "no" means dns says it doesnt exist (index.js, hi.how), anything else gets blocked, even when dns is down
        if (await domainStatus(host) !== "no") {
            return host;
        }
    }

    return null;
}

module.exports = {
    ALWAYS_ALLOWED,
    cleanDomain,
    isAlwaysAllowed,
    findBlockedLink
};
