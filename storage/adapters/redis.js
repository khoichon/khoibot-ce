// ============================================================
// Redis adapter
// ============================================================
// Stores the whole config document as one JSON string under a
// single key. The document is small and written by a single
// process, so a per-group hash layout would only add
// multi-command complexity for no benefit.

const DEFAULT_PREFIX = "khoibot:v1";


function requireDriver() {

    try {
        return require("ioredis");
    } catch (error) {
        throw new Error(
            'Backend "redis" requires the "ioredis" package. ' +
            "Install with: npm install ioredis"
        );
    }
}


module.exports = {
    name: "redis",
    aliases: [],

    create(url, opts = {}) {

        if (!url) {
            throw new Error(
                'Backend "redis" requires STORAGE_URL, e.g. ' +
                "redis://localhost:6379/0 (rediss://... for TLS)"
            );
        }

        const prefix =
            opts.prefix ||
            process.env.STORAGE_REDIS_PREFIX ||
            DEFAULT_PREFIX;

        const key = `${prefix}:config`;

        let client = null;

        function getClient() {

            if (!client) {
                client = new (requireDriver())(url, {
                    maxRetriesPerRequest: 1,

                    // Give up after a few attempts so a bad URL
                    // or down server surfaces as a startup error
                    // instead of retrying forever.
                    retryStrategy: times =>
                        times > 3
                            ? null
                            : Math.min(times * 200, 1000)
                });
            }

            return client;
        }


        return {

            async init() {
                await getClient().ping();
            },

            async loadAll() {

                const raw = await getClient().get(key);

                if (raw === null) {
                    return null;
                }

                return JSON.parse(raw);
            },

            async saveAll(doc) {
                await getClient().set(
                    key,
                    JSON.stringify(doc)
                );
            },

            async close() {

                if (client) {
                    try {
                        await client.quit();
                    } catch (error) {
                        client.disconnect();
                    }
                    client = null;
                }
            }
        };
    }
};
