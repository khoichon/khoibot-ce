// needs ENABLE_TTSCSS=1, the playwright-core package and a chromium on the machine.

const fs = require("node:fs");
const path = require("node:path");

const TEMPLATE = path.join(__dirname, "sticker.html");
const BROWSER_PATHS = ["/usr/bin/chromium", "/usr/bin/chromium-browser"];
const MAX_CSS_LENGTH = 600;
const RENDER_LIMIT_MS = 30 * 1000;

function enabled() {
    return process.env.ENABLE_TTSCSS === "1";
}

function browserPath() {
    if (process.env.TTSCSS_BROWSER) {
        return process.env.TTSCSS_BROWSER;
    }
    return BROWSER_PATHS.find(file => fs.existsSync(file)) || null;
}

const BLOCKED = /[{}<>\\@]|url\s*\(|image\s*\(|image-set\s*\(|src\s*\(|element\s*\(|cross-fade\s*\(|expression|javascript|behavior|binding/i;

function cssProblem(css) {
    if (css.length > MAX_CSS_LENGTH) {
        return `That is too long, ${MAX_CSS_LENGTH} characters is the most.`;
    }
    if (BLOCKED.test(css)) {
        return "Curly brackets, @rules, url() and a few other things are not allowed.";
    }
    return null;
}

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

let busy = false;

async function render(options) {
    let playwright;
    try {
        playwright = require("playwright-core");
    } catch {
        throw codedError("NOPLAYWRIGHT", "playwright-core is not installed.");
    }

    const executablePath = browserPath();
    if (!executablePath) {
        throw codedError("NOBROWSER", "No Chromium found.");
    }
    if (busy) {
        throw codedError("BUSY", "Another sticker is being made.");
    }
    busy = true;

    let browser;
    let timer;
    try {
        const template = fs.readFileSync(TEMPLATE, "utf8");
        const args = ["--disable-gpu", "--disable-dev-shm-usage"];
        if (process.env.TTSCSS_NO_SANDBOX === "1") {
            args.push("--no-sandbox");
        }
        browser = await playwright.chromium.launch({ executablePath, headless: true, args });

        timer = setTimeout(() => browser.close().catch(() => {}), RENDER_LIMIT_MS);

        const context = await browser.newContext({
            viewport: { width: 512, height: 512 },
            deviceScaleFactor: 1,
            serviceWorkers: "block"
        });
        await context.route("**/*", route => route.abort());

        const page = await context.newPage();
        await page.setContent(template, { waitUntil: "load" });
        await page.evaluate(values => window.renderSticker(values), options);
        await page.evaluate(() => document.fonts.ready);
        return await page.screenshot({
            type: "png",
            omitBackground: true,
            clip: { x: 0, y: 0, width: 512, height: 512 }
        });
    } finally {
        clearTimeout(timer);
        busy = false;
        await browser?.close().catch(() => {});
    }
}

module.exports = { enabled, cssProblem, render };
