// Leveling-Zusatzlogik: Level-Rollen-Sync, Premium-XP-Boost und Ankuendigungs-Template --
// aus fahrstuhl/index.js extrahiert, aber mit EselModerators EIGENEM Premium-System (siehe
// Architektur-Entscheidung: kein Cross-Bot-Premium-Check, jeder Bot hat sein eigenes).
const { PermissionsBitField } = require("discord.js");
const levelingManager = require("./levelingManager");
const premiumManager = require("./premiumManager");

// EselModerators eigene XP-Boost-Werte je Tier (unabhaengig von Fahrstuhls Tier-Definitionen).
const XP_MULTIPLIER_BY_TIER = { basic: 1.5, pro: 2 };

const premiumXpCache = new Map();
const PREMIUM_XP_CACHE_TTL_MS = 10 * 60 * 1000;

async function resolvePremiumXpMultiplier(userId) {
    if (!userId) return 1;
    const cached = premiumXpCache.get(userId);
    const now = Date.now();
    if (cached && now - cached.ts < PREMIUM_XP_CACHE_TTL_MS) return cached.multiplier;

    let multiplier = 1;
    try {
        const isPremium = await premiumManager.isPremium(userId);
        if (isPremium) {
            const isPro = await premiumManager.isPro(userId);
            multiplier = isPro ? XP_MULTIPLIER_BY_TIER.pro : XP_MULTIPLIER_BY_TIER.basic;
        }
    } catch {
        multiplier = 1; // Lookup-Fehler darf nie auf Kosten der XP des Nutzers gehen.
    }

    premiumXpCache.set(userId, { multiplier, ts: now });
    return multiplier;
}

function cleanupPremiumXpCache() {
    const now = Date.now();
    for (const [key, entry] of premiumXpCache.entries()) {
        if (now - entry.ts > PREMIUM_XP_CACHE_TTL_MS) premiumXpCache.delete(key);
    }
}

function renderLevelTemplate(template, message, result) {
    return String(template || "{user} reached Level {level}!")
        .replaceAll("{user}", `${message.author}`)
        .replaceAll("{username}", message.member?.displayName || message.author.username)
        .replaceAll("{level}", String(result.level))
        .replaceAll("{xp}", String(result.xp))
        .replaceAll("{server}", message.guild.name);
}

async function syncLevelRolesForMember(guild, member, level, config) {
    const settings = levelingManager.getLevelSettings(config);
    if (!member || !Array.isArray(settings.roleRewards) || settings.roleRewards.length === 0) return;

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageRoles)) return;

    const earned = settings.roleRewards.filter(reward => {
        if (level < reward.level) return false;
        const role = guild.roles.cache.get(reward.roleId);
        return !!role && !role.managed && role.position < me.roles.highest.position;
    });
    if (earned.length === 0) return;

    const targetRewards = settings.roleMode === "highest" || settings.removeLowerLevelRoles
        ? [earned[earned.length - 1]]
        : earned;
    const targetRoleIds = new Set(targetRewards.map(reward => reward.roleId));
    const configuredRoleIds = new Set(settings.roleRewards.map(reward => reward.roleId));

    for (const roleId of targetRoleIds) {
        if (!member.roles.cache.has(roleId)) {
            await member.roles.add(roleId, `Level reward: Level ${level}`).catch(error => {
                console.warn(`⚠️ Level role add failed in ${guild.name}: ${error.message}`);
            });
        }
    }

    if (settings.roleMode === "highest" || settings.removeLowerLevelRoles) {
        const removeIds = Array.from(configuredRoleIds).filter(roleId => !targetRoleIds.has(roleId) && member.roles.cache.has(roleId));
        if (removeIds.length > 0) {
            await member.roles.remove(removeIds, "Level reward cleanup").catch(error => {
                console.warn(`⚠️ Level role cleanup failed in ${guild.name}: ${error.message}`);
            });
        }
    }
}

async function syncLevelRoles(message, result, config) {
    return syncLevelRolesForMember(message.guild, message.member, result.level, config);
}

module.exports = {
    resolvePremiumXpMultiplier,
    cleanupPremiumXpCache,
    renderLevelTemplate,
    syncLevelRolesForMember,
    syncLevelRoles,
};
