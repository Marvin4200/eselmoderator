// 1:1 aus fahrstuhl/utils/levelingManager.js uebernommen -- keine fahrstuhl-spezifische
// Kopplung, direkt wiederverwendbar.
const { getPool } = require("./db");
const { parseBoolean } = require("./valueParsers");

const messageCooldowns = new Map();
const lastMessageMap = new Map();
const voiceXpCooldowns = new Map();

function xpForLevel(level) {
    const safeLevel = Math.max(0, Number(level) || 0);
    return 100 + safeLevel * 55 + Math.floor(Math.pow(safeLevel, 1.6) * 20);
}

function levelFromXp(xp) {
    let remaining = Math.max(0, Number(xp) || 0);
    let level = 0;
    while (remaining >= xpForLevel(level) && level < 1000) {
        remaining -= xpForLevel(level);
        level++;
    }
    return { level, currentXp: remaining, nextLevelXp: xpForLevel(level) };
}

function getLevelSettings(config = {}) {
    const leveling = config.leveling && typeof config.leveling === "object" ? config.leveling : {};
    const messageXpMin = Math.max(1, Math.min(500, Number(leveling.messageXpMin || process.env.LEVELING_MESSAGE_XP_MIN || 8)));
    const messageXpMax = Math.max(messageXpMin, Math.min(500, Number(leveling.messageXpMax || process.env.LEVELING_MESSAGE_XP_MAX || 15)));
    const cooldownSeconds = leveling.cooldownSeconds !== undefined
        ? Math.max(0, Math.min(3600, Number(leveling.cooldownSeconds) || 0))
        : null;
    const cooldownMs = cooldownSeconds !== null
        ? cooldownSeconds * 1000
        : Number(leveling.cooldownMs ?? process.env.LEVELING_MESSAGE_COOLDOWN_MS ?? 0);
    const roleRewards = Array.isArray(leveling.roleRewards)
        ? leveling.roleRewards
            .map(reward => ({
                level: Math.max(1, Math.min(1000, Number(reward?.level) || 0)),
                roleId: String(reward?.roleId || "").trim(),
                roleName: String(reward?.roleName || "").trim().slice(0, 80),
            }))
            .filter(reward => reward.level > 0 && reward.roleId)
            .sort((a, b) => a.level - b.level)
            .slice(0, 25)
        : [];
    const noXpChannels = Array.isArray(leveling.noXpChannels)
        ? leveling.noXpChannels.filter(id => typeof id === "string" && id.trim().length > 0).slice(0, 200)
        : (Array.isArray(leveling.ignoredChannels)
            ? leveling.ignoredChannels.filter(id => typeof id === "string" && id.trim().length > 0).slice(0, 200)
            : []);
    const roleMultipliers = Array.isArray(leveling.roleMultipliers)
        ? leveling.roleMultipliers
            .map(entry => ({
                roleId: String(entry?.roleId || "").trim(),
                multiplier: Math.max(0, Math.min(5, Number(entry?.multiplier) || 1)),
            }))
            .filter(entry => entry.roleId)
            .slice(0, 100)
        : [];
    const channelMultipliers = Array.isArray(leveling.channelMultipliers)
        ? leveling.channelMultipliers
            .map(entry => ({
                channelId: String(entry?.channelId || "").trim(),
                multiplier: Math.max(0, Math.min(5, Number(entry?.multiplier) || 1)),
            }))
            .filter(entry => entry.channelId)
            .slice(0, 100)
        : [];
    return {
        enabled: parseBoolean(leveling.enabled, true),
        messageXpMin,
        messageXpMax,
        cooldownSeconds: Math.round(cooldownMs / 1000),
        cooldownMs,
        announceLevelUp: parseBoolean(leveling.announceLevelUp),
        announceChannelId: leveling.announceChannelId || null,
        announceMessage: String(leveling.announceMessage ?? "{user} reached Level {level}!").slice(0, 180),
        roleMode: ["stack", "highest"].includes(leveling.roleMode) ? leveling.roleMode : "stack",
        autoCreateRoles: parseBoolean(leveling.autoCreateRoles),
        autoRolePrefix: String(leveling.autoRolePrefix || "Level").slice(0, 32),
        removeLowerLevelRoles: parseBoolean(leveling.removeLowerLevelRoles),
        roleRewards,
        ignoredRoles: Array.isArray(leveling.ignoredRoles) ? leveling.ignoredRoles : [],
        ignoredChannels: noXpChannels,
        noXpChannels,
        roleMultipliers,
        channelMultipliers,
        minMessageLength: Math.max(1, Math.min(100, Number(leveling.minMessageLength ?? 5))),
        blockDuplicateMessages: parseBoolean(leveling.blockDuplicateMessages, true),
        voiceXpEnabled: parseBoolean(leveling.voiceXpEnabled, false),
        voiceXpPerMinute: Math.max(1, Math.min(100, Number(leveling.voiceXpPerMinute ?? 2))),
    };
}

function randomXp(min, max) {
    const low = Math.max(1, Math.min(min, max));
    const high = Math.max(low, Math.max(min, max));
    return low + Math.floor(Math.random() * (high - low + 1));
}

function clampMultiplier(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return 1;
    return Math.max(0, Math.min(5, value));
}

function resolveMultiplier(settings = {}, { roleIds = [], channelId = null, premiumMultiplier = 1 } = {}) {
    const roleSet = new Set(Array.isArray(roleIds) ? roleIds : []);
    let roleMultiplier = 1;
    if (Array.isArray(settings.roleMultipliers)) {
        for (const entry of settings.roleMultipliers) {
            if (!entry?.roleId || !roleSet.has(entry.roleId)) continue;
            roleMultiplier = Math.max(roleMultiplier, clampMultiplier(entry.multiplier));
        }
    }

    let channelMultiplier = 1;
    if (channelId && Array.isArray(settings.channelMultipliers)) {
        const entry = settings.channelMultipliers.find(item => item?.channelId === channelId);
        if (entry) channelMultiplier = clampMultiplier(entry.multiplier);
    }

    const premium = Math.max(1, Math.min(5, Number(premiumMultiplier) || 1));
    const guildMultiplier = Math.max(0, Math.min(10, roleMultiplier * channelMultiplier));

    return {
        roleMultiplier,
        channelMultiplier,
        premiumMultiplier: premium,
        guildMultiplier,
        totalMultiplier: guildMultiplier * premium,
    };
}

async function addMessageXp({ guildId, userId, config = {}, channelId = null, roleIds = [], content = '', premiumMultiplier = 1 }) {
    const settings = getLevelSettings(config);

    const trimmed = String(content || '').trim();
    if (settings.minMessageLength > 0 && trimmed.length < settings.minMessageLength) {
        return { skipped: true, reason: 'too-short' };
    }

    if (settings.blockDuplicateMessages && trimmed.length > 0) {
        const dupKey = `${guildId}:${userId}`;
        const prev = lastMessageMap.get(dupKey);
        const dupNow = Date.now();
        if (prev && prev.content === trimmed && (dupNow - prev.ts) < 60_000) {
            prev.count = (prev.count || 1) + 1;
            if (prev.count >= 3) return { skipped: true, reason: 'duplicate' };
        } else {
            lastMessageMap.set(dupKey, { content: trimmed, count: 1, ts: dupNow });
        }
    }

    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const last = messageCooldowns.get(key) || 0;
    if (now - last < settings.cooldownMs) {
        return { skipped: true, reason: "cooldown" };
    }
    messageCooldowns.set(key, now);

    const multipliers = resolveMultiplier(settings, { roleIds, channelId, premiumMultiplier });
    if (multipliers.totalMultiplier <= 0) {
        return { skipped: true, reason: "multiplier-zero", multiplier: 0 };
    }
    const baseAmount = randomXp(settings.messageXpMin, settings.messageXpMax);
    const amount = Math.max(1, Math.round(baseAmount * multipliers.totalMultiplier));
    const pool = getPool();
    const [existingRows] = await pool.query(
        "SELECT xp, level FROM guild_user_levels WHERE guild_id = ? AND user_id = ?",
        [guildId, userId]
    );
    const previous = existingRows[0] || { xp: 0, level: 0 };
    const newXp = Number(previous.xp || 0) + amount;
    const progress = levelFromXp(newXp);
    const oldLevel = Number(previous.level || 0);

    await pool.query(
        `INSERT INTO guild_user_levels
            (guild_id, user_id, xp, level, message_count, last_message_xp_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE
             xp = VALUES(xp),
             level = VALUES(level),
             message_count = message_count + 1,
             last_message_xp_at = VALUES(last_message_xp_at),
             updated_at = VALUES(updated_at)`,
        [guildId, userId, newXp, progress.level, now, now]
    );

    return {
        skipped: false,
        baseAmount,
        amount,
        xp: newXp,
        roleMultiplier: multipliers.roleMultiplier,
        channelMultiplier: multipliers.channelMultiplier,
        premiumMultiplier: multipliers.premiumMultiplier,
        multiplier: multipliers.totalMultiplier,
        oldLevel,
        level: progress.level,
        currentXp: progress.currentXp,
        nextLevelXp: progress.nextLevelXp,
        leveledUp: progress.level > oldLevel,
        announceLevelUp: settings.announceLevelUp,
    };
}

async function addVoiceXp({ guildId, userId, config = {}, premiumMultiplier = 1 }) {
    const settings = getLevelSettings(config);
    if (!settings.voiceXpEnabled) return { skipped: true, reason: 'voice-xp-disabled' };

    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const last = voiceXpCooldowns.get(key) || 0;
    if (now - last < 55_000) return { skipped: true, reason: 'voice-cooldown' };
    voiceXpCooldowns.set(key, now);

    const premium = Math.max(1, Math.min(5, Number(premiumMultiplier) || 1));
    const amount = Math.max(1, Math.round(settings.voiceXpPerMinute * premium));
    const pool = getPool();
    const [rows] = await pool.query(
        'SELECT xp, level, voice_xp FROM guild_user_levels WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
    );
    const prev = rows[0] || { xp: 0, level: 0, voice_xp: 0 };
    const newXp = Number(prev.xp || 0) + amount;
    const newVoiceXp = Number(prev.voice_xp || 0) + amount;
    const progress = levelFromXp(newXp);
    const oldLevel = Number(prev.level || 0);

    await pool.query(
        `INSERT INTO guild_user_levels (guild_id, user_id, xp, level, message_count, voice_xp, last_message_xp_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, 0, ?)
         ON DUPLICATE KEY UPDATE xp = VALUES(xp), level = VALUES(level), voice_xp = VALUES(voice_xp), updated_at = VALUES(updated_at)`,
        [guildId, userId, newXp, progress.level, newVoiceXp, now]
    );

    return {
        skipped: false,
        amount,
        xp: newXp,
        voiceXp: newVoiceXp,
        oldLevel,
        level: progress.level,
        currentXp: progress.currentXp,
        nextLevelXp: progress.nextLevelXp,
        leveledUp: progress.level > oldLevel,
        announceLevelUp: settings.announceLevelUp,
    };
}

async function getUserLevel(guildId, userId) {
    const pool = getPool();
    const [rows] = await pool.query(
        `SELECT guild_id, user_id, xp, level, message_count, voice_xp, updated_at,
               1 + (
                   SELECT COUNT(*) FROM guild_user_levels other
                   WHERE other.guild_id = guild_user_levels.guild_id
                     AND other.xp > guild_user_levels.xp
               ) AS rank_position
         FROM guild_user_levels
         WHERE guild_id = ? AND user_id = ?`,
        [guildId, userId]
    );
    const row = rows[0] || { guild_id: guildId, user_id: userId, xp: 0, level: 0, message_count: 0, voice_xp: 0, updated_at: 0, rank_position: null };
    const progress = levelFromXp(row.xp);
    return {
        guildId,
        userId,
        xp: Number(row.xp || 0),
        level: Number(row.level || 0),
        currentXp: progress.currentXp,
        nextLevelXp: progress.nextLevelXp,
        messageCount: Number(row.message_count || 0),
        voiceXp: Number(row.voice_xp || 0),
        rank: row.rank_position ? Number(row.rank_position) : null,
        updatedAt: Number(row.updated_at || 0),
    };
}

async function getLeaderboard(guildId, limit = 50, offset = 0) {
    const pool = getPool();
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const [rows] = await pool.query(
        `SELECT guild_id, user_id, xp, level, message_count, voice_xp, updated_at
         FROM guild_user_levels
         WHERE guild_id = ?
         ORDER BY xp DESC
         LIMIT ? OFFSET ?`,
        [guildId, safeLimit, safeOffset]
    );
    return rows.map((row, index) => {
        const progress = levelFromXp(row.xp);
        return {
            rank: safeOffset + index + 1,
            guildId,
            userId: String(row.user_id),
            xp: Number(row.xp || 0),
            level: Number(row.level || 0),
            currentXp: progress.currentXp,
            nextLevelXp: progress.nextLevelXp,
            messageCount: Number(row.message_count || 0),
            voiceXp: Number(row.voice_xp || 0),
            updatedAt: Number(row.updated_at || 0),
        };
    });
}

async function getLeaderboardTotal(guildId) {
    const pool = getPool();
    const [rows] = await pool.query(
        "SELECT COUNT(*) AS total FROM guild_user_levels WHERE guild_id = ?",
        [guildId]
    );
    return Number(rows[0]?.total || 0);
}

async function resetUserXp(guildId, userId) {
    const pool = getPool();
    const [result] = await pool.query(
        "DELETE FROM guild_user_levels WHERE guild_id = ? AND user_id = ?",
        [guildId, userId]
    );
    const mapKey = `${guildId}:${userId}`;
    messageCooldowns.delete(mapKey);
    lastMessageMap.delete(mapKey);
    voiceXpCooldowns.delete(mapKey);
    return Number(result.affectedRows || 0);
}

async function resetGuildXp(guildId) {
    const pool = getPool();
    const [result] = await pool.query("DELETE FROM guild_user_levels WHERE guild_id = ?", [guildId]);
    const prefix = `${guildId}:`;
    for (const key of Array.from(messageCooldowns.keys())) {
        if (key.startsWith(prefix)) messageCooldowns.delete(key);
    }
    for (const key of Array.from(lastMessageMap.keys())) {
        if (key.startsWith(prefix)) lastMessageMap.delete(key);
    }
    for (const key of Array.from(voiceXpCooldowns.keys())) {
        if (key.startsWith(prefix)) voiceXpCooldowns.delete(key);
    }
    return Number(result.affectedRows || 0);
}

const STALE_MS = 2 * 60 * 60 * 1000;
function cleanupStaleEntries() {
    const now = Date.now();
    let removed = 0;
    for (const [key, ts] of messageCooldowns.entries()) {
        if (now - ts > STALE_MS) { messageCooldowns.delete(key); removed++; }
    }
    for (const [key, entry] of lastMessageMap.entries()) {
        if (now - (entry?.ts || 0) > STALE_MS) { lastMessageMap.delete(key); removed++; }
    }
    for (const [key, ts] of voiceXpCooldowns.entries()) {
        if (now - ts > STALE_MS) { voiceXpCooldowns.delete(key); removed++; }
    }
    return removed;
}

module.exports = {
    addMessageXp,
    addVoiceXp,
    getLevelSettings,
    getUserLevel,
    getLeaderboard,
    getLeaderboardTotal,
    resetUserXp,
    resetGuildXp,
    resolveMultiplier,
    levelFromXp,
    xpForLevel,
    cleanupStaleEntries,
};
