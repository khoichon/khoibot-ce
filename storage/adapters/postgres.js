// ============================================================
// Postgres / Supabase adapter
// ============================================================
// Talks plain Postgres wire protocol, so it works with any
// Postgres server and with Supabase (point STORAGE_URL at the
// connection string from Project Settings -> Database). DDL
// runs on init, so Supabase projects need no manual setup.

const TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS bot_config (
        id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        trusted        jsonb NOT NULL,
        enabled_groups jsonb NOT NULL,
        group_settings jsonb NOT NULL,
        updated_at     timestamptz NOT NULL DEFAULT now()
    )
`;

const UPSERT_SQL = `
    INSERT INTO bot_config
        (id, trusted, enabled_groups, group_settings)
    VALUES (1, $1::jsonb, $2::jsonb, $3::jsonb)
    ON CONFLICT (id) DO UPDATE SET
        trusted        = EXCLUDED.trusted,
        enabled_groups = EXCLUDED.enabled_groups,
        group_settings = EXCLUDED.group_settings,
        updated_at     = now()
`;


function requireWrapper() {

    try {
        return require("pg");
    } catch (error) {
        throw new Error(
            'Backend "postgres" requires the "pg" package. ' +
            "Install with: npm install pg"
        );
    }
}


// Supabase (and most hosted Postgres) require TLS. Only opt in
// automatically for remote hosts without an explicit sslmode.
function needsSsl(url) {

    let parsed;

    try {
        parsed = new URL(url);
    } catch (error) {
        return false;
    }

    const localHosts = [
        "localhost",
        "127.0.0.1",
        "::1"
    ];

    if (localHosts.includes(parsed.hostname)) {
        return false;
    }

    return !parsed.searchParams.has("sslmode");
}


module.exports = {
    name: "postgres",
    aliases: ["supabase"],

    create(url) {

        if (!url) {
            throw new Error(
                'Backend "postgres" requires STORAGE_URL, e.g. ' +
                "postgres://user:pass@host:5432/postgres"
            );
        }

        let pool = null;

        function getPool() {

            if (!pool) {
                pool = new (requireWrapper().Pool)({
                    connectionString: url,
                    max: 2,
                    ...(needsSsl(url)
                        ? { ssl: { rejectUnauthorized: false } }
                        : {})
                });
            }

            return pool;
        }


        return {

            async init() {
                await getPool().query(TABLE_DDL);
            },

            async loadAll() {

                const result = await getPool().query(
                    "SELECT trusted, enabled_groups, group_settings " +
                    "FROM bot_config WHERE id = 1"
                );

                if (result.rows.length === 0) {
                    return null;
                }

                // pg parses jsonb columns into JS values already.
                const row = result.rows[0];

                return {
                    trusted: row.trusted ?? [],
                    enabledGroups: row.enabled_groups ?? [],
                    groupSettings: row.group_settings ?? {}
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
