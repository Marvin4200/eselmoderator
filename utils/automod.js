// AutoMod-Erkennung + Aktionen -- 1:1 aus fahrstuhl/index.js (Zeilen ~700-960) extrahiert.
// emitActivityEvent (Live-Dashboard-Stream) wurde bewusst weggelassen -- die
// moderation_cases-Zeile ist die Quelle der Wahrheit, der Live-Stream ist eine
// Dashboard-Komfortfunktion, die erst mit dem eigenen Dashboard nachgezogen wird.
const { PermissionsBitField } = require("discord.js");
const { parseBoolean } = require("./valueParsers");
const { getPool } = require("./db");

// guildId -> Map(userId -> letzte Nachrichten) fuer Duplikat-/Spam-Erkennung.
const autoModMessageMap = new Map();

function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeAutoModSettings(automod = {}) {
    const rawRuleActions = automod.ruleActions && typeof automod.ruleActions === "object" ? automod.ruleActions : {};
    const normalizeRuleAction = (value) => {
        const allowed = ["fallback", "none", "delete", "warn", "timeout", "kick", "ban"];
        const action = String(value || "fallback").trim().toLowerCase();
        return allowed.includes(action) ? action : "fallback";
    };
    return {
        blockInvites: parseBoolean(automod.blockInvites, true),
        blockLinks: parseBoolean(automod.blockLinks),
        allowedLinks: Array.isArray(automod.allowedLinks) ? automod.allowedLinks : [],
        blockMassMentions: parseBoolean(automod.blockMassMentions, true),
        blockCaps: parseBoolean(automod.blockCaps),
        blockSpam: parseBoolean(automod.blockSpam, true),
        blockRepeatedText: parseBoolean(automod.blockRepeatedText, true),
        deleteMessage: parseBoolean(automod.deleteMessage, true),
        warnUser: parseBoolean(automod.warnUser, true),
        exemptAdmins: parseBoolean(automod.exemptAdmins, true),
        mentionLimit: clampNumber(automod.mentionLimit, 2, 25, 6),
        capsMinLength: clampNumber(automod.capsMinLength, 8, 200, 12),
        capsPercent: clampNumber(automod.capsPercent, 50, 100, 70),
        duplicateThreshold: clampNumber(automod.duplicateThreshold, 2, 10, 4),
        duplicateWindowSeconds: clampNumber(automod.duplicateWindowSeconds, 5, 300, 20),
        autoPunishStrikes: clampNumber(automod.autoPunishStrikes ?? automod.autoTimeoutStrikes, 0, 20, 0),
        timeoutMinutes: clampNumber(automod.timeoutMinutes ?? automod.autoTimeoutMinutes, 1, 40320, 10),
        punishmentAction: ["none", "timeout", "kick", "ban"].includes(automod.punishmentAction) ? automod.punishmentAction : "timeout",
        punishmentMode: ["fixed", "escalate"].includes(automod.punishmentMode) ? automod.punishmentMode : "fixed",
        warnMessage: String(automod.warnMessage || "AutoMod blocked your message: {reason}").slice(0, 180),
        blockedTermsWholeWord: parseBoolean(automod.blockedTermsWholeWord, false),
        blockedTermsRegex: parseBoolean(automod.blockedTermsRegex, false),
        blockedTerms: Array.isArray(automod.blockedTerms) ? automod.blockedTerms : [],
        ruleActions: {
            invite: normalizeRuleAction(rawRuleActions.invite),
            link: normalizeRuleAction(rawRuleActions.link),
            blocked_term: normalizeRuleAction(rawRuleActions.blocked_term),
            mass_mentions: normalizeRuleAction(rawRuleActions.mass_mentions),
            caps: normalizeRuleAction(rawRuleActions.caps),
            repeated_text: normalizeRuleAction(rawRuleActions.repeated_text),
            message_spam: normalizeRuleAction(rawRuleActions.message_spam),
        },
        ignoredRoles: Array.isArray(automod.ignoredRoles) ? automod.ignoredRoles : [],
        ignoredChannels: Array.isArray(automod.ignoredChannels) ? automod.ignoredChannels : [],
    };
}

function escapeRegex(text) {
    return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveAutoModRuleAction(automod, ruleType) {
    const action = String(automod?.ruleActions?.[ruleType] || "fallback").toLowerCase();
    return ["fallback", "none", "delete", "warn", "timeout", "kick", "ban"].includes(action) ? action : "fallback";
}

function shouldBypassAutoMod(message, automod) {
    if (automod.ignoredChannels.includes(message.channel.id)) return true;
    if (automod.exemptAdmins && message.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) return true;

    const userRoleIds = message.member?.roles?.cache ? Array.from(message.member.roles.cache.keys()) : [];
    return userRoleIds.some(id => automod.ignoredRoles.includes(id));
}

function getRecentAutoModMessages(message, automod) {
    const guildId = message.guild.id;
    const userId = message.author.id;
    const now = Date.now();
    const windowMs = automod.duplicateWindowSeconds * 1000;
    if (!autoModMessageMap.has(guildId)) autoModMessageMap.set(guildId, new Map());
    const guildMap = autoModMessageMap.get(guildId);
    const recent = (guildMap.get(userId) || []).filter(item => item.createdAt > now - windowMs);
    const normalized = String(message.content || "").trim().toLowerCase().replace(/\s+/g, " ");
    recent.push({ content: normalized, channelId: message.channel.id, createdAt: now });
    guildMap.set(userId, recent.slice(-20));
    return recent;
}

function findAutoModViolations(message, automod = {}) {
    const text = String(message.content || "");
    const lower = text.toLowerCase();
    const violations = [];

    if (automod.blockInvites && /(discord\.gg\/|discord\.com\/invite\/|discordapp\.com\/invite\/)/i.test(text)) {
        violations.push({ type: "invite", reason: "Discord invite link", points: 1, action: resolveAutoModRuleAction(automod, "invite") });
    }

    if (automod.blockLinks && /https?:\/\/|www\./i.test(text)) {
        const allowedLinks = Array.isArray(automod.allowedLinks) ? automod.allowedLinks : [];
        const isWhitelisted = allowedLinks.some(link => {
            const cleaned = String(link || "").trim().toLowerCase();
            return cleaned.length > 0 && lower.includes(cleaned);
        });
        if (!isWhitelisted) {
            violations.push({ type: "link", reason: "External link", points: 1, action: resolveAutoModRuleAction(automod, "link") });
        }
    }

    const blockedTerms = Array.isArray(automod.blockedTerms) ? automod.blockedTerms : [];
    let matchedTerm = null;
    for (const rawTerm of blockedTerms) {
        const cleaned = String(rawTerm || "").trim();
        if (cleaned.length < 2) continue;
        if (automod.blockedTermsRegex) {
            try {
                const regex = new RegExp(cleaned, "i");
                if (regex.test(text)) { matchedTerm = cleaned; break; }
            } catch (error) {
                console.warn(`⚠️ Invalid AutoMod regex in guild ${message.guild.id}: ${cleaned} (${error.message})`);
            }
            continue;
        }
        if (automod.blockedTermsWholeWord) {
            try {
                const regex = new RegExp(`(^|\\W)${escapeRegex(cleaned)}(\\W|$)`, "i");
                if (regex.test(text)) { matchedTerm = cleaned; break; }
            } catch {
                continue;
            }
        } else if (lower.includes(cleaned.toLowerCase())) {
            matchedTerm = cleaned;
            break;
        }
    }
    if (matchedTerm) violations.push({ type: "blocked_term", reason: `Blocked term: ${matchedTerm}`, points: 2, action: resolveAutoModRuleAction(automod, "blocked_term") });

    const mentionCount = (message.mentions?.users?.size || 0) + (message.mentions?.roles?.size || 0);
    if (automod.blockMassMentions && mentionCount >= automod.mentionLimit) {
        violations.push({ type: "mass_mentions", reason: `${mentionCount} mentions in one message`, points: 2, action: resolveAutoModRuleAction(automod, "mass_mentions") });
    }

    const letters = text.replace(/[^a-zA-ZÄÖÜäöüß]/g, "");
    const uppercase = letters.replace(/[^A-ZÄÖÜ]/g, "");
    const capsPercent = letters.length > 0 ? Math.round((uppercase.length / letters.length) * 100) : 0;
    if (automod.blockCaps && letters.length >= automod.capsMinLength && capsPercent >= automod.capsPercent) {
        violations.push({ type: "caps", reason: `${capsPercent}% uppercase text`, points: 1, action: resolveAutoModRuleAction(automod, "caps") });
    }

    const recent = getRecentAutoModMessages(message, automod);
    const normalized = String(message.content || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (automod.blockRepeatedText && normalized.length >= 4) {
        const repeats = recent.filter(item => item.content === normalized).length;
        if (repeats >= automod.duplicateThreshold) {
            violations.push({ type: "repeated_text", reason: `${repeats} repeated messages`, points: 2, action: resolveAutoModRuleAction(automod, "repeated_text") });
        }
    }
    if (automod.blockSpam && recent.length >= automod.duplicateThreshold) {
        violations.push({ type: "message_spam", reason: `${recent.length} messages in ${automod.duplicateWindowSeconds}s`, points: 1, action: resolveAutoModRuleAction(automod, "message_spam") });
    }

    return violations;
}

async function recordAutoModCase(message, violation, botUserId) {
    try {
        const now = Date.now();
        const pool = getPool();
        await pool.query(
            `INSERT INTO moderation_cases
                (guild_id, user_id, moderator_id, type, reason, duration_ms, expires_at, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [message.guild.id, message.author.id, botUserId || null, "automod", violation.reason, null, null, "active", now, now]
        );
    } catch (error) {
        console.warn(`⚠️ AutoMod case logging failed in ${message.guild.name}: ${error.message}`);
    }
}

async function applyAutoModPunishment(message, automod, strikes) {
    if (automod.autoPunishStrikes <= 0 || strikes < automod.autoPunishStrikes || automod.punishmentAction === "none") {
        return false;
    }

    const reason = `AutoMod: ${strikes} strikes`;
    try {
        let action = automod.punishmentAction;
        let timeoutMinutes = automod.timeoutMinutes;

        if (automod.punishmentMode === "escalate") {
            const escalateLevel = strikes - automod.autoPunishStrikes + 1;
            if (escalateLevel <= 0) return false;
            if (escalateLevel === 1) { action = "timeout"; timeoutMinutes = 10; }
            else if (escalateLevel === 2) { action = "timeout"; timeoutMinutes = 120; }
            else if (escalateLevel === 3) { action = "timeout"; timeoutMinutes = 720; }
            else { action = "kick"; }
        }

        if (action === "timeout") {
            if (message.member && message.guild.members.me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                await message.member.timeout(timeoutMinutes * 60 * 1000, reason);
                await message.channel.send({
                    content: `🚨 ${message.author} was automatically timed out for ${timeoutMinutes} minutes (Reason: ${reason}).`,
                    allowedMentions: { users: [message.author.id] },
                }).catch(() => {});
                return true;
            }
        } else if (action === "kick") {
            if (message.member?.kickable) {
                await message.author.send(`You were kicked from **${message.guild.name}** for repeated AutoMod violations.`).catch(() => {});
                await message.member.kick(reason);
                return true;
            }
        } else if (action === "ban") {
            if (message.member?.bannable) {
                await message.author.send(`You were banned from **${message.guild.name}** for repeated AutoMod violations.`).catch(() => {});
                await message.member.ban({ reason, deleteMessageSeconds: 60 * 60 });
                return true;
            }
        }
    } catch (err) {
        console.warn(`⚠️ AutoMod punishment failed: ${err.message}`);
    }
    return false;
}

async function applyAutoModRuleAction(message, automod, violation, strikes) {
    const action = violation.action || "fallback";
    if (action === "fallback") return false;
    const reason = `AutoMod ${violation.type}: ${violation.reason}`;

    try {
        if (action === "none") return false;
        if (action === "delete") {
            if (message.deletable) await message.delete().catch(() => {});
            return true;
        }
        if (action === "warn") {
            const content = automod.warnMessage
                .replaceAll("{user}", `${message.author}`)
                .replaceAll("{reason}", violation.reason)
                .replaceAll("{strikes}", String(strikes));
            await message.channel.send({ content, allowedMentions: { users: [message.author.id] } }).catch(() => null);
            return true;
        }
        if (action === "timeout") {
            if (message.member && message.guild.members.me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                if (message.deletable) await message.delete().catch(() => {});
                await message.member.timeout(automod.timeoutMinutes * 60 * 1000, reason);
                return true;
            }
            return false;
        }
        if (action === "kick") {
            if (message.member?.kickable) {
                if (message.deletable) await message.delete().catch(() => {});
                await message.member.kick(reason);
                return true;
            }
            return false;
        }
        if (action === "ban") {
            if (message.member?.bannable) {
                if (message.deletable) await message.delete().catch(() => {});
                await message.member.ban({ reason, deleteMessageSeconds: 3600 });
                return true;
            }
            return false;
        }
    } catch (err) {
        console.warn(`⚠️ AutoMod rule action failed: ${err.message}`);
    }
    return false;
}

module.exports = {
    normalizeAutoModSettings,
    shouldBypassAutoMod,
    findAutoModViolations,
    recordAutoModCase,
    applyAutoModPunishment,
    applyAutoModRuleAction,
};
