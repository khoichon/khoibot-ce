// ============================================================
// MySQL / MariaDB adapter
// ============================================================
// Stores the config document as a single row (id = 1) in a
// bot_config table; each collection is a JSON column. One
// adapter serves both databases — they share the MySQL wire
// protocol, so the same mysql2 driver and SQL work for either.

const TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS bot_config (
        id             TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        trusted        JSON NOT NULL,
        enabled_groups JSON NOT NULL,
        group_settings JSON NOT NULL,
        updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                       ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
`;

// VALUES() is deprecated-noticed on MySQL >= 8.0.20 but still
// functional there, and it's the only spelling MariaDB supports
// — deliberate cross-compatibility choice.
const UPSERT_SQL = `
    INSERT INTO bot_config
        (id, trusted, enabled_groups, group_settings)
    VALUES (1, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
        trusted        = VALUES(trusted),
        enabled_groups = VALUES(enabled_groups),
        group_settings = VALUES(group_settings)
`;


function requireDriver() {

    try {
        return require("mysql2/promise");
    } catch (error) {
        throw new Error(
            'Backend "mysql" requires the "mysql2" package. ' +
            "Install with: npm install mysql2"
        );
    }
}


function normalizeUrl(url) {

    // mysql2's URI parser doesn't know the mariadb:// scheme;
    // the protocols are otherwise identical.
    return url.replace(
        /^mariadb:\/\//,
        "mysql://"
    );
}


module.exports = {
    name: "mysql",
    aliases: ["mariadb"],

    create(url) {

        if (!url) {
            throw new Error(
                'Backend "mysql" requires STORAGE_URL, e.g. ' +
                "mysql://user:pass@localhost:3306/khoibot"
            );
        }

        let pool = null;

        function getPool() {

            if (!pool) {
                pool = requireDriver().createPool({
                    uri: normalizeUrl(url),
                    connectionLimit: 2
                });
            }

            return pool;
        }


        return {

            async init() {
                await getPool().query(TABLE_DDL);
            },

            async loadAll() {

                const [rows] = await getPool().query(
                    "SELECT trusted, enabled_groups, group_settings " +
                    "FROM bot_config WHERE id = 1"
                );

                if (rows.length === 0) {
                    return null;
                }

                const row = rows[0];

                // mysql2 returns JSON columns as strings; parse
                // defensively in case a future config parses them.
                return {
                    trusted: parseJsonColumn(row.trusted, []),
                    enabledGroups: parseJsonColumn(row.enabled_groups, []),
                    groupSettings: parseJsonColumn(row.group_settings, {})
                };
            },

            async saveAll(doc) {

                await getPool().query(UPSERT_SQL, [
                    JSON.stringify(doc.trusted ?? []),
                    JSON.stringify(doc.enabledGroups ?? []),
                    JSON.stringify(doc.groupSettings ?? {})
                ]);
            },

            async close() {

                if (pool) {
                    await pool.end();
                    pool = null;
                }
            }
        };
    }
};


function parseJsonColumn(value, fallback) {

    if (typeof value !== "string") {
        return value ?? fallback;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}
