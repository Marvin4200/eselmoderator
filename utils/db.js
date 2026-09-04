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

    // Leveling (Leveling-Modul) -- Schema 1:1 aus fahrstuhl/utils/db.js.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS guild_user_levels (
            guild_id VARCHAR(32) NOT NULL,
            user_id VARCHAR(32) NOT NULL,
            xp BIGINT NOT NULL DEFAULT 0,
            level INT NOT NULL DEFAULT 0,
            message_count BIGINT NOT NULL DEFAULT 0,
            voice_xp BIGINT NOT NULL DEFAULT 0,
            last_message_xp_at BIGINT NOT NULL DEFAULT 0,
            updated_at BIGINT NOT NULL,
            PRIMARY KEY (guild_id, user_id),
            INDEX idx_level_leaderboard (guild_id, xp),
            INDEX idx_level_updated (guild_id, updated_at)
        )
    `);

    // Tickets (Ticket-Modul) -- Schema aus der ECHTEN Live-Tabelle bei fahrstuhl uebernommen
    // (per DESCRIBE geprueft), nicht aus fahrstuhl/utils/db.js's CREATE-TABLE-Statement: das
    // deklariert dort faelschlich keine channel_id-Spalte/PRIMARY KEY, obwohl die Live-Tabelle
    // (und ticketStore.js's Queries) sie zwingend brauchen -- ein Doku/Code-Drift bei fahrstuhl,
    // der dort nur deshalb nie auffiel, weil CREATE TABLE IF NOT EXISTS die laengst bestehende
    // Tabelle nie neu anlegt/validiert. Fuer eine frische Installation hier korrekt nachgebaut.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ticket_records (
            channel_id VARCHAR(32) PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            owner_id VARCHAR(32) NOT NULL,
            owner_tag VARCHAR(120) DEFAULT NULL,
            type VARCHAR(80) NOT NULL DEFAULT 'Support',
            priority VARCHAR(24) NOT NULL DEFAULT 'normal',
            status VARCHAR(32) NOT NULL DEFAULT 'open',
            claimed_by VARCHAR(32) DEFAULT NULL,
            opened_by VARCHAR(32) DEFAULT NULL,
            closed_by VARCHAR(32) DEFAULT NULL,
            reason TEXT,
            close_reason TEXT,
            internal_notes LONGTEXT,
            feedback_rating INT DEFAULT NULL,
            feedback_user_id VARCHAR(32) DEFAULT NULL,
            feedback_comment TEXT,
            feedback_at BIGINT DEFAULT NULL,
            opened_at BIGINT NOT NULL,
            closed_at BIGINT DEFAULT NULL,
            transcript_channel_id VARCHAR(32) DEFAULT NULL,
            transcript_message_id VARCHAR(32) DEFAULT NULL,
            updated_at BIGINT NOT NULL,
            INDEX idx_ticket_guild_status (guild_id, status),
            INDEX idx_ticket_guild_opened (guild_id, opened_at),
            INDEX idx_ticket_owner (guild_id, owner_id),
            INDEX idx_ticket_claimed (guild_id, claimed_by)
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

    // Server-Backup/Restore (Struktur-Snapshots: Kanaele/Rollen/Berechtigungen) -- Schema
    // 1:1 aus fahrstuhl/utils/db.js uebernommen.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS discord_backups (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            name VARCHAR(255) NOT NULL,
            created_by VARCHAR(32) DEFAULT NULL,
            created_at BIGINT NOT NULL,
            stats JSON,
            backup_mode VARCHAR(16) NOT NULL DEFAULT 'full',
            parent_backup_id BIGINT DEFAULT NULL,
            INDEX idx_backup_guild (guild_id),
            INDEX idx_backup_guild_time (guild_id, created_at)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS discord_backup_sections (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            backup_id BIGINT NOT NULL,
            section VARCHAR(64) NOT NULL,
            data LONGTEXT NOT NULL,
            data_hash VARCHAR(64) DEFAULT NULL,
            INDEX idx_section_backup (backup_id),
            INDEX idx_section_lookup (backup_id, section)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS discord_restore_jobs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            backup_id BIGINT NOT NULL,
            target_guild_id VARCHAR(32) NOT NULL,
            status ENUM('running','done','failed') DEFAULT 'running',
            phase VARCHAR(128) DEFAULT NULL,
            progress_current INT DEFAULT 0,
            progress_total INT DEFAULT 0,
            log TEXT,
            result JSON,
            started_at BIGINT NOT NULL,
            finished_at BIGINT DEFAULT NULL,
            INDEX idx_restore_guild (target_guild_id),
            INDEX idx_restore_backup (backup_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS discord_backup_jobs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(32) NOT NULL,
            status ENUM('running','done','failed') DEFAULT 'running',
            phase VARCHAR(128) DEFAULT NULL,
            progress_current INT DEFAULT 0,
            progress_total INT DEFAULT 0,
            log TEXT,
            result JSON,
            started_at BIGINT NOT NULL,
            finished_at BIGINT DEFAULT NULL,
            INDEX idx_backup_jobs_guild (guild_id),
            INDEX idx_backup_jobs_status (status)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS discord_backup_schedules (
            guild_id VARCHAR(32) PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 0,
            interval_hours INT NOT NULL DEFAULT 24,
            retention_count INT NOT NULL DEFAULT 10,
            backup_mode VARCHAR(16) NOT NULL DEFAULT 'full',
            next_run_at BIGINT DEFAULT NULL,
            last_run_at BIGINT DEFAULT NULL,
            last_job_id BIGINT DEFAULT NULL,
            created_by VARCHAR(32) DEFAULT NULL,
            updated_at BIGINT NOT NULL,
            INDEX idx_backup_schedules_enabled_next (enabled, next_run_at)
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
