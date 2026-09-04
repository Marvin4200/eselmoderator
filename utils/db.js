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
