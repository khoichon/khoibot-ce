const dns = require("node:dns").promises;
const net = require("node:net");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { domainToASCII } = require("node:url");
const { Readable } = require("node:stream");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { reply } = require("./utils.js");
const { getGroupSetting } = require("./config.js");
const { log } = require("./logging.js");
const antiban = require("./antiban.js");

const execFileAsync = promisify(execFile);

const SEARCH_TIMEOUT_MS = 8000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 2;
const SNIPPET_LENGTH = 120;
const MAX_PAGE_BYTES = 1500000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_GIF_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 8;
const READ_LENGTH = 4000;
const TLDR_SOURCE_LENGTH = 12000;
const MAX_REPLY_LENGTH = 3500;
const SCREENSHOT_TIMEOUT_MS = 20000;
const ALLOWED_PORTS = new Set(["80", "443", "8080", "8443"]);
const USER_AGENT = "Mozilla/5.0 (compatible; khoibot)";

const busy = { screenshot: false, gif: false, tldr: false, audio: false, video: false };

function webEnabled() {
    return process.env.ENABLE_WEB === "1";
}

function searxngUrl() {
    return (process.env.SEARXNG_URL || "http://127.0.0.1:8888").replace(/\/+$/, "");
}

function argsOf(text) {
    return text.trim().replace(/^\S+\s*/, "");
}

function shorten(text, length) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > length ? `${clean.slice(0, length).trimEnd()}...` : clean;
}


class UserError extends Error { }
class BlockedError extends Error { }

function checkLength(text) {
    if (text.length > MAX_QUERY_LENGTH) {
        throw new UserError(`That is too long (${MAX_QUERY_LENGTH} characters maximum).`);
    }
}

function withTyping(handler, presence = "composing") {
    return async (sock, msg, ctx) => {
        const chatId = msg.key.remoteJid;
        const send = (state) => Promise.resolve().then(() => sock.sendPresenceUpdate(state, chatId)).catch(() => {});
        send(presence);
        const timer = setInterval(() => send(presence), 8000);
        try {
            return await handler(sock, msg, ctx);
        } finally {
            clearInterval(timer);
            send("paused");
        }
    };
}

function command(handler, failMessage = "That did not work. Please try again later.") {
    return async (sock, msg, ctx) => {
        try {
            return await handler(sock, msg, ctx);
        } catch (error) {
            let message = failMessage;
            if (error instanceof UserError) {
                message = error.message;
            } else if (error instanceof BlockedError) {
                message = "That address is not a public website, so I cannot open it.";
            } else if (error?.name === "TimeoutError" || error?.name === "AbortError") {
                message = "That took too long. Please try again later.";
            } else if (error?.code === "ENOTFOUND") {
                message = "I could not find that address.";
            } else {
                log.error("web", `${ctx.text.trim().split(/\s+/)[0]} failed:`, error);
            }
            await reply(sock, msg, message);
            return true;
        }
    };
}

function usage(sock, msg, ctx, text) {
    return reply(sock, msg, `Usage: ${ctx.commandPrefix}${text}`);
}

async function search(query, options = {}) {
    const { limit = MAX_RESULTS, categories, safesearch = 1, terms = query, snippetLength = SNIPPET_LENGTH } = typeof options === "number" ? { limit: options } : options;

    const url = new URL(`${searxngUrl()}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", String(safesearch));
    if (categories) {
        url.searchParams.set("categories", categories);
    }

    const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`searxng answered ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data.results)) {
        throw new Error("searxng sent back something *odd* (coff coff)");
    }

    return data.results
        .filter(result => typeof result.url === "string" && /^https?:\/\//i.test(result.url))
        .filter(result => hasEveryWord(terms, result.title, result.content, result.url))
        .slice(0, limit)
        .map(result => ({
            title: shorten(result.title, 100).replace(/\*/g, "") || result.url,
            url: result.url,
            snippet: shorten(result.content, snippetLength),
            image: typeof result.img_src === "string" && /^https?:\/\//i.test(result.img_src) ? result.img_src : "",
            date: /^\d{4}-\d\d-\d\d/.test(result.publishedDate || "") ? result.publishedDate.slice(0, 10) : ""
        }));
}

function plain(text) {
    return String(text || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function hasEveryWord(query, ...texts) {
    const haystack = plain(texts.join(" "));
    const words = plain(query).match(/[\p{L}\p{N}]+/gu) || [];
    return words.every(word => word.length > 2
        ? haystack.includes(word)
        : new RegExp(`(^|[^\\p{L}\\p{N}])${word}($|[^\\p{L}\\p{N}])`, "u").test(haystack));
}

function formatResults(heading, results) {
    const lines = results.map((result, index) => {
        const date = result.date ? ` (${result.date})` : "";
        const snippet = result.snippet ? `\n${result.snippet}` : "";
        return `${index + 1}. *${result.title}*${date}\n${result.url}${snippet}`;
    });
    return `${heading}\n\n${lines.join("\n\n")}`;
}

function searchCommand({ name, heading, defaultQuery, options = {}, wrap = query => query }) {
    return async (sock, msg, ctx) => {
        const query = argsOf(ctx.text) || defaultQuery;
        if (!query) {
            return usage(sock, msg, ctx, `${name} <query>`);
        }
        checkLength(query);

        const results = await search(wrap(query), { ...options, terms: argsOf(ctx.text) });
        if (!results.length) {
            return reply(sock, msg, `No results were found for "${query}".`);
        }
        return reply(sock, msg, formatResults(`${heading} "${query}":`, results));
    };
}


function isPublicIp(ip) {
    const kind = net.isIP(ip);
    if (kind === 4) {
        const [a, b, c] = ip.split(".").map(Number);
        if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
        if (a === 100 && b >= 64 && b <= 127) return false;
        if (a === 169 && b === 254) return false;
        if (a === 172 && b >= 16 && b <= 31) return false;
        if (a === 192 && b === 168) return false;
        if (a === 192 && b === 0 && c === 0) return false;
        if (a === 198 && (b === 18 || b === 19)) return false;
        return true;
    }
    if (kind === 6) {
        const lower = ip.toLowerCase();
        if (lower === "::" || lower === "::1" || lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:")) return false;
        if (/^f[cd]/.test(lower) || /^fe[89abc]/.test(lower) || lower.startsWith("ff")) return false;
        if (lower.startsWith("2001:db8") || lower.startsWith("2002:")) return false;
        return true;
    }
    return false;
}

function bareHost(hostname) {
    return hostname.replace(/^\[|\]$/g, "");
}

async function resolvePublic(hostname) {
    const host = bareHost(hostname);
    if (net.isIP(host)) {
        if (!isPublicIp(host)) {
            throw new BlockedError();
        }
        return [host];
    }
    const records = await dns.lookup(host, { all: true });
    if (!records.length || records.some(record => !isPublicIp(record.address))) {
        throw new BlockedError();
    }
    return records.map(record => record.address);
}

function parseWebUrl(input) {
    let text = input.trim().replace(/^<|>$/g, "");
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        text = `https://${text}`;
    }

    let url;
    try {
        url = new URL(text);
    } catch {
        throw new UserError("That does not look like a link.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new UserError("Only http and https links work.");
    }
    if (url.username || url.password) {
        throw new UserError("Links behind a login are not allowed.");
    }
    if (url.port && !ALLOWED_PORTS.has(url.port)) {
        throw new UserError("That port is not allowed.");
    }
    if (!url.hostname.includes(".") && !url.hostname.includes(":")) {
        throw new UserError("That does not look like a link.");
    }
    return url;
}

function pinnedFetch(url, address, { method = "GET", headers = {}, timeout = FETCH_TIMEOUT_MS, body } = {}) {
    return new Promise((resolve, reject) => {
        const family = net.isIP(address);
        const client = url.protocol === "https:" ? https : http;
        const request = client.request(url, {
            method,
            headers: { "accept-encoding": "identity", ...headers },
            signal: AbortSignal.timeout(timeout),
            lookup: (hostname, options, callback) => {
                if (options && options.all) {
                    callback(null, [{ address, family }]);
                } else {
                    callback(null, address, family);
                }
            }
        }, res => {
            const answerHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
                for (const item of [].concat(value)) {
                    try {
                        answerHeaders.append(name, item);
                    } catch {
                    }
                }
            }
            if (method === "HEAD" || [204, 205, 304].includes(res.statusCode)) {
                res.resume();
                resolve(new Response(null, { status: res.statusCode, headers: answerHeaders }));
                return;
            }
            resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: answerHeaders }));
        });
        request.on("error", reject);
        request.end(body);
    });
}

async function safeFetch(start, { method = "GET", headers = {}, timeout = FETCH_TIMEOUT_MS, trace = [] } = {}) {
    let url = parseWebUrl(start);
    for (let hop = 0; ; hop++) {
        const [address] = await resolvePublic(url.hostname);
        const response = await pinnedFetch(url, address, {
            method,
            headers: { "user-agent": USER_AGENT, ...headers },
            timeout
        });
        trace.push({ url: url.href, status: response.status });

        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
            await response.body?.cancel();
            if (hop >= MAX_REDIRECTS) {
                throw new UserError("That link redirects too many times.");
            }
            url = parseWebUrl(new URL(location, url).href);
            continue;
        }
        return { response, url };
    }
}

// reads a body but stops at maxBytes. truncate keeps what we have, otherwise its an error
async function readLimited(response, maxBytes, truncate) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel();
            if (!truncate) {
                throw new UserError("That file is too big.");
            }
            chunks.push(value.subarray(0, value.length - (total - maxBytes)));
            break;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}

function decodeEntities(text) {
    const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
        if (code[0] === "#") {
            const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
        }
        const key = code.toLowerCase();
        return Object.hasOwn(named, key) ? named[key] : whole;
    });
}

function pageTitle(html) {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? shorten(decodeEntities(match[1]), 150) : "";
}

function htmlToText(html) {
    const stripped = html
        .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<\/?(br|p|div|li|ul|ol|tr|section|article|header|footer|h[1-6])\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ");
    return decodeEntities(stripped)
        .replace(/[ \t\f\v\u00a0]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// gives back { url, title, text } for a link, throws a UserError when its not a readable page
async function fetchPage(input) {
    const { response, url } = await safeFetch(input, { headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1" } });
    if (!response.ok) {
        await response.body?.cancel();
        throw new UserError(`That site answered ${response.status}.`);
    }

    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (type && !/^(text\/|application\/(xhtml\+xml|xml|json))/.test(type)) {
        await response.body?.cancel();
        throw new UserError(`That link is not a web page (${type}).`);
    }

    const raw = (await readLimited(response, MAX_PAGE_BYTES, true)).toString("utf8");
    const isHtml = !type || type.includes("html");
    return {
        url: url.href,
        title: isHtml ? pageTitle(raw) : "",
        text: isHtml ? htmlToText(raw) : raw.trim()
    };
}

async function downloadImage(url, allowedTypes, maxBytes) {
    try {
        const { response } = await safeFetch(url, { headers: { accept: "image/*" } });
        const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!response.ok || !allowedTypes.includes(type)) {
            await response.body?.cancel();
            return null;
        }
        return { buffer: await readLimited(response, maxBytes, false), type };
    } catch (error) {
        if (error instanceof UserError || error instanceof BlockedError || error?.name === "TimeoutError") {
            return null;
        }
        throw error;
    }
}

async function getJson(url, { headers = {}, allow404 = false } = {}) {
    const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (allow404 && response.status === 404) {
        return null;
    }
    if (!response.ok) {
        const error = new Error(`${new URL(url).host} answered ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

function sendImage(sock, msg, image, caption) {
    return sock.sendMessage(msg.key.remoteJid, { image, caption }, { quoted: msg });
}

function number(value) {
    return Number(value).toLocaleString("en-US");
}

//youtube!!

async function handleYoutube(sock, msg, ctx) {
    const query = argsOf(ctx.text);
    if (!query) {
        return usage(sock, msg, ctx, "youtube <query>");
    }
    checkLength(query);

    const isYoutube = result => /^https?:\/\/((www|m)\.)?(youtube\.com|youtu\.be)\//i.test(result.url);
    let results = (await search(query, { categories: "videos", limit: 20 })).filter(isYoutube);
    if (!results.length) {
        results = (await search(`site:youtube.com ${query}`, { limit: 20, terms: query })).filter(isYoutube);
    }
    results = results.slice(0, MAX_RESULTS);

    if (!results.length) {
        return reply(sock, msg, `No videos were found for "${query}".`);
    }
    return reply(sock, msg, formatResults(`Videos for "${query}":`, results));
}


async function handleHn(sock, msg, ctx) {
    const query = argsOf(ctx.text);
    checkLength(query);

    const url = new URL("https://hn.algolia.com/api/v1/search");
    if (query) {
        url.searchParams.set("query", query);
        url.searchParams.set("tags", "story");
    } else {
        url.searchParams.set("tags", "front_page");
    }
    url.searchParams.set("hitsPerPage", String(query ? 30 : MAX_RESULTS));

    const data = await getJson(url);
    const hits = (data.hits || []).filter(hit => hit.title && hasEveryWord(query, hit.title, hit.url)).slice(0, MAX_RESULTS);
    if (!hits.length) {
        return reply(sock, msg, `No stories were found for "${query}".`);
    }

    const lines = hits.map((hit, index) => {
        const discussion = `https://news.ycombinator.com/item?id=${hit.objectID}`;
        const link = hit.url ? `${hit.url}\n` : "";
        return `${index + 1}. *${shorten(hit.title, 100).replace(/\*/g, "")}*\n${link}${number(hit.points || 0)} points, ${number(hit.num_comments || 0)} comments: ${discussion}`;
    });
    return reply(sock, msg, `${query ? `Hacker News stories for "${query}":` : "Hacker News front page:"}\n\n${lines.join("\n\n")}`);
}


async function handleRead(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "read <link>");
    }

    const page = await fetchPage(input);
    if (!page.text) {
        return reply(sock, msg, "I could not find any text on that page.");
    }
    const more = page.text.length > READ_LENGTH ? "..." : "";
    const title = page.title ? `*${page.title.replace(/\*/g, "")}*\n` : "";
    return reply(sock, msg, `${title}${page.url}\n\n${page.text.slice(0, READ_LENGTH).trimEnd()}${more}`);
}

async function handleTldr(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "tldr <link>");
    }
    if (busy.tldr) {
        return reply(sock, msg, "I am still summarising another page. Please wait a moment.");
    }

    busy.tldr = true;
    try {
        const page = await fetchPage(input);
        if (page.text.length < 200) {
            return reply(sock, msg, "That page has too little text to summarise.");
        }
        await reply(sock, msg, "Reading that page, this can take a minute.");

        const { summarizeText } = require("./aitools.js");
        const summary = (await summarizeText(page.text.slice(0, TLDR_SOURCE_LENGTH))).trim();
        if (!summary) {
            return reply(sock, msg, "The model gave me an empty summary. Try again.");
        }
        const title = page.title ? `*${page.title.replace(/\*/g, "")}*\n` : "";
        return reply(sock, msg, `${title}${page.url}\n\n${summary.slice(0, MAX_REPLY_LENGTH)}`);
    } finally {
        busy.tldr = false;
    }
}


async function traceLink(input) {
    const trace = [];
    let stopped = "";
    try {
        const { response } = await safeFetch(input, { method: "HEAD", trace });
        await response.body?.cancel();
        if (response.status === 405 || response.status === 501) {
            trace.length = 0;
            const retry = await safeFetch(input, { trace });
            await retry.response.body?.cancel();
        }
    } catch (error) {
        if (!(error instanceof UserError) || !trace.length) {
            throw error;
        }
        stopped = error.message;
    }
    return { trace, stopped };
}

async function handleExpand(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "expand <link>");
    }

    const { trace, stopped } = await traceLink(input);
    if (stopped) {
        return reply(sock, msg, stopped);
    }
    if (trace.length === 1) {
        return reply(sock, msg, "That link does not redirect anywhere.");
    }
    return reply(sock, msg, `That link ends up at:\n${trace[trace.length - 1].url}`);
}

async function handleRedirects(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "redirects <link>");
    }

    const { trace, stopped } = await traceLink(input);
    const lines = trace.map((hop, index) => `${index + 1}. ${hop.url} (${hop.status})`);
    const heading = trace.length === 1 ? "That link does not redirect." : `${trace.length - 1} redirect(s):`;
    return reply(sock, msg, `${heading}\n\n${lines.join("\n")}${stopped ? `\n\n${stopped}` : ""}`);
}


function browserPath() {
    const candidates = [process.env.TTSCSS_BROWSER, "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (!found) {
        throw new UserError("Chromium is not installed on this machine, so I cannot take screenshots.");
    }
    return found;
}

async function handleScreenshot(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "screenshot <link>");
    }
    if (busy.screenshot) {
        return reply(sock, msg, "I am still taking another screenshot. Please wait a moment.");
    }

    busy.screenshot = true;
    let browser;
    try {
        const url = parseWebUrl(input);
        await resolvePublic(url.hostname);
        const executablePath = browserPath();

        const { chromium } = require("playwright-core");
        browser = await chromium.launch({
            executablePath,
            args: process.env.TTSCSS_NO_SANDBOX === "1" ? ["--no-sandbox"] : []
        });
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });

       await context.route("**/*", async route => {
            try {
                const request = route.request();
                const target = new URL(request.url());
                if (target.protocol === "data:" || target.protocol === "blob:") {
                    return await route.continue();
                }
                if (target.protocol !== "http:" && target.protocol !== "https:") {
                    return await route.abort();
                }
                const [address] = await resolvePublic(target.hostname);
                const sent = {};
                for (const [name, value] of Object.entries(request.headers())) {
                    if (!["host", "connection", "content-length", "accept-encoding"].includes(name)) {
                        sent[name] = value;
                    }
                }
                const response = await pinnedFetch(target, address, { method: request.method(), headers: sent, body: request.postDataBuffer() || undefined });
                const body = await readLimited(response, MAX_PAGE_BYTES * 4, false);
                const answer = {};
                for (const [name, value] of response.headers) {
                    if (!["transfer-encoding", "content-length", "connection", "keep-alive", "set-cookie"].includes(name)) {
                        answer[name] = value;
                    }
                }
                const cookies = response.headers.getSetCookie();
                if (cookies.length) {
                    answer["set-cookie"] = cookies.join("\n");
                }
                await route.fulfill({ status: response.status, headers: answer, body });
            } catch {
                await route.abort().catch(() => { });
            }
        });
        if (typeof context.routeWebSocket === "function") {
            await context.routeWebSocket("**/*", () => { });
        }

        const page = await context.newPage();
        await page.goto(url.href, { waitUntil: "load", timeout: SCREENSHOT_TIMEOUT_MS });
        await page.waitForTimeout(1000);
        const image = await page.screenshot({ type: "jpeg", quality: 80 });
        await sendImage(sock, msg, image, url.href);
    } catch (error) {
        if (error instanceof UserError || error instanceof BlockedError) {
            throw error;
        }
        log.error("web", "Could not take a screenshot:", error);
        return reply(sock, msg, "I could not load that page for a screenshot.");
    } finally {
        busy.screenshot = false;
        if (browser) {
            await browser.close().catch(() => { });
        }
    }
}


async function handleArchive(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "archive <link>");
    }

    const target = parseWebUrl(input).href;
    const data = await getJson(`https://archive.org/wayback/available?url=${encodeURIComponent(target)}`);
    const snapshot = data?.archived_snapshots?.closest;
    if (snapshot?.available && snapshot.url) {
        const stamp = String(snapshot.timestamp || "");
        const date = /^\d{8}/.test(stamp) ? ` (saved ${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)})` : "";
        return reply(sock, msg, `The closest saved copy${date}:\n${snapshot.url.replace(/^http:/, "https:")}`);
    }
    return reply(sock, msg, `The archive has no copy of that page yet. You can ask it to save one here:\nhttps://web.archive.org/save/${target}`);
}


async function handleIsup(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "isup <site>");
    }

    const target = parseWebUrl(input);
    const started = Date.now();
    try {
        let { response, url } = await safeFetch(target.href, { method: "HEAD" });
        await response.body?.cancel();
        if (response.status === 405 || response.status === 501) {
            ({ response, url } = await safeFetch(target.href));
            await response.body?.cancel();
        }

        const ms = Date.now() - started;
        const moved = url.hostname === target.hostname ? "" : ` (it sent me on to ${url.hostname})`;
        if (response.status >= 500) {
            return reply(sock, msg, `${target.hostname} is answering, but with an error (${response.status}) after ${ms} ms.`);
        }
        return reply(sock, msg, `${target.hostname} is up. It answered ${response.status} in ${ms} ms${moved}.`);
    } catch (error) {
        if (error instanceof UserError || error instanceof BlockedError) {
            throw error;
        }
        const why = error?.name === "TimeoutError" ? "it did not answer in time" : "I could not connect to it";
        return reply(sock, msg, `${target.hostname} looks down from here, ${why}.`);
    }
}

// how long a tcp connection takes, in ms null when it fails
function tcpTime(address, port, timeout = 3000) {
    return new Promise(resolve => {
        const started = process.hrtime.bigint();
        const socket = net.connect({ host: address, port });
        const finish = value => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeout);
        socket.once("connect", () => finish(Math.round(Number(process.hrtime.bigint() - started) / 1e6)));
        socket.once("timeout", () => finish(null));
        socket.once("error", () => finish(null));
    });
}

async function handlePinghost(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "pinghost <host>");
    }

    const host = parseWebUrl(input).hostname;
    const [address] = await resolvePublic(host);

    for (const port of [443, 80]) {
        const times = [];
        for (let attempt = 0; attempt < 3; attempt++) {
            const ms = await tcpTime(address, port);
            if (ms !== null) {
                times.push(ms);
            }
        }
        if (times.length) {
            const average = Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length);
            return reply(sock, msg, `${bareHost(host)} (${address}) answered on port ${port}.\n${times.length}/3 tries worked: ${times.map(ms => `${ms} ms`).join(", ")} (average ${average} ms)`);
        }
    }
    return reply(sock, msg, `${bareHost(host)} (${address}) did not answer on port 443 or 80.`);
}

function parseDomain(input) {
    const cleaned = input.trim().replace(/^https?:\/\//i, "").replace(/[/?#].*$/, "").replace(/\.$/, "");
    const domain = domainToASCII(cleaned).toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/.test(domain)) {
        throw new UserError("That does not look like a domain name.");
    }
    return domain;
}

function rdapDate(data, action) {
    const event = (data.events || []).find(item => item.eventAction === action);
    return event?.eventDate ? event.eventDate.slice(0, 10) : "";
}

function rdapRegistrar(data) {
    const entity = (data.entities || []).find(item => (item.roles || []).includes("registrar"));
    const card = entity?.vcardArray?.[1] || [];
    return card.find(field => field[0] === "fn")?.[3] || "";
}

async function handleWhois(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "whois <domain>");
    }

    const domain = parseDomain(input);
    const data = await getJson(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { allow404: true });
    if (!data) {
        return reply(sock, msg, `I could not find registration info for ${domain}. Some endings do not share it.`);
    }

    const lines = [`*${domain}*`];
    const registrar = rdapRegistrar(data);
    if (registrar) lines.push(`Registrar: ${registrar}`);
    const created = rdapDate(data, "registration");
    if (created) lines.push(`Registered: ${created}`);
    const updated = rdapDate(data, "last changed");
    if (updated) lines.push(`Last changed: ${updated}`);
    const expires = rdapDate(data, "expiration");
    if (expires) lines.push(`Expires: ${expires}`);
    if (data.status?.length) lines.push(`Status: ${data.status.slice(0, 3).join(", ")}`);
    const servers = (data.nameservers || []).map(server => String(server.ldhName || "").toLowerCase()).filter(Boolean);
    if (servers.length) lines.push(`Nameservers: ${servers.slice(0, 4).join(", ")}`);
    return reply(sock, msg, lines.join("\n"));
}

const DNS_TYPES = ["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA"];

async function lookupRecords(domain, type) {
    try {
        const records = await dns.resolve(domain, type);
        if (type === "MX") {
            return records.sort((a, b) => a.priority - b.priority).map(record => `${record.priority} ${record.exchange}`);
        }
        if (type === "TXT") {
            return records.map(parts => shorten(parts.join(""), 100));
        }
        if (type === "SOA") {
            return [`${records.nsname} ${records.hostmaster}`];
        }
        return records.map(String);
    } catch (error) {
        if (["ENODATA", "ENOTFOUND", "ESERVFAIL", "EREFUSED", "ENOTIMP", "EBADRESP"].includes(error.code)) {
            return [];
        }
        throw error;
    }
}

async function handleDns(sock, msg, ctx) {
    const [first, second] = argsOf(ctx.text).split(/\s+/);
    if (!first) {
        return usage(sock, msg, ctx, "dns <domain> [A|AAAA|MX|NS|TXT|CNAME|SOA]");
    }

    const domain = parseDomain(first);
    const wanted = (second || "").toUpperCase();
    if (wanted && !DNS_TYPES.includes(wanted)) {
        throw new UserError(`I only know these record types: ${DNS_TYPES.join(", ")}.`);
    }

    const types = wanted ? [wanted] : ["A", "AAAA", "MX", "NS", "TXT"];
    const answers = await Promise.all(types.map(async type => [type, await lookupRecords(domain, type)]));
    const lines = answers
        .filter(([, records]) => records.length)
        .map(([type, records]) => `${type}: ${records.slice(0, 4).join(", ")}${records.length > 4 ? ` (+${records.length - 4} more)` : ""}`);
    if (!lines.length) {
        return reply(sock, msg, `No ${wanted ? `${wanted} ` : ""}records were found for ${domain}.`);
    }
    return reply(sock, msg, `*${domain}*\n${lines.join("\n")}`);
}

async function handleIp(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "ip <address or domain>");
    }
    checkLength(input);

    let address = bareHost(input.trim());
    let from = "";
    if (!net.isIP(address)) {
        const domain = parseDomain(input);
        const records = await dns.lookup(domain, { all: true });
        if (!records.length) {
            throw new UserError(`I could not find ${domain}.`);
        }
        address = records[0].address;
        from = `${domain} points to ${address}\n`;
    }
    if (!isPublicIp(address)) {
        throw new UserError("That is a private address, there is nothing to look up.");
    }

    const data = await getJson(`https://ipwho.is/${encodeURIComponent(address)}`);
    if (!data.success) {
        throw new UserError("I could not look that address up.");
    }

    const lines = [`${from}*${data.ip}*`];
    const place = [data.city, data.region, data.country].filter(Boolean).join(", ");
    if (place) lines.push(`Location: ${place}`);
    const network = data.connection?.org || data.connection?.isp;
    if (network) lines.push(`Network: ${network}${data.connection?.asn ? ` (AS${data.connection.asn})` : ""}`);
    if (data.timezone?.id) lines.push(`Timezone: ${data.timezone.id}`);
    lines.push("The location is only a rough guess.");
    return reply(sock, msg, lines.join("\n"));
}

async function handleGithub(sock, msg, ctx) {
    const input = argsOf(ctx.text).replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").replace(/\.git$/i, "");
    const [owner, repo] = input.split("/").filter(Boolean);
    if (!owner) {
        return usage(sock, msg, ctx, "github <user> or github <user>/<repo>");
    }
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || (repo && !/^[A-Za-z0-9._-]{1,100}$/.test(repo))) {
        throw new UserError("That does not look like a GitHub name.");
    }

    let data;
    try {
        const url = repo
            ? `https://api.github.com/repos/${owner}/${repo}`
            : `https://api.github.com/users/${owner}`;
        data = await getJson(url, { allow404: true, headers: { accept: "application/vnd.github+json" } });
    } catch (error) {
        if (error.status === 403 || error.status === 429) {
            throw new UserError("GitHub is rate limiting the bot right now. Try again in a bit.");
        }
        throw error;
    }
    if (!data) {
        throw new UserError("I could not find that on GitHub.");
    }

    if (repo) {
        const lines = [`*${data.full_name}*`];
        if (data.description) lines.push(shorten(data.description, 200));
        lines.push(`Stars: ${number(data.stargazers_count)}, forks: ${number(data.forks_count)}, open issues: ${number(data.open_issues_count)}`);
        const extra = [data.language, data.license?.spdx_id && data.license.spdx_id !== "NOASSERTION" ? data.license.spdx_id : ""].filter(Boolean);
        if (extra.length) lines.push(extra.join(", "));
        if (data.pushed_at) lines.push(`Last push: ${data.pushed_at.slice(0, 10)}`);
        lines.push(data.html_url);
        return reply(sock, msg, lines.join("\n"));
    }

    const lines = [`*${data.name || data.login}* (${data.login})`];
    if (data.bio) lines.push(shorten(data.bio, 200));
    lines.push(`Repos: ${number(data.public_repos)}, followers: ${number(data.followers)}, following: ${number(data.following)}`);
    if (data.created_at) lines.push(`Joined: ${data.created_at.slice(0, 10)}`);
    lines.push(data.html_url);
    return reply(sock, msg, lines.join("\n"));
}

async function gifToMp4(buffer) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "khoibot-gif-"));
    try {
        const input = path.join(dir, "in.gif");
        const output = path.join(dir, "out.mp4");
        await fs.promises.writeFile(input, buffer);
        await execFileAsync("ffmpeg", [
            "-y", "-i", input, "-t", "10", "-an",
            "-movflags", "faststart", "-pix_fmt", "yuv420p",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            output
        ], { timeout: 30000 });
        return await fs.promises.readFile(output);
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

async function handleGif(sock, msg, ctx) {
    const query = argsOf(ctx.text);
    if (!query) {
        return usage(sock, msg, ctx, "gif <query>");
    }
    checkLength(query);
    if (busy.gif) {
        return reply(sock, msg, "I am still sending another gif. Please wait a moment.");
    }

    busy.gif = true;
    try {
        const results = await search(`${query} gif`, { categories: "images", limit: 20, safesearch: 2, terms: query });
        const candidates = results.filter(result => /\.gif(\?|$)/i.test(result.image)).slice(0, 3);
        if (!candidates.length) {
            return reply(sock, msg, `I could not find a gif for "${query}".`);
        }

        for (const candidate of candidates) {
            const gif = await downloadImage(candidate.image, ["image/gif"], MAX_GIF_BYTES);
            if (!gif) {
                continue;
            }
            try {
                const video = await gifToMp4(gif.buffer);
                return await sock.sendMessage(msg.key.remoteJid, { video, gifPlayback: true, caption: query }, { quoted: msg });
            } catch (error) {
                log.error("web", "Could not turn a gif into a video, is ffmpeg installed?", error);
                return reply(sock, msg, `Here is a gif for "${query}":\n${candidate.image}`);
            }
        }
        return reply(sock, msg, `I found some gifs for "${query}", but none of them could be downloaded.`);
    } finally {
        busy.gif = false;
    }
}

async function handleImage(sock, msg, ctx) {
    const query = argsOf(ctx.text);
    if (!query) {
        return usage(sock, msg, ctx, "image <query>");
    }
    checkLength(query);

    const results = await search(query, { categories: "images", limit: 15, safesearch: 2 });
    const candidates = results.filter(result => result.image).slice(0, 4);
    if (!candidates.length) {
        return reply(sock, msg, `I could not find a picture for "${query}".`);
    }

    for (const candidate of candidates) {
        const picture = await downloadImage(candidate.image, ["image/jpeg", "image/png", "image/webp"], MAX_IMAGE_BYTES);
        if (picture) {
            return sendImage(sock, msg, picture.buffer, `${query}\n${candidate.url}`);
        }
    }
    return reply(sock, msg, `I found pictures for "${query}", but none of them could be downloaded. Here is one:\n${candidates[0].image}`);
}


async function handlePokemon(sock, msg, ctx) {
    const input = argsOf(ctx.text).toLowerCase().replace(/\s+/g, "-");
    if (!input) {
        return usage(sock, msg, ctx, "pokemon <name or number>");
    }
    if (!/^[a-z0-9.'-]{1,40}$/.test(input)) {
        throw new UserError("That does not look like a pokemon name.");
    }

    const data = await getJson(`https://pokeapi.co/api/v2/pokemon/${encodeURIComponent(input)}`, { allow404: true });
    if (!data) {
        throw new UserError("I could not find that pokemon.");
    }

    const stat = key => data.stats.find(item => item.stat.name === key)?.base_stat ?? "?";
    const caption = [
        `*${data.name.replace(/(^|-)([a-z])/g, (whole, dash, letter) => `${dash ? " " : ""}${letter.toUpperCase()}`)}* (#${data.id})`,
        `Type: ${data.types.map(item => item.type.name).join(", ")}`,
        `Height: ${data.height / 10} m, weight: ${data.weight / 10} kg`,
        `Abilities: ${data.abilities.map(item => item.ability.name).join(", ")}`,
        `HP ${stat("hp")}, attack ${stat("attack")}, defense ${stat("defense")}, sp. atk ${stat("special-attack")}, sp. def ${stat("special-defense")}, speed ${stat("speed")}`
    ].join("\n");

    const art = data.sprites?.other?.["official-artwork"]?.front_default || data.sprites?.front_default;
    const picture = art ? await downloadImage(art, ["image/png", "image/jpeg", "image/webp"], MAX_IMAGE_BYTES) : null;
    if (picture) {
        return sendImage(sock, msg, picture.buffer, caption);
    }
    return reply(sock, msg, caption);
}

async function handleQr(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "qr <text or link>");
    }
    if (input.length > 300) {
        throw new UserError("That is too long for a qr code (300 characters maximum).");
    }

    const response = await fetch(`https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=10&data=${encodeURIComponent(input)}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok || !(response.headers.get("content-type") || "").startsWith("image/")) {
        throw new Error(`the qr service answered ${response.status}`);
    }
    return sendImage(sock, msg, await readLimited(response, MAX_IMAGE_BYTES, false), input);
}

async function handleFlight(sock, msg, ctx) {
    const callsign = argsOf(ctx.text).replace(/\s+/g, "").toUpperCase();
    if (!callsign) {
        return usage(sock, msg, ctx, "flight <flight number>, for example flight SIA321");
    }
    if (!/^[A-Z0-9]{2,8}$/.test(callsign)) {
        throw new UserError("That does not look like a flight number. Try something like SIA321.");
    }

    const data = await getJson(`https://api.adsbdb.com/v0/callsign/${callsign}`, { allow404: true });
    const route = data?.response?.flightroute;
    if (!route) {
        throw new UserError(`I could not find a route for ${callsign}.`);
    }

    const airport = place => place ? `${place.name} (${place.iata_code || place.icao_code}), ${[...new Set([place.municipality, place.country_name].filter(Boolean))].join(", ")}` : "unknown";
    const lines = [`*${route.callsign_iata || route.callsign}*${route.airline?.name ? ` (${route.airline.name})` : ""}`];
    lines.push(`From: ${airport(route.origin)}`);
    lines.push(`To: ${airport(route.destination)}`);
    lines.push("This is the usual route for that flight number, not live status.");
    return reply(sock, msg, lines.join("\n"));
}


const WEATHER_CODES = {
    0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light showers", 81: "showers", 82: "heavy showers", 85: "snow showers", 86: "snow showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail"
};

function describeWeather(code) {
    return WEATHER_CODES[code] || "unknown";
}

async function handleWeather(sock, msg, ctx) {
    const [first, hours, ...place] = argsOf(ctx.text).split(/\s+/);
    if ((first || "").toLowerCase() !== "forecast") {
        return false;
    }

    const location = place.join(" ").trim();
    if ((hours !== "7" && hours !== "24") || !location) {
        return usage(sock, msg, ctx, "weather forecast <7|24> <location>");
    }
    checkLength(location);

    const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(location)}`);
    const found = geo.results?.[0];
    if (!found) {
        throw new UserError(`I could not find a place called "${location}".`);
    }

    const forecast = new URL("https://api.open-meteo.com/v1/forecast");
    forecast.searchParams.set("latitude", found.latitude);
    forecast.searchParams.set("longitude", found.longitude);
    forecast.searchParams.set("timezone", "auto");
    if (hours === "7") {
        forecast.searchParams.set("forecast_days", "7");
        forecast.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
    } else {
        forecast.searchParams.set("forecast_days", "2");
        forecast.searchParams.set("hourly", "weather_code,temperature_2m,precipitation_probability");
    }
    const data = await getJson(forecast);

    const name = [...new Set([found.name, found.admin1, found.country].filter(Boolean))].join(", ");
    const lines = [];

    if (hours === "7") {
        const daily = data.daily;
        for (let i = 0; i < daily.time.length; i++) {
            const day = new Date(`${daily.time[i]}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
            lines.push(`${day}: ${Math.round(daily.temperature_2m_min[i])} to ${Math.round(daily.temperature_2m_max[i])} C, rain ${daily.precipitation_probability_max[i] ?? 0}%, ${describeWeather(daily.weather_code[i])}`);
        }
        return reply(sock, msg, `*7 day forecast for ${name}*\n${lines.join("\n")}`);
    }

    const here = new Date(Date.now() + (data.utc_offset_seconds || 0) * 1000).toISOString().slice(0, 13);
    const start = Math.max(0, data.hourly.time.findIndex(time => time.slice(0, 13) >= here));
    for (let i = start; i < start + 24 && i < data.hourly.time.length; i += 3) {
        lines.push(`${data.hourly.time[i].slice(11, 16)}: ${Math.round(data.hourly.temperature_2m[i])} C, rain ${data.hourly.precipitation_probability[i] ?? 0}%, ${describeWeather(data.hourly.weather_code[i])}`);
    }
    return reply(sock, msg, `*Next 24 hours for ${name}* (local time)\n${lines.join("\n")}`);
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const MAX_AUDIO_SECONDS = 30 * 60;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const YTDLP_TIMEOUT_MS = 2 * 60 * 1000;

async function youtubeTarget(input) {
    if (/^https?:\/\//i.test(input)) {
        const url = parseWebUrl(input);
        if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
            throw new UserError("Only YouTube links work here.");
        }
        return url.href;
    }
    const stdout = await runYtdlp(["--flat-playlist", "--print", "%(id)s\t%(title)s\t%(channel,uploader)s", "--", `ytsearch15:${input}`], { search: true });
    for (const line of stdout.split("\n")) {
        const [id, title, channel] = line.split("\t");
        if (/^[\w-]{11}$/.test(id) && hasEveryWord(input, title, channel)) {
            return `https://www.youtube.com/watch?v=${id}`;
        }
    }
    throw new UserError(`I could not find a video with "${shorten(input, 50)}" in it.`);
}

const PICK_COUNT = 5;
const PICK_TTL_MS = 5 * 60 * 1000;
const pending = new Map();

async function searchYoutube(input) {
    const stdout = await runYtdlp(["--flat-playlist", "--print", "%(id)s\t%(title)s\t%(channel,uploader)s\t%(duration)s", "--", `ytsearch${PICK_COUNT}:${input}`], { search: true });
    return stdout.split("\n").map(line => {
        const [id, title, channel, duration] = line.split("\t");
        return { id, title, channel, duration: Number(duration) };
    }).filter(video => /^[\w-]{11}$/.test(video.id));
}

let searching = 0;
const MAX_SEARCHES = 4;
const choosing = new Set();

function pickKey(ctx) {
    return `${ctx.chatId}:${ctx.senderJid}`;
}

async function chooseVideo(sock, msg, ctx, kind, input) {
    const key = pickKey(ctx);
    if (/^https?:\/\//i.test(input)) {
        pending.delete(key);
        return youtubeTarget(input);
    }
    if (ctx.senderJid === ctx.chatId && ctx.chatId.endsWith("@g.us")) {
        throw new UserError("I cannot tell who you are in this chat, so please send a link instead.");
    }
    if (choosing.has(key)) {
        throw new UserError("I am still working on your last search. Please wait a moment.");
    }
    if (busy[kind === "song" ? "audio" : "video"]) {
        throw new UserError(`I am still downloading another ${kind}. Please wait a moment.`);
    }
    if (searching >= MAX_SEARCHES) {
        throw new UserError("I am searching for other people right now. Please try again in a moment.");
    }

    choosing.add(key);
    try {
        searching++;
        let videos;
        try {
            videos = await searchYoutube(input);
        } finally {
            searching--;
        }
        if (!videos.length) {
            throw new UserError(`I could not find a video with "${shorten(input, 50)}" in it.`);
        }

        const lines = videos.map((video, index) => {
            const length = video.duration > 0 ? ` (${clock(video.duration)})` : "";
            return `${index + 1}. ${shorten(video.title, 70)} - ${shorten(video.channel, 30)}${length}`;
        });
        await reply(sock, msg, `*Results for ${shorten(input, 50)}*\n${lines.join("\n")}\n\nReply with a number from 1 to ${videos.length} to pick one, or cancel to cancel.`);

        for (const [oldKey, old] of pending) {
            if (old.expires <= Date.now()) {
                pending.delete(oldKey);
            }
        }
        pending.set(key, { kind, videos, expires: Date.now() + PICK_TTL_MS });
    } finally {
        choosing.delete(key);
    }
    return null;
}

async function runYtdlp(args, { search = false } = {}) {
    try {
        const { stdout } = await execFileAsync(process.env.YTDLP_PATH || "yt-dlp", ["--ignore-config", "--no-warnings", ...(search ? [] : ["--no-playlist"]), ...args], {
            timeout: YTDLP_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024
        });
        return stdout;
    } catch (error) {
        if (error.code === "ENOENT") {
            throw new UserError("yt-dlp is not installed on the bot's machine yet.");
        }
        if (error.killed) {
            throw new UserError("That took too long. Please try again later.");
        }
        throw error;
    }
}

function clock(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = String(Math.floor(totalSeconds % 60)).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

async function handleYtinfo(sock, msg, ctx) {
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "ytinfo <youtube link or search>");
    }
    checkLength(input);
    const target = await youtubeTarget(input);

    let video;
    try {
        const stdout = await runYtdlp(["--dump-json", "--skip-download", "--", target]);
        video = JSON.parse(stdout.trim().split("\n")[0]);
    } catch (error) {
        if (!(error instanceof UserError) || !target.startsWith("http")) {
            throw error;
        }
        const data = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`);
        return reply(sock, msg, `*${shorten(data.title, 100).replace(/\*/g, "")}*\nChannel: ${data.author_name}\n${target}`);
    }

    const lines = [`*${shorten(video.title, 100).replace(/\*/g, "")}*`];
    if (video.channel || video.uploader) lines.push(`Channel: ${video.channel || video.uploader}`);
    if (video.duration) lines.push(`Length: ${clock(video.duration)}`);
    if (video.view_count !== undefined && video.view_count !== null) lines.push(`Views: ${number(video.view_count)}`);
    if (/^\d{8}$/.test(video.upload_date || "")) lines.push(`Uploaded: ${video.upload_date.slice(0, 4)}-${video.upload_date.slice(4, 6)}-${video.upload_date.slice(6, 8)}`);
    lines.push(video.webpage_url || target);
    return reply(sock, msg, lines.join("\n"));
}

async function downloadsAllowed(sock, msg, { chatId, isGroup }) {
    if (isGroup && getGroupSetting(chatId, "downloadmedia") === false) {
        await reply(sock, msg, "A moderator has turned off song and video downloads in this group.");
        return false;
    }
    return true;
}

const MAX_VIDEO_SECONDS = 10 * 60;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

async function handleDownloadVideo(sock, msg, ctx) {
    if (!await downloadsAllowed(sock, msg, ctx)) {
        return;
    }
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "video <youtube link or search>");
    }
    checkLength(input);
    const target = await chooseVideo(sock, msg, ctx, "video", input);
    if (!target) {
        return;
    }
    return sendVideo(sock, msg, target);
}

async function sendVideo(sock, msg, target, onSent) {
    if (busy.video) {
        return reply(sock, msg, "I am still downloading another video. Please wait a moment.");
    }

    busy.video = true;
    let dir = "";
    try {
        dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "khoibot-video-"));
        const stdout = await runYtdlp([
            "--match-filter", `duration<=${MAX_VIDEO_SECONDS}`,
            "--max-filesize", String(MAX_VIDEO_BYTES),
            "-f", "bv*[height<=480][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/b[height<=480][vcodec^=avc1][ext=mp4]/b[vcodec^=avc1][ext=mp4]",
            "--merge-output-format", "mp4",
            "--print", "%(title)s\t%(duration)s\t%(view_count)s", "--no-simulate",
            "-o", path.join(dir, "video.%(ext)s"),
            "--", target
        ]);

        const file = (await fs.promises.readdir(dir)).find(name => name.endsWith(".mp4"));
        const video = file ? await fs.promises.readFile(path.join(dir, file)) : null;
        if (!video || video.length > MAX_VIDEO_BYTES) {
            throw new UserError("That video is too long or too big (10 minutes and 40 MB maximum).");
        }
        const [title, seconds, views] = (stdout.trim().split("\n").pop() || "").split("\t");
        const lines = [shorten(title, 100)];
        if (Number(seconds) > 0) lines.push(`Duration: ${clock(Number(seconds))}`);
        if (views && views !== "NA") lines.push(`Views: ${number(views)}`);
        await sock.sendMessage(msg.key.remoteJid, { video, mimetype: "video/mp4", caption: lines.join("\n") }, { quoted: msg });
        onSent?.();
    } finally {
        busy.video = false;
        if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}

async function handleSong(sock, msg, ctx) {
    if (!await downloadsAllowed(sock, msg, ctx)) {
        return;
    }
    const input = argsOf(ctx.text);
    if (!input) {
        return usage(sock, msg, ctx, "song <youtube link or search>");
    }
    checkLength(input);
    const target = await chooseVideo(sock, msg, ctx, "song", input);
    if (!target) {
        return;
    }
    return sendSong(sock, msg, target);
}

async function sendSong(sock, msg, target, onSent) {
    if (busy.audio) {
        return reply(sock, msg, "I am still downloading another song. Please wait a moment.");
    }

    busy.audio = true;
    let dir = "";
    try {
        dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "khoibot-audio-"));
        const stdout = await runYtdlp([
            "--match-filter", `duration<=${MAX_AUDIO_SECONDS}`,
            "--max-filesize", String(MAX_AUDIO_BYTES),
            "-x", "--audio-format", "mp3", "--audio-quality", "5",
            "--print", "title", "--no-simulate",
            "-o", path.join(dir, "audio.%(ext)s"),
            "--", target
        ]);

        const file = (await fs.promises.readdir(dir)).find(name => name.endsWith(".mp3"));
        if (!file) {
            throw new UserError("That video is too long or too big (30 minutes and 50 MB maximum).");
        }
        const audio = await fs.promises.readFile(path.join(dir, file));
        const title = shorten(stdout.trim().split("\n").pop() || "", 100);
        await sock.sendMessage(msg.key.remoteJid, { audio, mimetype: "audio/mpeg" }, { quoted: msg });
        onSent?.();
        if (title) {
            await reply(sock, msg, title);
        }
    } finally {
        busy.audio = false;
        if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}

const COMMANDS = {
    "!websearch": command(searchCommand({ name: "websearch", heading: "Results for" }), "The web search failed. Please try again later."),
    "!news": command(searchCommand({ name: "news", heading: "News for", defaultQuery: "world news", options: { categories: "news" } })),
    "!reddit": command(searchCommand({ name: "reddit", heading: "Reddit posts for", wrap: query => `site:reddit.com ${query}` })),
    "!youtube": command(handleYoutube),
    "!hn": command(handleHn),
    "!read": command(handleRead),
    "!tldr": command(handleTldr, "I could not summarise that page. Please try again later."),
    "!expand": command(handleExpand),
    "!redirects": command(handleRedirects),
    "!screenshot": command(handleScreenshot),
    "!archive": command(handleArchive),
    "!isup": command(handleIsup),
    "!pinghost": command(handlePinghost),
    "!whois": command(handleWhois),
    "!dns": command(handleDns),
    "!ip": command(handleIp),
    "!github": command(handleGithub),
    "!gif": command(handleGif),
    "!image": command(handleImage),
    "!pokemon": command(handlePokemon),
    "!qr": command(handleQr),
    "!flight": command(handleFlight),
    "!weather": command(handleWeather),
    "!ytinfo": command(handleYtinfo),
    "!song": command(withTyping(handleSong, "recording"), "I could not download that. Please try again later."),
    "!video": command(withTyping(handleDownloadVideo), "I could not download that. Please try again later.")
};

const PICKERS = {
    song: command(withTyping((sock, msg, ctx) => sendSong(sock, msg, ctx.target, ctx.onSent), "recording"), "I could not download that. Please try again later."),
    video: command(withTyping((sock, msg, ctx) => sendVideo(sock, msg, ctx.target, ctx.onSent)), "I could not download that. Please try again later.")
};

async function handlePick(sock, msg, ctx) {
    if (!webEnabled()) {
        return false;
    }

    const key = pickKey(ctx);
    const saved = pending.get(key);
    if (!saved) {
        return false;
    }
    if (saved.expires <= Date.now()) {
        pending.delete(key);
        return false;
    }

    const answer = String(ctx.text || "").trim().toLowerCase();
    if (answer === "cancel") {
        pending.delete(key);
        await reply(sock, msg, "Cancelled.");
        return true;
    }
    if (!/^\d$/.test(answer)) {
        return false;
    }

    const video = saved.videos[Number(answer) - 1];
    if (!video) {
        await reply(sock, msg, `Reply with a number from 1 to ${saved.videos.length}, or reply cancel.`);
        return true;
    }

    if (antiban.commandsOff({ trusted: ctx.trusted })) {
        return true;
    }
    if (saved.working) {
        return true;
    }
    saved.working = true;
    let sent = false;
    try {
        if (!await downloadsAllowed(sock, msg, ctx)) {
            return true;
        }
        await PICKERS[saved.kind](sock, msg, { ...ctx, text: `!${saved.kind} ${answer}`, target: `https://www.youtube.com/watch?v=${video.id}`, onSent: () => { sent = true; } });
    } finally {
        saved.working = false;
        if (sent && pending.get(key) === saved) {
            pending.delete(key);
        }
    }
    return true;
}

async function handleCommand(sock, msg, ctx) {
    if (!webEnabled()) {
        return false;
    }

    const name = ctx.text.trim().split(/\s+/)[0].toLowerCase();
    if (!Object.hasOwn(COMMANDS, name)) {
        return false;
    }

    return (await COMMANDS[name](sock, msg, ctx)) !== false;
}

module.exports = { handleCommand, handlePick, search, fetchPage, webEnabled };
