// EselModerator -- Phase 2 im Aufbau: Moderation ist das erste portierte Feature.
//
// Loggt sich bei Discord ein, initialisiert die eigene MySQL-DB und das eigene
// Premium-System, registriert Slash-Commands und startet den Health-API-Server.
const { Client, GatewayIntentBits, Events, REST, Routes } = require("discord.js");
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
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
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

client.once(Events.ClientReady, async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`✓ ${client.guilds.cache.size} Guild(s) verbunden`);
    await syncSlashCommands();
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
