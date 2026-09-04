// EselModerator -- Phase 1: Grundgeruest.
//
// Loggt sich bei Discord ein, initialisiert die eigene MySQL-DB und das eigene
// Premium-System, startet den Health-API-Server. Noch OHNE migrierte Features
// (Moderation/AutoMod/Leveling/Tickets/... kommen in Phase 2/3, siehe Plan).
const { Client, GatewayIntentBits, Events } = require("discord.js");
require("dotenv").config();

const { initDb } = require("./utils/db");
const premiumManager = require("./utils/premiumManager");
const BotAPIServer = require("./services/botAPI");

// Nur das noetigste Intent fuer Phase 1 (Login + Guild-Liste). GuildMembers/MessageContent
// sind privilegierte Intents, die erst im Discord Developer Portal manuell freigeschaltet
// werden muessen -- kommen dazu, sobald Phase 2/3 Features sie tatsaechlich brauchen.
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
    ],
});

// Sauberes Shutdown-Handling nach demselben Muster wie fahrstuhl/index.js: alle laufenden
// Intervalle hier sammeln, damit sie beim Beenden gezielt geraeumt werden koennen.
const activeIntervals = [];

client.once(Events.ClientReady, async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`✓ ${client.guilds.cache.size} Guild(s) verbunden`);
});

async function main() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        console.error("❌ DISCORD_TOKEN fehlt in .env.");
        process.exit(1);
    }

    await initDb({
        host: process.env.MYSQL_HOST || "127.0.0.1",
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || "root",
        password: process.env.MYSQL_PASSWORD || "",
        database: process.env.MYSQL_DATABASE || "eselmoderator",
    });
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
