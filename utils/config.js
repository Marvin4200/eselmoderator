// Guild-Konfiguration-Cache -- getrimmte Version von fahrstuhl/utils/config.js: nur der
// guild_configs-Teil (jedes Modul liest/schreibt seine Einstellungen ueber denselben JSON-Blob
// pro Guild). Die Troll-spezifischen Teile (user_stats/shields, global_stats) bleiben bei
// Fahrstuhl -- EselModerator braucht sie nicht.
const { initDb, getPool } = require("./db");

let guildConfigCache = {};
let initialized = false;
let lastCacheReloadAt = 0;

async function loadCacheFromDb() {
    const pool = getPool();
    const [guildRows] = await pool.query("SELECT guild_id, config_json FROM guild_configs");
    guildConfigCache = {};
    for (const row of guildRows) {
        try {
            guildConfigCache[row.guild_id] = JSON.parse(row.config_json || "{}") || {};
        } catch (e) {
            guildConfigCache[row.guild_id] = {};
        }
    }
    lastCacheReloadAt = Date.now();
}

async function initConfig() {
    if (initialized) return;
    if (initConfig._promise) return initConfig._promise;

    initConfig._promise = (async () => {
        const host = process.env.MYSQL_HOST || "127.0.0.1";
        const port = Number(process.env.MYSQL_PORT || 3306);
        const user = process.env.MYSQL_USER || "root";
        const password = process.env.MYSQL_PASSWORD || "";
        const database = process.env.MYSQL_DATABASE || "eselmoderator";

        await initDb({ host, port, user, password, database });
        await loadCacheFromDb();

        initialized = true;
        initConfig._promise = null;
    })();

    return initConfig._promise;
}

async function reloadCache() {
    if (!initialized) {
        await initConfig();
        return;
    }
    await loadCacheFromDb();
}

function getGuildConfig(guildId) {
    return guildConfigCache[guildId] || {};
}

function setGuildConfig(guildId, config) {
    const current = guildConfigCache[guildId] || {};
    const merged = { ...current, ...config };
    guildConfigCache[guildId] = merged;

    const pool = getPool();
    pool.query(
        "INSERT INTO guild_configs (guild_id, config_json) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_json = VALUES(config_json)",
        [guildId, JSON.stringify(merged)]
    ).catch((e) => {
        console.error("❌ Database error - setGuildConfig:", {
            guildId,
            operation: "INSERT INTO guild_configs",
            error: e.message,
            code: e.code,
            timestamp: new Date().toISOString(),
        });
        guildConfigCache[guildId] = current;
    });
}

function getCacheStatus() {
    return {
        lastReloadAt: lastCacheReloadAt,
        guildCount: Object.keys(guildConfigCache).length,
    };
}

module.exports = {
    initConfig,
    reloadCache,
    getGuildConfig,
    setGuildConfig,
    getCacheStatus,
};
