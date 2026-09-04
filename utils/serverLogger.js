// 1:1 aus fahrstuhl/utils/serverLogger.js uebernommen -- keine fahrstuhl-spezifische Kopplung,
// direkt wiederverwendbar. Deckt gleichzeitig das "Logging"-Modul ab.
const { EmbedBuilder, PermissionsBitField } = require("discord.js");
const { parseBoolean } = require("./valueParsers");
const { getPool } = require("./db");

const LOG_EVENT_GROUPS = {
    memberJoin: "member",
    memberLeave: "member",
    memberBan: "member",
    memberUnban: "member",
    messageDelete: "message",
    messageUpdate: "message",
    moderation: "moderation",
    automod: "automod",
    tickets: "tickets",
    voiceState: "voice",
    roleCreate: "structure",
    roleDelete: "structure",
    roleUpdate: "structure",
    channelCreate: "structure",
    channelDelete: "structure",
    channelUpdate: "structure",
    inviteCreate: "structure",
    inviteDelete: "structure",
};

const GROUP_STYLES = {
    member: { icon: "👤", color: 0x4dabf7 },
    message: { icon: "💬", color: 0x5865f2 },
    moderation: { icon: "🛡️", color: 0xe67e22 },
    automod: { icon: "🚨", color: 0xed4245 },
    tickets: { icon: "🎫", color: 0xf0b232 },
    voice: { icon: "🔊", color: 0x22b8cf },
    structure: { icon: "🧱", color: 0xadb5bd },
    default: { icon: "📜", color: 0x667eea },
};

function eventChannelsMap(logging = {}) {
    return logging.eventChannels && typeof logging.eventChannels === "object"
        ? logging.eventChannels
        : {};
}

function resolveLogChannelId(logging = {}, eventKey = "") {
    const eventChannels = eventChannelsMap(logging);
    const groupKey = LOG_EVENT_GROUPS[eventKey] ? `group:${LOG_EVENT_GROUPS[eventKey]}` : null;
    return eventChannels[eventKey] || (groupKey ? eventChannels[groupKey] : null) || logging.channelId || null;
}

function eventStyle(eventKey) {
    const group = LOG_EVENT_GROUPS[eventKey] || "default";
    return GROUP_STYLES[group] || GROUP_STYLES.default;
}

function loggingEnabled(config, eventKey) {
    const modules = config?.modules || {};
    if (!parseBoolean(modules.logging)) return false;
    const logging = config.logging && typeof config.logging === "object" ? config.logging : {};
    if (!parseBoolean(logging.enabled, true)) return false;
    if (!resolveLogChannelId(logging, eventKey)) return false;
    const events = logging.events && typeof logging.events === "object" ? logging.events : {};
    return parseBoolean(events[eventKey], true);
}

function trimText(value, limit, fallback = null) {
    const text = String(value ?? "").trim();
    if (!text) return fallback;
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function normalizeField(field) {
    const name = trimText(field?.name, 256);
    const value = trimText(field?.value, 900);
    if (!name || !value) return null;
    return { name, value, inline: !!field?.inline };
}

function normalizeAuthor(author) {
    if (!author || typeof author !== "object") return null;
    const name = trimText(author.name, 256);
    if (!name) return null;
    return { ...author, name };
}

function normalizeFooter(footer) {
    if (!footer || typeof footer !== "object") return null;
    const text = trimText(footer.text, 2048);
    if (!text) return null;
    return { ...footer, text };
}

async function sendServerLog(guild, config, eventKey, embedData = {}) {
    try {
        if (!guild) return false;
        const modules = config?.modules || {};
        const forced = embedData.force === true;
        if (!forced && !loggingEnabled(config, eventKey)) return false;
        if (forced && !parseBoolean(modules.logging)) return false;
        const logging = config.logging || {};
        if (!parseBoolean(logging.enabled, true)) return false;

        const resolvedChannelId = resolveLogChannelId(logging, eventKey);
        if (!resolvedChannelId) return false;

        const channel = guild.channels.cache.get(resolvedChannelId)
            || await guild.channels.fetch(resolvedChannelId).catch(() => null);
        if (!channel?.isTextBased?.()) return false;

        const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
        const perms = me ? channel.permissionsFor(me) : null;
        if (!perms?.has(PermissionsBitField.Flags.SendMessages)) return false;

        const style = eventStyle(eventKey);
        const rawTitle = trimText(embedData.title, 256, "Server Log");
        const title = /^[\p{Emoji}\p{Extended_Pictographic}]/u.test(rawTitle || "")
            ? rawTitle
            : `${style.icon} ${rawTitle}`;

        const embed = new EmbedBuilder()
            .setColor(embedData.color ?? style.color)
            .setTitle(title)
            .setDescription(trimText(embedData.description, 4096))
            .setTimestamp(embedData.timestamp || new Date());

        const author = normalizeAuthor(embedData.author);
        const footer = normalizeFooter(embedData.footer);
        if (author) embed.setAuthor(author);
        if (footer) embed.setFooter(footer);
        if (embedData.thumbnail) embed.setThumbnail(embedData.thumbnail);
        if (Array.isArray(embedData.fields) && embedData.fields.length) {
            const fields = embedData.fields.map(normalizeField).filter(Boolean).slice(0, 25);
            if (fields.length) embed.addFields(fields);
        }

        await channel.send({ embeds: [embed] });

        const pool = getPool();
        const descSnippet = trimText(embedData.description, 500) || null;
        pool.query(
            "INSERT INTO server_log_events (guild_id, event_key, title, description, color, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [guild.id, eventKey, rawTitle, descSnippet, embedData.color ?? style.color, Date.now()]
        ).catch(() => {});
        pool.query(
            "DELETE FROM server_log_events WHERE guild_id = ? AND created_at < ?",
            [guild.id, Date.now() - 14 * 24 * 60 * 60 * 1000]
        ).catch(() => {});

        return true;
    } catch (error) {
        console.warn(`Server logging failed in ${guild?.name || "unknown guild"}: ${error.message}`);
        return false;
    }
}

module.exports = {
    loggingEnabled,
    sendServerLog,
};
