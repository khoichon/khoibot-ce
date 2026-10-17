// ============================================================
// Canonical config document: defaults, validation, repair
// ============================================================
// Single source of truth for the shape of the bot's persisted
// configuration. Everything that reads or writes config data
// goes through normalizeDoc()/normalizeGroupSettings() so a
// document from any backend (or an old bot-config.json) ends
// up identical in memory.

const DOC_VERSION = 1;

const BADWORDLOG_LEVELS = [
    "silent",
    "info",
    "debug"
];

// what the bot can do when someone reaches the warning limit
const WARN_ACTIONS = ["kick", "ban", "notify"];

// warnaction used to be one word, now it can be a list. an old single word still works.
// the old none is called notify now. it can be stacked with kick and ban like the rest
function normalizeWarnActions(raw) {
    const renamed = (Array.isArray(raw) ? raw : [raw]).map(action => (action === "none" ? "notify" : action));
    const picked = [...new Set(renamed.filter(action => WARN_ACTIONS.includes(action)))];
    return picked.length ? picked : ["notify"];
}

const DEFAULT_WELCOME_MSG =
    "Welcome to the group, [user]!";


function defaultConfig() {
    return {
        version: DOC_VERSION,
        trusted: [],
        enabledGroups: [],
        groupSettings: {}
    };
}


function defaultGroupSettings() {
    return {
        antibadword: false,
        // like antibadword but it never says anything in the chat
        antibadwordnosay: false,
        badwordlog: "info",
        welcomeMsgEnabled: false,
        welcomeMsg: DEFAULT_WELCOME_MSG,
        gamesenabled: true,
        // !ai imagine is off in every chat until a trusted user turns it on
        aiImagine: false,
        // deletes messages with links in them
        disablelinking: false,
        // same as disablelinking but it never says anything in the chat
        disablelinkingnosay: false,
        // domains to block, empty means every link gets blocked. subdomains count as the main domain
        linkblocklist: [],
        // domains that are never blocked, even when the blocklist or block-everything rule would catch them
        linkwhitelist: [],
        // admins and trusted people can post links even when linking is disabled
        linkexempt: true,
        // turns the warn commands on or off in this group
        warntoggle: true,
        // how many warnings it takes before the bot does something
        warnlimit: 3,
        // what happens at the limit: kick, ban or notify (it just announces it). they can all be used together
        warnaction: ["notify"],
        // how long a warn ban lasts in milliseconds, 0 means until someone unbans them
        warnbanduration: 0,
        // warnings older than this many days stop counting, 0 means they never expire
        warnexpiry: 0,
        // how many deleted curse messages in the window before a warning, 0 means off, null means the WARN_CURSES_DEFAULT from .env is used
        warncurses: null,
        // how many minutes that window lasts, null means the WARN_CURSES_TIME_DEFAULT from .env is used
        warncursestime: null,
        // tags: for trusted-only people to control, and allows them to change the enabled and sensitive features of khoibot
        tags: [],
        // the edgy ai personality preset stays hidden until a group turns it on with !mod edgypreset
        edgypreset: false,
        // antibadword's "if this is incorrect, please report it" if it is enabled or nah
        antibadwordreport: false
    };
}


// Accepts real booleans and the string spellings "true"/"false"
// (older bot-config.json files may contain the string form after
// the !mod bug); anything else falls back to the default.
function coerceBoolean(value, fallback) {

    if (typeof value === "boolean") {
        return value;
    }

    if (value === "true") {
        return true;
    }

    if (value === "false") {
        return false;
    }

    return fallback;
}


// Returns { settings, changed } for a single group's settings
// object. `raw` may be undefined (new group), a partial object
// (older config files), or contain wrong-typed values.
function normalizeGroupSettings(raw) {

    const settings = defaultGroupSettings();

    if (
        typeof raw !== "object" ||
        raw === null ||
        Array.isArray(raw)
    ) {
        return {
            settings,
            changed: raw !== undefined
        };
    }


    // Backfill/repair each known field. Unknown extra fields are
    // preserved untouched.
    settings.antibadword =
        coerceBoolean(raw.antibadword, false);

    settings.antibadwordnosay =
        coerceBoolean(raw.antibadwordnosay, false);

    settings.gamesenabled =
        coerceBoolean(raw.gamesenabled ?? raw.gamesEnabled, true);

    settings.aiImagine =
        coerceBoolean(raw.aiImagine, false);

    settings.welcomeMsgEnabled =
        coerceBoolean(raw.welcomeMsgEnabled, false);

    settings.welcomeMsg =
        typeof raw.welcomeMsg === "string"
            ? raw.welcomeMsg
            : DEFAULT_WELCOME_MSG;

    settings.badwordlog =
        BADWORDLOG_LEVELS.includes(raw.badwordlog)
            ? raw.badwordlog
            : "info";

    settings.disablelinking =
        coerceBoolean(raw.disablelinking, false);

    settings.disablelinkingnosay =
        coerceBoolean(raw.disablelinkingnosay, false);

    settings.linkexempt =
        coerceBoolean(raw.linkexempt, true);

    settings.linkblocklist =
        cleanDomainList(raw.linkblocklist);

    settings.linkwhitelist =
        cleanDomainList(raw.linkwhitelist);

    settings.warntoggle =
        coerceBoolean(raw.warntoggle, true);

    settings.warnlimit =
        Number.isInteger(raw.warnlimit) && raw.warnlimit >= 1 && raw.warnlimit <= 20
            ? raw.warnlimit
            : 3;

    settings.warnaction = normalizeWarnActions(raw.warnaction);

    settings.warnbanduration =
        Number.isInteger(raw.warnbanduration) && raw.warnbanduration >= 0
            ? raw.warnbanduration
            : 0;

    settings.warnexpiry =
        Number.isInteger(raw.warnexpiry) && raw.warnexpiry >= 0 && raw.warnexpiry <= 365
            ? raw.warnexpiry
            : 0;


    // null means the group never set it, so the default from .env gets used when its needed
    settings.warncurses =
        Number.isInteger(raw.warncurses) && raw.warncurses >= 0 && raw.warncurses <= 50
            ? raw.warncurses
            : null;

    settings.warncursestime =
        Number.isInteger(raw.warncursestime) && raw.warncursestime >= 1 && raw.warncursestime <= 60
            ? raw.warncursestime
            : null;

    settings.edgypreset =
        coerceBoolean(raw.edgypreset, false);

    settings.tags = Array.isArray(raw.tags)
        ? raw.tags.filter(tag => typeof tag === "string" && tag.trim() !== "")
        : [];

    settings.antibadwordreport = coerceBoolean(raw.antibadwordreport, false);

    for (const key of Object.keys(raw)) {
        if (!(key in settings)) {
            settings[key] = raw[key];
        }
    }

    // the old camelCase key isnt used anymore so we drop it
    delete settings.gamesEnabled;


    return {
        settings,
        changed: !isEqual(raw, settings)
    };
}


// keeps only the strings from a list, so a messed up config cant crash the link check
function cleanDomainList(value) {
    return Array.isArray(value)
        ? value.filter(item => typeof item === "string")
        : [];
}

function isValidBadwordlog(value) {
    return BADWORDLOG_LEVELS.includes(value);
}


// Returns { doc, changed } where `changed` is true whenever
// normalization backfilled or repaired anything (so callers can
// decide whether the repaired form needs flushing back to the
// backend).
function normalizeDoc(raw) {

    const doc = defaultConfig();

    if (
        typeof raw !== "object" ||
        raw === null ||
        Array.isArray(raw)
    ) {
        return {
            doc,
            changed: false
        };
    }


    doc.version = DOC_VERSION;

    if (Array.isArray(raw.trusted)) {
        doc.trusted = raw.trusted.filter(
            id => typeof id === "string"
        );
    }

    if (Array.isArray(raw.enabledGroups)) {
        doc.enabledGroups = raw.enabledGroups.filter(
            id => typeof id === "string"
        );
    }

    if (
        typeof raw.groupSettings === "object" &&
        raw.groupSettings !== null &&
        !Array.isArray(raw.groupSettings)
    ) {
        for (const groupId of Object.keys(raw.groupSettings)) {
            doc.groupSettings[groupId] =
                normalizeGroupSettings(
                    raw.groupSettings[groupId]
                ).settings;
        }
    }


    return {
        doc,
        changed: !isEqual(raw, doc)
    };
}


function isEqual(a, b) {
    return stableStringify(a) === stableStringify(b);
}


// JSON stringify with recursively sorted object keys, so two
// documents containing the same data always compare equal
// regardless of key order.
function stableStringify(value) {

    if (
        typeof value !== "object" ||
        value === null
    ) {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value
            .map(item => stableStringify(item))
            .join(",")}]`;
    }

    const keys = Object.keys(value).sort();

    return `{${keys
        .map(
            key =>
                `${JSON.stringify(key)}:` +
                stableStringify(value[key])
        )
        .join(",")}}`;
}


module.exports = {
    DOC_VERSION,
    BADWORDLOG_LEVELS,
WARN_ACTIONS,
    DEFAULT_WELCOME_MSG,
    defaultConfig,
    defaultGroupSettings,
    normalizeDoc,
    normalizeGroupSettings,
    isValidBadwordlog,
    stableStringify,
    isEqual
};
