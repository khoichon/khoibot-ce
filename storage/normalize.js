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
        badwordlog: "info",
        welcomeMsgEnabled: false,
        welcomeMsg: DEFAULT_WELCOME_MSG,
        gamesEnabled: true
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

    settings.gamesEnabled =
        coerceBoolean(raw.gamesEnabled, true);

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


    for (const key of Object.keys(raw)) {
        if (!(key in settings)) {
            settings[key] = raw[key];
        }
    }


    return {
        settings,
        changed: !isEqual(raw, settings)
    };
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
    DEFAULT_WELCOME_MSG,
    defaultConfig,
    defaultGroupSettings,
    normalizeDoc,
    normalizeGroupSettings,
    isValidBadwordlog,
    stableStringify,
    isEqual
};
