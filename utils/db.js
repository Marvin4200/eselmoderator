// MySQL-Anbindung fuer EselModerator -- eigene Datenbank, getrennt von fahrstuhls MySQL-DB
// (siehe Migrations-Plan: Ticket-/Moderation-/Leveling-Daten wandern in Phase 3/4 hierher).
// Struktur 1:1 aus fahrstuhl/utils/db.js uebernommen (getPool()/initDb()-Muster), aber ohne die
// Tabellen der noch nicht portierten Features -- die kommen modulweise in Phase 2/3 dazu.
const mysql = require("mysql2/promise");

let pool = null;
let lastDbPingAt = 0;
let lastDbPingMs = null;

async function initDb({ host, port, user, password, database }) {
    if (pool) return pool;

    pool = mysql.createPool({
        host,
        port,
        user,
        password,
        database,
        waitForConnections: true,
        connectionLimit: 10,
        charset: "utf8mb4",
        supportBigNumbers: true,
    });

    // Zentrale Guild-Konfiguration (ein JSON-Blob pro Modul-Satz) -- Muster aus fahrstuhl
    // uebernommen, damit die Migration in Phase 4 dieselbe Struktur wiederfindet.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS guild_configs (
            guild_id VARCHAR(32) PRIMARY KEY,
            config_json LONGTEXT NOT NULL
        )
    `);

    // Moderation (Warn/Timeout/Kick/Ban/Unban-Faelle) -- Schema 1:1 aus fahrstuhl/utils/db.js.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS moderation_cases (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            user_id VARCHAR(32) NOT NULL,
            moderator_id VARCHAR(32) DEFAULT NULL,
            type VARCHAR(32) NOT NULL,
            reason TEXT,
            duration_ms BIGINT DEFAULT NULL,
            expires_at BIGINT DEFAULT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'active',
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL,
            INDEX idx_mod_guild_time (guild_id, created_at),
            INDEX idx_mod_user_time (guild_id, user_id, created_at),
            INDEX idx_mod_status (guild_id, status)
        )
    `);

    // Temp-Voice-Kanaele (Temp-Voice-Modul) -- Schema 1:1 aus fahrstuhl/utils/db.js.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS temp_voice_channels (
            channel_id VARCHAR(32) PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            owner_id VARCHAR(32) NOT NULL,
            created_at BIGINT NOT NULL,
            INDEX idx_temp_voice_guild (guild_id)
        )
    `);

    // Server-Event-Logs (Logging-Modul) -- Schema 1:1 aus fahrstuhl/utils/db.js.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS server_log_events (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            event_key VARCHAR(64) NOT NULL,
            title VARCHAR(256),
            description TEXT,
            color INT DEFAULT NULL,
            created_at BIGINT NOT NULL,
            INDEX idx_sle_guild_time (guild_id, created_at)
        )
    `);

    return pool;
}

function getPool() {
    if (!pool) throw new Error("DB not initialized");
    return pool;
}

function readPoolStats() {
    if (!pool) return null;
    const inner = pool.pool || pool;
    const all = inner?._allConnections || inner?.allConnections || inner?._all || [];
    const free = inner?._freeConnections || inner?.freeConnections || inner?._free || [];
    const queue = inner?._connectionQueue || inner?.connectionQueue || inner?._queue || [];

    const toCount = (val) => Array.isArray(val) ? val.length : (typeof val === "number" ? val : null);

    return {
        total: toCount(all),
        free: toCount(free),
        queued: toCount(queue),
    };
}

async function getDbStatus() {
    if (!pool) throw new Error("DB not initialized");
    const start = Date.now();
    try {
        await pool.query("SELECT 1");
        lastDbPingMs = Date.now() - start;
        lastDbPingAt = Date.now();
        return {
            ok: true,
            pingMs: lastDbPingMs,
            lastPingAt: lastDbPingAt,
            pool: readPoolStats(),
        };
    } catch (error) {
        return {
            ok: false,
            error: error?.message || String(error),
            pingMs: null,
            lastPingAt: lastDbPingAt,
            pool: readPoolStats(),
        };
    }
}

module.exports = {
    initDb,
    getPool,
    getDbStatus,
};
