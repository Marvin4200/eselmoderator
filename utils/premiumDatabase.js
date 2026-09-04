/**
 * Premium System - SQLite Database
 *
 * 1:1-Kopie des bewaehrten Musters aus fahrstuhl/utils/premiumDatabase.js -- eigene
 * SQLite-Datei, komplett unabhaengig von Fahrstuhls Premium-System. EselModerator und
 * Fahrstuhl verkaufen getrennte Premium-Produkte, es gibt bewusst keine Cross-Bot-Abfrage.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class PremiumDatabase {
    constructor() {
        this.dbPath = path.join(__dirname, '../data/premium.db');
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('[PremiumDB] Failed to open database:', err);
                    reject(err);
                } else {
                    this.createTable();
                    console.log('✓ Premium database initialized');
                    resolve();
                }
            });
        });
    }

    createTable() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS premium_users (
                user_id TEXT PRIMARY KEY,
                is_premium INTEGER DEFAULT 0,
                tier TEXT DEFAULT 'basic',
                expires_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        this.db.run(`
            CREATE TABLE IF NOT EXISTS premium_guilds (
                guild_id TEXT PRIMARY KEY,
                is_premium INTEGER DEFAULT 0,
                tier TEXT DEFAULT 'basic',
                expires_at DATETIME,
                purchased_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Reminder dedup, gleiches Muster wie bei Fahrstuhl: key enthaelt expires_at, damit eine
        // Verlaengerung jede Milestone automatisch neu bewaffnet.
        this.db.run(`
            CREATE TABLE IF NOT EXISTS reminder_log (
                target_key TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                milestone TEXT NOT NULL,
                sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (target_key, expires_at, milestone)
            )
        `);

        // Webhook-Idempotenz (Paddle statt Stripe, source-Feld bleibt generisch).
        this.db.run(`
            CREATE TABLE IF NOT EXISTS processed_events (
                event_id TEXT PRIMARY KEY,
                source TEXT DEFAULT 'paddle',
                processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    async wasEventProcessed(eventId) {
        return new Promise((resolve) => {
            if (!this.db || !eventId) return resolve(false);
            this.db.get(
                `SELECT event_id FROM processed_events WHERE event_id = ?`,
                [String(eventId)],
                (err, row) => resolve(!err && Boolean(row))
            );
        });
    }

    async markEventProcessed(eventId, source = 'paddle') {
        return new Promise((resolve) => {
            if (!this.db || !eventId) return resolve();
            this.db.run(
                `INSERT OR IGNORE INTO processed_events (event_id, source) VALUES (?, ?)`,
                [String(eventId), source],
                () => resolve()
            );
        });
    }

    async wasReminderSent(targetKey, expiresAt, milestone) {
        return new Promise((resolve) => {
            if (!this.db || !targetKey) return resolve(false);
            this.db.get(
                `SELECT 1 FROM reminder_log WHERE target_key = ? AND expires_at = ? AND milestone = ?`,
                [String(targetKey), String(expiresAt || ''), String(milestone)],
                (err, row) => resolve(!err && Boolean(row))
            );
        });
    }

    async markReminderSent(targetKey, expiresAt, milestone) {
        return new Promise((resolve) => {
            if (!this.db || !targetKey) return resolve();
            this.db.run(
                `INSERT OR IGNORE INTO reminder_log (target_key, expires_at, milestone) VALUES (?, ?, ?)`,
                [String(targetKey), String(expiresAt || ''), String(milestone)],
                () => resolve()
            );
        });
    }

    async pruneReminderLog(olderThanDays = 120) {
        return new Promise((resolve) => {
            if (!this.db) return resolve(0);
            this.db.run(
                `DELETE FROM reminder_log WHERE datetime(expires_at) < datetime('now', ?)`,
                [`-${Math.max(1, Number(olderThanDays) || 120)} days`],
                function (err) { resolve(err ? 0 : (this.changes || 0)); }
            );
        });
    }

    async getGuildPlan(guildId) {
        return new Promise((resolve) => {
            if (!this.db) return resolve(null);
            this.db.get(
                `SELECT guild_id, is_premium, tier, expires_at, purchased_by, created_at
                 FROM premium_guilds WHERE guild_id = ?`,
                [guildId],
                (err, row) => {
                    if (err || !row || row.is_premium !== 1) return resolve(null);
                    if (row.expires_at && new Date(row.expires_at) < new Date()) {
                        this.deactivateGuild(guildId).catch(() => {});
                        return resolve(null);
                    }
                    resolve(row);
                }
            );
        });
    }

    async activateGuild(guildId, daysValid = 30, tier = 'basic', purchasedBy = null, mode = 'extend') {
        const days = Math.max(1, Number(daysValid) || 30);

        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error('Database not initialized'));

            this.db.get(
                `SELECT is_premium, tier, expires_at FROM premium_guilds WHERE guild_id = ?`,
                [guildId],
                (readErr, row) => {
                    const now = new Date();
                    let base = now;
                    let extended = false;

                    if (mode !== 'set' && !readErr && row && row.is_premium === 1 && row.expires_at) {
                        const currentExpiry = new Date(row.expires_at);
                        const sameTier = (row.tier || 'basic') === tier;
                        if (!Number.isNaN(currentExpiry.getTime()) && currentExpiry > now && sameTier) {
                            base = currentExpiry;
                            extended = true;
                        }
                    }

                    const expiresAt = new Date(base.getTime());
                    expiresAt.setDate(expiresAt.getDate() + days);

                    this.db.run(
                        `INSERT INTO premium_guilds (guild_id, is_premium, tier, expires_at, purchased_by, updated_at)
                         VALUES (?, 1, ?, ?, ?, CURRENT_TIMESTAMP)
                         ON CONFLICT(guild_id) DO UPDATE SET
                             is_premium = 1,
                             tier = excluded.tier,
                             expires_at = excluded.expires_at,
                             purchased_by = COALESCE(excluded.purchased_by, premium_guilds.purchased_by),
                             updated_at = CURRENT_TIMESTAMP`,
                        [guildId, tier, expiresAt.toISOString(), purchasedBy],
                        (err) => {
                            if (err) {
                                console.error('[PremiumDB] Failed to activate guild plan:', err.message);
                                return reject(err);
                            }
                            resolve({ expiresAt: expiresAt.toISOString(), extended, days });
                        }
                    );
                }
            );
        });
    }

    async deactivateGuild(guildId) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject(new Error('Database not initialized'));
            this.db.run(
                `UPDATE premium_guilds SET is_premium = 0, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?`,
                [guildId],
                (err) => (err ? reject(err) : resolve())
            );
        });
    }

    async getAllGuildPlans() {
        return new Promise((resolve) => {
            if (!this.db) return resolve([]);
            this.db.all(
                `SELECT guild_id, tier, expires_at, purchased_by, created_at
                 FROM premium_guilds
                 WHERE is_premium = 1
                   AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
                 ORDER BY created_at DESC`,
                (err, rows) => resolve(err ? [] : (rows || []))
            );
        });
    }

    async isPremium(userId) {
        return new Promise((resolve) => {
            this.db.get(
                `SELECT is_premium, expires_at FROM premium_users WHERE user_id = ?`,
                [userId],
                (err, row) => {
                    if (err || !row) return resolve(false);
                    if (row.is_premium === 1) {
                        if (row.expires_at && new Date(row.expires_at) < new Date()) {
                            this.deactivate(userId);
                            resolve(false);
                        } else {
                            resolve(true);
                        }
                    } else {
                        resolve(false);
                    }
                }
            );
        });
    }

    async isPro(userId) {
        return new Promise((resolve) => {
            this.db.get(
                `SELECT is_premium, tier, expires_at FROM premium_users WHERE user_id = ?`,
                [userId],
                (err, row) => {
                    if (err || !row) return resolve(false);
                    if (row.is_premium === 1 && row.tier === 'pro') {
                        if (row.expires_at && new Date(row.expires_at) < new Date()) {
                            this.deactivate(userId);
                            resolve(false);
                        } else {
                            resolve(true);
                        }
                    } else {
                        resolve(false);
                    }
                }
            );
        });
    }

    // Renewal-Semantik identisch zu Fahrstuhl: gleiche Tier + noch Restzeit -> verlaengern,
    // sonst (oder mode='set') Uhr neu ab jetzt starten. Siehe fahrstuhl/utils/premiumDatabase.js
    // fuer die ausfuehrliche Begruendung.
    async activate(userId, daysValid = 30, tier = 'basic', mode = 'extend') {
        const days = Math.max(1, Number(daysValid) || 30);

        return new Promise((resolve, reject) => {
            if (!this.db) {
                console.error('[PremiumDB] Database not initialized!');
                return reject(new Error('Database not initialized'));
            }

            this.db.get(
                `SELECT is_premium, tier, expires_at FROM premium_users WHERE user_id = ?`,
                [userId],
                (readErr, row) => {
                    const now = new Date();
                    let base = now;
                    let extended = false;

                    if (mode !== 'set' && !readErr && row && row.is_premium === 1 && row.expires_at) {
                        const currentExpiry = new Date(row.expires_at);
                        const sameTier = (row.tier || 'basic') === tier;
                        if (!Number.isNaN(currentExpiry.getTime()) && currentExpiry > now && sameTier) {
                            base = currentExpiry;
                            extended = true;
                        }
                    }

                    const expiresAt = new Date(base.getTime());
                    expiresAt.setDate(expiresAt.getDate() + days);

                    this.db.run(
                        `INSERT INTO premium_users (user_id, is_premium, tier, expires_at, updated_at)
                         VALUES (?, 1, ?, ?, CURRENT_TIMESTAMP)
                         ON CONFLICT(user_id) DO UPDATE SET
                             is_premium = 1,
                             tier = excluded.tier,
                             expires_at = excluded.expires_at,
                             updated_at = CURRENT_TIMESTAMP`,
                        [userId, tier, expiresAt.toISOString()],
                        function (err) {
                            if (err) {
                                console.error('[PremiumDB] Failed to activate:', err.message);
                                reject(err);
                            } else {
                                resolve({ expiresAt: expiresAt.toISOString(), extended, days });
                            }
                        }
                    );
                }
            );
        });
    }

    async deactivate(userId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE premium_users SET is_premium = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
                [userId],
                (err) => (err ? reject(err) : resolve())
            );
        });
    }

    async getAllPremium() {
        return new Promise((resolve) => {
            this.db.all(
                `SELECT user_id, tier, expires_at, created_at FROM premium_users WHERE is_premium = 1 ORDER BY created_at DESC`,
                (err, rows) => resolve(err ? [] : (rows || []))
            );
        });
    }

    async getUserInfo(userId) {
        return new Promise((resolve) => {
            this.db.get(
                `SELECT user_id, is_premium, tier, expires_at, created_at FROM premium_users WHERE user_id = ?`,
                [userId],
                (err, row) => resolve(err || !row ? null : row)
            );
        });
    }
}

module.exports = new PremiumDatabase();
