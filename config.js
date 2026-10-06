// ============================================================
// Config access layer
// ============================================================
// Reads and mutates the in-memory document owned by the
// write-behind store (storage/store.js), which handles
// persistence to whichever backend is configured. All exported
// functions stay synchronous — exactly as before.

const store = require("./storage/store");

const {
    defaultGroupSettings,
    normalizeGroupSettings,
    isValidBadwordlog
} = require("./storage/normalize");


function getConfig() {
    return store.getStoreDoc();
}


// ============================================================
// Save after command execution
// ============================================================

function commandExecuted() {
    // Persistence is handled by the storage store's write-behind
    // flusher; nothing to do per message anymore. Kept for
    // compatibility with existing callers.
}


// ============================================================
// Trusted users
// ============================================================

function isTrusted(identifier) {

    if (!identifier) {
        return false;
    }

    return getConfig().trusted.includes(
        identifier
    );
}


function addTrusted(identifier) {

    if (!identifier) {
        return false;
    }

    const config = getConfig();

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

    store.markDirty({ immediate: true });

    return true;
}


function removeTrusted(identifier) {

    if (!identifier) {
        return false;
    }

    const config = getConfig();

    const oldLength =
        config.trusted.length;

    config.trusted =
        config.trusted.filter(
            id => id !== identifier
        );

    const changed =
        config.trusted.length !== oldLength;

    if (changed) {
        store.markDirty({ immediate: true });
    }

    return changed;
}


function getTrusted() {

    return [
        ...getConfig().trusted
    ];
}


// ============================================================
// Enabled groups
// ============================================================

function isGroupEnabled(groupId) {

    if (!groupId) {
        return false;
    }

    return getConfig().enabledGroups.includes(
        groupId
    );
}


function enableGroup(groupId) {

    if (!groupId) {
        return false;
    }

    const config = getConfig();

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

    store.markDirty({ immediate: true });

    return true;
}


function disableGroup(groupId) {

    if (!groupId) {
        return false;
    }

    const config = getConfig();

    const oldLength =
        config.enabledGroups.length;

    config.enabledGroups =
        config.enabledGroups.filter(
            id => id !== groupId
        );

    const changed =
        config.enabledGroups.length !== oldLength;

    if (changed) {
        store.markDirty({ immediate: true });
    }

    return changed;
}


function getEnabledGroups() {

    return [
        ...getConfig().enabledGroups
    ];
}


function getConfigSnapshot() {

    return structuredClone(
        getConfig()
    );
}


// ============================================================
// Group settings
// ============================================================

function getGroupSettings(groupId) {

    if (!groupId) {
        return {};
    }

    const config = getConfig();

    // Normalize the stored settings (backfilling defaults and
    // repairing old data) and only flag a write when something
    // actually changed — steady-state reads write nothing.
    //
    // Note: returns the live object, as it always has; use
    // getConfigSnapshot() for a deep copy.
    const { settings, changed } =
        normalizeGroupSettings(
            config.groupSettings[groupId]
        );

    config.groupSettings[groupId] = settings;

    if (changed) {
        store.markDirty();
    }

    return settings;
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

    const config = getConfig();

    if (
        !config.groupSettings[groupId]
    ) {
        config.groupSettings[groupId] =
            defaultGroupSettings();
    }

    if (
        setting === "badwordlog" &&
        !isValidBadwordlog(value)
    ) {
        config.groupSettings[groupId].badwordlog = "info";
        store.markDirty({ immediate: true });
        return false;
    }

    config.groupSettings[groupId][setting] =
        value;

    store.markDirty({ immediate: true });

    return true;
}


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
