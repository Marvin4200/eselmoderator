// Temp-Voice: automatisches Erstellen/Aufraeumen von Kanaelen bei Beitritt zu einem
// Hub-Channel -- 1:1 aus fahrstuhl/index.js (Zeilen ~353-460) uebernommen.
const { PermissionsBitField } = require("discord.js");
const { parseBoolean } = require("./valueParsers");
const { getPool } = require("./db");

// channelId -> { guildId, ownerId, createdAt }. Wird beim Start aus der DB befuellt
// (siehe restoreTempVoiceChannels), damit ein Neustart die Owner-Zuordnung nicht verliert.
const tempVoiceChannels = new Map();

function moduleEnabled(config, key, fallback = false) {
    const modules = config.modules || {};
    return parseBoolean(modules[key], fallback);
}

function tempVoiceModuleEnabled(config) {
    if (moduleEnabled(config, "tempVoice", false)) return true;
    const tempVoice = config.tempVoice && typeof config.tempVoice === "object" ? config.tempVoice : {};
    return parseBoolean(tempVoice.enabled);
}

function renderTempVoiceName(template, member) {
    const base = String(template || "{username}'s Channel")
        .replaceAll("{user}", member.user?.username || member.displayName || "User")
        .replaceAll("{username}", member.user?.username || member.displayName || "User")
        .replaceAll("{displayName}", member.displayName || member.user?.username || "User")
        .replaceAll("{server}", member.guild.name)
        .replaceAll("{server.name}", member.guild.name);
    return base.replace(/[\\/#]/g, " ").trim().slice(0, 90) || `${member.displayName || "User"}'s Channel`;
}

async function restoreTempVoiceChannels() {
    try {
        const [rows] = await getPool().query("SELECT channel_id, guild_id, owner_id, created_at FROM temp_voice_channels");
        for (const row of rows) {
            tempVoiceChannels.set(row.channel_id, { guildId: row.guild_id, ownerId: row.owner_id, createdAt: Number(row.created_at) });
        }
        console.log(`✓ ${rows.length} Temp-Voice-Kanal/-Kanaele aus der DB wiederhergestellt`);
    } catch (err) {
        console.warn(`⚠️ Temp voice restore failed: ${err.message}`);
    }
}

async function cleanupTempVoiceChannel(channel) {
    if (!channel || !tempVoiceChannels.has(channel.id)) return;
    if ((channel.members?.size ?? 0) > 0) return;
    tempVoiceChannels.delete(channel.id);
    try {
        await getPool().query("DELETE FROM temp_voice_channels WHERE channel_id = ?", [channel.id]);
    } catch {}
    await channel.delete("EselModerator temp voice cleanup").catch(error => {
        console.warn(`⚠️ Temp voice cleanup failed in ${channel.guild?.name || "unknown guild"}: ${error.message}`);
    });
}

async function handleTempVoiceUpdate(oldState, newState, getGuildConfig) {
    const guild = newState.guild || oldState.guild;
    const member = newState.member || oldState.member;
    if (!guild || !member || member.user?.bot) return;

    const oldChannel = oldState.channel;
    const newChannel = newState.channel;
    if (oldChannel?.id && oldChannel.id !== newChannel?.id) {
        const oldConfig = getGuildConfig(guild.id);
        const tempVoice = oldConfig.tempVoice && typeof oldConfig.tempVoice === "object" ? oldConfig.tempVoice : {};
        if (parseBoolean(tempVoice.deleteWhenEmpty, true)) {
            await cleanupTempVoiceChannel(oldChannel);
        }
    }

    const config = getGuildConfig(guild.id);
    if (!tempVoiceModuleEnabled(config)) return;
    const tempVoice = config.tempVoice && typeof config.tempVoice === "object" ? config.tempVoice : {};
    if (!tempVoice.hubChannelId || newChannel?.id !== String(tempVoice.hubChannelId)) return;

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const canManage = me?.permissions?.has(PermissionsBitField.Flags.ManageChannels) ?? false;
    const canMove = me?.permissions?.has(PermissionsBitField.Flags.MoveMembers) ?? false;
    if (!canManage || !canMove) {
        console.warn(`⚠️ Temp voice missing permissions in ${guild.name}: ManageChannels=${canManage}, MoveMembers=${canMove}`);
        return;
    }

    const parent = tempVoice.categoryId || newChannel.parentId || null;
    const channelOptions = {
        name: renderTempVoiceName(tempVoice.channelNameTemplate, member),
        type: 2,
        reason: "EselModerator temp voice channel",
    };
    if (parent) channelOptions.parent = parent;
    if (parseBoolean(tempVoice.allowRename, true) || parseBoolean(tempVoice.allowLock, true) || parseBoolean(tempVoice.allowLimit, true)) {
        channelOptions.permissionOverwrites = [
            { id: member.id, allow: [PermissionsBitField.Flags.ManageChannels] },
        ];
    }
    const userLimit = Math.max(0, Math.min(99, Number(tempVoice.userLimit) || 0));
    if (userLimit > 0) channelOptions.userLimit = userLimit;
    const bitrate = Math.max(0, Math.min(384, Number(tempVoice.bitrate) || 0));
    if (bitrate > 0) channelOptions.bitrate = bitrate * 1000;

    const created = await guild.channels.create(channelOptions).catch(error => {
        console.warn(`⚠️ Temp voice create failed in ${guild.name}: ${error.message}`);
        return null;
    });
    if (!created) return;

    tempVoiceChannels.set(created.id, { guildId: guild.id, ownerId: member.id, createdAt: Date.now() });

    try {
        await getPool().query(
            "INSERT INTO temp_voice_channels (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE owner_id = VALUES(owner_id), created_at = VALUES(created_at)",
            [created.id, guild.id, member.id, Date.now()]
        );
    } catch {}

    await member.voice.setChannel(created, "EselModerator temp voice join").catch(error => {
        console.warn(`⚠️ Temp voice move failed in ${guild.name}: ${error.message}`);
    });
}

module.exports = {
    tempVoiceChannels,
    restoreTempVoiceChannels,
    handleTempVoiceUpdate,
};
