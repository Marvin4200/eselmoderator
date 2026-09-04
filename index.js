// EselModerator -- Phase 2 im Aufbau: Moderation ist das erste portierte Feature.
//
// Loggt sich bei Discord ein, initialisiert die eigene MySQL-DB und das eigene
// Premium-System, registriert Slash-Commands und startet den Health-API-Server.
const { Client, GatewayIntentBits, Events, REST, Routes, ActivityType, EmbedBuilder, PermissionsBitField } = require("discord.js");
const { version: BOT_VERSION } = require("./package.json");
require("dotenv").config();

const { initConfig, getGuildConfig } = require("./utils/config");
const { parseBoolean } = require("./utils/valueParsers");
const { sendServerLog } = require("./utils/serverLogger");
const {
    normalizeAutoModSettings,
    shouldBypassAutoMod,
    findAutoModViolations,
    recordAutoModCase,
    applyAutoModPunishment,
    applyAutoModRuleAction,
} = require("./utils/automod");
const { sendConfiguredWelcome } = require("./utils/welcome");
const { restoreTempVoiceChannels, handleTempVoiceUpdate } = require("./utils/tempVoice");
const levelingManager = require("./utils/levelingManager");
const {
    resolvePremiumXpMultiplier,
    cleanupPremiumXpCache,
    renderLevelTemplate,
    syncLevelRoles,
    syncLevelRolesForMember,
} = require("./utils/leveling");
const ticketManager = require("./utils/ticketManager");
const premiumManager = require("./utils/premiumManager");
const BotAPIServer = require("./services/botAPI");
const { commands, handleInteraction } = require("./commands/index");

function moduleEnabled(config, key, fallback = false) {
    const modules = config.modules || {};
    return parseBoolean(modules[key], fallback);
}

// guildId -> Map(userId -> Zeitstempel der letzten 24h-Verstoesse), fuer Auto-Punish-Eskalation.
const autoModStrikeMap = new Map();

// AutoMod braucht Nachrichteninhalte -> MessageContent-Intent (privilegiert, muss im Discord
// Developer Portal unter Bot -> Privileged Gateway Intents -> "Message Content Intent"
// eingeschaltet werden, sonst ist message.content bei Guild-Nachrichten immer leer).
// Welcome/Goodbye braucht guildMemberAdd/Remove -> GuildMembers-Intent (ebenfalls
// privilegiert, gleicher Schalter im Developer Portal wie Message Content).
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

// Sauberes Shutdown-Handling nach demselben Muster wie fahrstuhl/index.js: alle laufenden
// Intervalle hier sammeln, damit sie beim Beenden gezielt geraeumt werden koennen.
const activeIntervals = [];

// Guild-Command-Registrierung statt global: Aenderungen sind sofort sichtbar (global
// braucht bis zu einer Stunde) -- praktisch waehrend Phase 2/3 noch viele Commands dazukommen.
async function syncSlashCommands() {
    const token = process.env.DISCORD_TOKEN;
    const rest = new REST({ version: "10" }).setToken(token);
    const body = commands.map(c => c.toJSON());
    for (const guild of client.guilds.cache.values()) {
        try {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body });
            console.log(`✓ Slash-Commands synced fuer ${guild.name}`);
        } catch (err) {
            console.error(`❌ Slash-Command-Sync fehlgeschlagen fuer ${guild.name}:`, err.message);
        }
    }
}

// Rotierender Status, der zeigt was der Bot tatsaechlich macht -- Muster aus
// fahrstuhl/index.js's updatePresence uebernommen, Inhalte auf EselModerators
// Moderation/Tickets/Leveling-Fokus zugeschnitten statt Troll-Themen.
function updatePresence() {
    try {
        const statuses = [
            { name: `${client.guilds.cache.size} Server`, type: ActivityType.Watching },
            { name: "/mod · Moderation", type: ActivityType.Playing },
            { name: "über Tickets", type: ActivityType.Watching },
            { name: `v${BOT_VERSION}`, type: ActivityType.Playing },
        ];
        const randomStatus = statuses[Math.floor(Math.random() * statuses.length)];
        client.user.setPresence({ activities: [randomStatus], status: "online" });
    } catch (err) {
        console.error("❌ Error updating presence:", err);
    }
}

client.once(Events.ClientReady, async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`✓ ${client.guilds.cache.size} Guild(s) verbunden`);
    await syncSlashCommands();
    updatePresence();
    activeIntervals.push(setInterval(updatePresence, 10 * 60 * 1000));
});

client.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(interaction).catch((err) => {
        console.error("Unhandled interaction error:", err);
    });
});

// AutoMod -- 1:1 aus fahrstuhl/index.js's messageCreate-Handler uebernommen.
client.on(Events.MessageCreate, async (message) => {
    try {
        if (!message.guild || message.author?.bot) return;
        const config = getGuildConfig(message.guild.id);
        if (!moduleEnabled(config, "automod", false)) return;

        const automod = normalizeAutoModSettings(config.automod && typeof config.automod === "object" ? config.automod : {});
        if (shouldBypassAutoMod(message, automod)) return;

        const violations = findAutoModViolations(message, automod);
        if (!violations.length) return;

        const violation = violations[0];
        const reasonText = violations.map(item => item.reason).join(", ");
        const now = Date.now();
        const guildId = message.guild.id;
        const userId = message.author.id;
        if (!autoModStrikeMap.has(guildId)) autoModStrikeMap.set(guildId, new Map());
        const userMap = autoModStrikeMap.get(guildId);
        const since = now - 24 * 60 * 60 * 1000;
        const strikes = (userMap.get(userId) || []).filter(ts => ts > since);
        strikes.push(now);
        userMap.set(userId, strikes);

        const ruleAction = violation.action || "fallback";
        let effectiveAction = ruleAction;
        const handledByRuleAction = await applyAutoModRuleAction(message, automod, { ...violation, reason: reasonText }, strikes.length);

        if (!handledByRuleAction) {
            if (automod.deleteMessage !== false && message.deletable) {
                await message.delete().catch(error => {
                    console.warn(`⚠️ AutoMod delete failed in ${message.guild.name}: ${error.message}`);
                });
            }

            const punished = await applyAutoModPunishment(message, automod, strikes.length);
            if (punished) {
                userMap.set(userId, []);
                effectiveAction = automod.punishmentAction;
            } else if (automod.warnUser !== false) {
                effectiveAction = "warn";
            } else if (automod.deleteMessage !== false) {
                effectiveAction = "delete";
            } else {
                effectiveAction = "none";
            }

            if (automod.warnUser !== false) {
                const content = automod.warnMessage
                    .replaceAll("{user}", `${message.author}`)
                    .replaceAll("{reason}", reasonText)
                    .replaceAll("{strikes}", String(strikes.length));
                const warning = await message.channel.send({
                    content,
                    allowedMentions: { users: [message.author.id] },
                }).catch(() => null);
                if (warning) setTimeout(() => warning.delete().catch(() => {}), 8000);
            }
        } else {
            effectiveAction = ruleAction;
        }

        const excerpt = (message.content || "").slice(0, 300) || "*empty*";
        const caseReason = `Rule: ${violation.type} | Action: ${effectiveAction} | Reason: ${reasonText} | Channel: #${message.channel.id} | Message: ${excerpt}`;
        await recordAutoModCase(message, { ...violation, reason: caseReason }, client.user?.id);

        sendServerLog(message.guild, config, "automod", {
            title: "AutoMod Triggered",
            description: `Message from ${message.author} matched **${violations.map(item => item.type).join(", ")}**.`,
            color: 0xED4245,
            fields: [
                { name: "Rule", value: violation.type, inline: true },
                { name: "Action", value: effectiveAction, inline: true },
                { name: "User", value: `${message.author.username}\n\`${message.author.id}\``, inline: true },
                { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
                { name: "Reason", value: reasonText, inline: false },
                { name: "Message Excerpt", value: excerpt, inline: false },
            ],
        }).catch(() => {});
    } catch (err) {
        console.error("AutoMod handler error:", err);
    }
});

// Leveling (Nachrichten-XP) -- 1:1 aus fahrstuhl/index.js's messageCreate-Handler uebernommen.
// Laeuft als eigener Listener statt im AutoMod-Handler weiter, damit ein AutoMod-Fruehausstieg
// (return bei Regelverstoss) nicht versehentlich auch Leveling fuer diese Nachricht blockiert --
// im Original teilen sich beide denselben Handler und AutoMod endet dort explizit mit return.
client.on(Events.MessageCreate, async (message) => {
    try {
        if (!message.guild || message.author?.bot) return;
        const config = getGuildConfig(message.guild.id);
        if (!moduleEnabled(config, "leveling", false)) return;

        const levelSettings = levelingManager.getLevelSettings(config);
        const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.Administrator);
        if (levelSettings.noXpChannels.includes(message.channel.id)) return;
        if (!isAdmin && message.member?.roles.cache.some(r => levelSettings.ignoredRoles.includes(r.id))) return;

        const msgPremiumMultiplier = await resolvePremiumXpMultiplier(message.author.id);
        const result = await levelingManager.addMessageXp({
            guildId: message.guild.id,
            userId: message.author.id,
            channelId: message.channel.id,
            roleIds: message.member?.roles?.cache ? Array.from(message.member.roles.cache.keys()) : [],
            config,
            content: message.content,
            premiumMultiplier: msgPremiumMultiplier,
        });
        if (result?.skipped) return;

        if (result.leveledUp && result.announceLevelUp) {
            await syncLevelRoles(message, result, config);
            const settings = levelingManager.getLevelSettings(config);
            const announceChannel = settings.announceChannelId
                ? message.guild.channels.cache.get(settings.announceChannelId)
                : message.channel;
            const targetChannel = announceChannel?.isTextBased?.() ? announceChannel : message.channel;
            const earnedReward = Array.isArray(settings.roleRewards)
                ? settings.roleRewards.find(r => r.level === result.level)
                : null;
            const levelEmbed = new EmbedBuilder()
                .setColor(0x51cf66)
                .setTitle("🎉 Level Up!")
                .setDescription(renderLevelTemplate(settings.announceMessage, message, result))
                .addFields(
                    { name: "Level", value: `**${result.level}**`, inline: true },
                    { name: "Total XP", value: `**${result.xp.toLocaleString()}**`, inline: true },
                )
                .setThumbnail(message.author.displayAvatarURL({ size: 64 }))
                .setTimestamp();
            if (earnedReward) {
                const earnedRole = message.guild.roles.cache.get(earnedReward.roleId);
                if (earnedRole) levelEmbed.addFields({ name: "🏆 New Role", value: `<@&${earnedRole.id}>`, inline: true });
            }
            await targetChannel.send({ embeds: [levelEmbed], allowedMentions: { users: [message.author.id] } }).catch(() => {});
        } else if (result.leveledUp) {
            await syncLevelRoles(message, result, config);
        }

        if (result.leveledUp) {
            sendServerLog(message.guild, config, "leveling", {
                title: "Level Up",
                description: `${message.author} reached level **${result.level}**.`,
                color: 0x51cf66,
                fields: [
                    { name: "User", value: `${message.author.username}\n\`${message.author.id}\``, inline: true },
                    { name: "Level", value: String(result.level), inline: true },
                ],
            }).catch(() => {});
        }
    } catch (err) {
        console.error("Leveling handler error:", err);
    }
});

// Welcome/Goodbye -- 1:1 aus fahrstuhl/index.js's guildMemberAdd/guildMemberRemove uebernommen
// (ohne die Live-Dashboard-Events und die Kick-vs-Leave-Audit-Log-Unterscheidung, die als
// Feinschliff spaeter nachgezogen werden kann).
client.on(Events.GuildMemberAdd, async (member) => {
    const config = getGuildConfig(member.guild.id);
    sendConfiguredWelcome(member, "join", config).catch(error => {
        console.warn(`⚠️ Welcome message failed in ${member.guild.name}: ${error.message}`);
    });
    sendServerLog(member.guild, config, "memberJoin", {
        title: "Member Joined",
        description: `${member.user} joined the server.`,
        color: 0x51cf66,
        thumbnail: member.user.displayAvatarURL({ size: 128 }),
        fields: [
            { name: "User", value: `${member.user.username}\n\`${member.id}\``, inline: true },
            { name: "Account Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: "Members", value: String(member.guild.memberCount || "unknown"), inline: true },
        ],
    }).catch(() => {});
});

client.on(Events.GuildMemberRemove, async (member) => {
    const config = getGuildConfig(member.guild.id);
    sendConfiguredWelcome(member, "leave", config).catch(error => {
        console.warn(`⚠️ Goodbye message failed in ${member.guild.name}: ${error.message}`);
    });
    sendServerLog(member.guild, config, "memberLeave", {
        title: "Member Left",
        description: `${member.user} left the server.`,
        color: 0xff6b6b,
        thumbnail: member.user.displayAvatarURL({ size: 128 }),
        fields: [
            { name: "User", value: `${member.user.username}\n\`${member.id}\``, inline: true },
        ],
    }).catch(() => {});
});

// Temp-Voice -- 1:1 aus fahrstuhl/index.js's voiceStateUpdate-Handler uebernommen.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleTempVoiceUpdate(oldState, newState, getGuildConfig).catch((err) => {
        console.error("Temp voice handler error:", err);
    });
});

// Voice-XP -- 1:1 aus fahrstuhl/index.js's voiceXpInterval uebernommen (Zeilen ~1480-1528).
const voiceXpInterval = setInterval(async () => {
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            const config = getGuildConfig(guildId);
            if (!moduleEnabled(config, "leveling", false)) continue;
            const settings = levelingManager.getLevelSettings(config);
            if (!settings.voiceXpEnabled) continue;

            for (const [, channel] of guild.channels.cache) {
                if (channel.type !== 2) continue;
                const eligible = channel.members.filter(m =>
                    !m.user.bot && !m.voice.selfMute && !m.voice.selfDeaf && !m.voice.serverMute && !m.voice.serverDeaf
                );
                if (eligible.size < 2) continue;

                for (const [, member] of eligible) {
                    const voiceResult = await levelingManager.addVoiceXp({
                        guildId,
                        userId: member.id,
                        config,
                        premiumMultiplier: await resolvePremiumXpMultiplier(member.id),
                    }).catch(() => null);
                    if (!voiceResult || voiceResult.skipped) continue;

                    if (voiceResult.leveledUp) {
                        await syncLevelRolesForMember(guild, member, voiceResult.level, config).catch(() => {});
                        if (voiceResult.announceLevelUp) {
                            const announceChannelId = settings.announceChannelId;
                            const announceChannel = announceChannelId ? guild.channels.cache.get(announceChannelId) : null;
                            if (announceChannel?.isTextBased?.()) {
                                const voiceEmbed = new EmbedBuilder()
                                    .setColor(0x4dabf7)
                                    .setTitle("🎙️ Voice Level Up!")
                                    .setDescription(`${member} reached level **${voiceResult.level}**!`)
                                    .addFields(
                                        { name: "Level", value: `**${voiceResult.level}**`, inline: true },
                                        { name: "Total XP", value: `**${voiceResult.xp.toLocaleString()}**`, inline: true },
                                    )
                                    .setThumbnail(member.user.displayAvatarURL({ size: 64 }))
                                    .setTimestamp();
                                await announceChannel.send({ embeds: [voiceEmbed], allowedMentions: { users: [member.id] } }).catch(() => {});
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`❌ Voice XP interval error in guild ${guildId}:`, err.message);
        }
    }
}, 60_000);
activeIntervals.push(voiceXpInterval);

// Abgelaufene Cooldown-/Cache-Eintraege regelmaessig aufraeumen (unbegrenztes Map-Wachstum vermeiden).
const levelingMapsCleanup = setInterval(() => {
    levelingManager.cleanupStaleEntries();
    cleanupPremiumXpCache();
}, 30 * 60 * 1000);
activeIntervals.push(levelingMapsCleanup);

// Ticket-Panels: Live-Status alle 5 Minuten aktualisieren, gleiches Muster wie bei fahrstuhl
// diese Session eingefuehrt (Staff-Online/Queue aendert sich sonst nur bei Ticket-Events).
const ticketPanelRefresh = setInterval(async () => {
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            const config = getGuildConfig(guildId);
            if (!config.tickets?.panels?.length && !(config.tickets?.panelChannelId && config.tickets?.panelMessageId)) continue;
            await ticketManager.refreshTicketPanel(guild, config);
        } catch (err) {
            console.error(`Ticket panel refresh failed for guild ${guildId}:`, err.message);
        }
    }
}, 5 * 60 * 1000);
activeIntervals.push(ticketPanelRefresh);

// Alte Strike-Eintraege regelmaessig aufraeumen (24h-Fenster), damit die Map nicht unbegrenzt waechst.
const autoModCleanup = setInterval(() => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    for (const [guildId, userMap] of autoModStrikeMap) {
        for (const [userId, timestamps] of userMap) {
            const filtered = timestamps.filter(ts => ts > since);
            if (filtered.length === 0) userMap.delete(userId);
            else userMap.set(userId, filtered);
        }
        if (userMap.size === 0) autoModStrikeMap.delete(guildId);
    }
}, 10 * 60 * 1000);
activeIntervals.push(autoModCleanup);

async function main() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        console.error("❌ DISCORD_TOKEN fehlt in .env.");
        process.exit(1);
    }

    await initConfig();
    console.log("✓ MySQL-Datenbank initialisiert");

    await restoreTempVoiceChannels();

    await premiumManager.initialize();

    const apiServer = new BotAPIServer(client);
    apiServer.start(Number(process.env.PORT || 3003));

    await client.login(token);
}

main().catch((err) => {
    console.error("❌ Startup failed:", err);
    process.exit(1);
});

async function shutdown() {
    console.log("\n🛑 Shutdown signal received...");
    activeIntervals.forEach((interval) => clearInterval(interval));
    client.destroy();
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
