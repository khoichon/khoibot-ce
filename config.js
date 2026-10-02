const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(
    __dirname,
    "bot-config.json"
);


// ============================================================
// Default configuration
// ============================================================

const defaultConfig = {
    trusted: [],
    enabledGroups: [],
    groupSettings: {}
};


let config;


// ============================================================
// Persistence
// ============================================================

function save() {
    fs.writeFileSync(
        CONFIG_FILE,
        JSON.stringify(config, null, 4),
        "utf8"
    );
}


function load() {

    // Create config if it doesn't exist
    if (!fs.existsSync(CONFIG_FILE)) {

        config = structuredClone(
            defaultConfig
        );

        save();

        return;
    }


    try {

        config = JSON.parse(
            fs.readFileSync(
                CONFIG_FILE,
                "utf8"
            )
        );


        // Make old config files compatible
        config.trusted ??= [];
        config.enabledGroups ??= [];
        config.groupSettings ??= {};


        // Make sure they're actually arrays/objects
        if (!Array.isArray(config.trusted)) {
            config.trusted = [];
        }

        if (!Array.isArray(config.enabledGroups)) {
            config.enabledGroups = [];
        }

        if (
            typeof config.groupSettings !== "object" ||
            config.groupSettings === null ||
            Array.isArray(config.groupSettings)
        ) {
            config.groupSettings = {};
        }


    } catch (error) {

        console.error(
            "Failed to load bot-config.json:"
        );

        console.error(error);

        console.log(
            "Using default configuration."
        );


        config = structuredClone(
            defaultConfig
        );

        save();
    }
}


// ============================================================
// Save after command execution
// ============================================================

function commandExecuted() {
    save();
}


// ============================================================
// Trusted users
// ============================================================

function isTrusted(identifier) {

    if (!identifier) {
        return false;
    }

    return config.trusted.includes(
        identifier
    );
}


function addTrusted(identifier) {

    if (!identifier) {
        return false;
    }


    if (
        config.trusted.includes(
            identifier
        )
    ) {
        return false;
    }


    config.trusted.push(
        identifier
    );

    save();

    return true;
}


function removeTrusted(identifier) {

    if (!identifier) {
        return false;
    }


    const oldLength =
        config.trusted.length;


    config.trusted =
        config.trusted.filter(
            id => id !== identifier
        );


    const changed =
        config.trusted.length !== oldLength;


    if (changed) {
        save();
    }


    return changed;
}


function getTrusted() {

    return [
        ...config.trusted
    ];
}


// ============================================================
// Enabled groups
// ============================================================

function isGroupEnabled(groupId) {

    if (!groupId) {
        return false;
    }


    return config.enabledGroups.includes(
        groupId
    );
}


function enableGroup(groupId) {

    if (!groupId) {
        return false;
    }


    if (
        config.enabledGroups.includes(
            groupId
        )
    ) {
        return false;
    }


    config.enabledGroups.push(
        groupId
    );

    save();

    return true;
}


function disableGroup(groupId) {

    if (!groupId) {
        return false;
    }


    const oldLength =
        config.enabledGroups.length;


    config.enabledGroups =
        config.enabledGroups.filter(
            id => id !== groupId
        );


    const changed =
        config.enabledGroups.length !== oldLength;


    if (changed) {
        save();
    }


    return changed;
}


function getEnabledGroups() {

    return [
        ...config.enabledGroups
    ];
}


function getConfigSnapshot() {

    return structuredClone(config);
}


// ============================================================
// Group settings
// ============================================================

function getGroupSettings(groupId) {

    if (!groupId) {
        return {};
    }


    // Create default settings
    // for a group if necessary.
    if (
        !config.groupSettings[groupId]
    ) {

        config.groupSettings[groupId] = {
            antibadword: false,
            badwordlog: "info",
            welcomeMsgEnabled: false,
            welcomeMsg: "Welcome to the group, [user]!",
            gamesEnabled: true
        };
    }
        // Check all the config values and set defaults if necessary
        if (
            config.groupSettings[groupId].antibadword === undefined ||
            typeof config.groupSettings[groupId].antibadword !== "boolean"
        ) {
            config.groupSettings[groupId].antibadword = false;
        }

        if (
            config.groupSettings[groupId].gamesEnabled === undefined ||
            typeof config.groupSettings[groupId].gamesEnabled !== "boolean"
        ) {
            config.groupSettings[groupId].gamesEnabled = true;
        }

        if (
            config.groupSettings[groupId].welcomeMsgEnabled === undefined ||
            typeof config.groupSettings[groupId].welcomeMsgEnabled !== "boolean"
        ) {
            config.groupSettings[groupId].welcomeMsgEnabled = false;
        }

        if (
            config.groupSettings[groupId].welcomeMsg === undefined ||
            typeof config.groupSettings[groupId].welcomeMsg !== "string"
        ) {
            config.groupSettings[groupId].welcomeMsg = "Welcome to the group, [user]!";
        }

        if (
            config.groupSettings[groupId].badwordlog === undefined ||
            !["silent", "info", "debug"].includes(config.groupSettings[groupId].badwordlog)
        ) {
            config.groupSettings[groupId].badwordlog = "info";
        }
        save();

    return config.groupSettings[groupId];
}


function getGroupSetting(
    groupId,
    setting
) {

    const settings =
        getGroupSettings(groupId);


    return settings[setting];
}


function setGroupSetting(
    groupId,
    setting,
    value
) {

    if (!groupId) {
        return false;
    }


    if (
        !config.groupSettings[groupId]
    ) {

        config.groupSettings[groupId] = {
            antibadword: false,
            badwordlog: "info",
            welcomeMsgEnabled: false,
            welcomeMsg: "Welcome to the group, [user]!",
            gamesEnabled: true
        };
    }

    if (
        setting === "badwordlog" &&
        !["silent", "info", "debug"].includes(value)
    ) {
        config.groupSettings[groupId].badwordlog = "info";
        save();
        return false;
    }

    config.groupSettings[groupId][setting] =
        value;


    save();

    return true;
}


// ============================================================
// Load configuration
// ============================================================

load();


// ============================================================
// Exports
// ============================================================

module.exports = {

    // Trusted users
    isTrusted,
    addTrusted,
    removeTrusted,
    getTrusted,

    // Groups
    isGroupEnabled,
    enableGroup,
    disableGroup,
    getEnabledGroups,
    getConfigSnapshot,

    // Group settings
    getGroupSettings,
    getGroupSetting,
    setGroupSetting,

    // Persistence
    commandExecuted
};