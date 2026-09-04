const axios = require("axios");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { getGuildConfig, setGuildConfig } = require("./config");

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT = 15000;
const MAX_POSTED_IDS = 500;

// Internal Free Games API URL (same Docker network)
const FREE_GAMES_API_URL = process.env.FREE_GAMES_API_URL || "http://freegamesapi:3016";

// Platforms considered "serious" (major stores only)
const SERIOUS_PLATFORMS = ["epic", "gog", "steam"];

function normalizeFreeGamesConfig(config = {}) {
    const fg = config.freeGames && typeof config.freeGames === "object" ? config.freeGames : {};
    return {
        enabled: Boolean(fg.enabled),
        channelId: fg.channelId || null,
        mentionRoleId: fg.mentionRoleId || null,
        postedIds: Array.isArray(fg.postedIds) ? fg.postedIds : [],
        firstRunDone: Boolean(fg.firstRunDone),
        // "all" = everything, "serious" = Epic/GOG/Steam only
        filter: fg.filter === "serious" ? "serious" : "all",
        statusMessageId: fg.statusMessageId || null,
    };
}

// ─── Platform display metadata ────────────────────────────────────────────────

const PLATFORM_META = {
    epic:   { color: 0x0078f2, icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/3/31/Epic_Games_logo.svg/512px-Epic_Games_logo.svg.png" },
    gog:    { color: 0x8B1ACD, icon: "https://www.gog.com/favicon.ico" },
    steam:  { color: 0x1b2838, icon: "https://store.steampowered.com/favicon.ico" },
    humble: { color: 0xcc2929, icon: "https://www.humblebundle.com/favicon.ico" },
    itchio: { color: 0xFA5C5C, icon: "https://static.itch.io/images/favicon.ico" },
};

// ─── Fetch from internal aggregation API ─────────────────────────────────────

async function fetchAllFreeGames() {
    const response = await axios.get(`${FREE_GAMES_API_URL}/free-games`, {
        timeout: REQUEST_TIMEOUT,
        headers: { "User-Agent": "EselModeratorBot/1.0" },
    });

    const games = response.data?.games || [];

    // Attach display metadata (color, icon) based on platform code
    return games.map(game => {
        const meta = PLATFORM_META[game.platform] || { color: 0x5865F2, icon: null };
        return {
            ...game,
            platformColor: meta.color,
            platformIcon: meta.icon,
            // Normalize endDate to Date object if present
            endDate: game.endDate ? new Date(game.endDate) : null,
        };
    });
}

// ─── Embed builder ────────────────────────────────────────────────────────────

function buildGameEmbed(game) {
    const endStr = game.endDate && !isNaN(game.endDate)
        ? game.endDate.toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" })
        : "Unbekannt";

    const embed = new EmbedBuilder()
        .setColor(game.platformColor)
        .setAuthor({
            name: game.platformLabel || game.platform,
            ...(game.platformIcon ? { iconURL: game.platformIcon } : {}),
        })
        .setTitle(`🎮 ${game.title}`)
        .setURL(game.storeUrl)
        .addFields(
            {
                name: "Preis",
                value: game.originalPrice ? `~~${game.originalPrice}~~ → **Gratis**` : "**Gratis**",
                inline: true,
            },
            {
                name: "Gratis bis",
                value: endStr,
                inline: true,
            }
        )
        .setFooter({ text: "EselModerator • Free Games" })
        .setTimestamp();

    if (game.banner) embed.setImage(game.banner);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel(`Im ${game.platformLabel || game.platform} öffnen`)
            .setStyle(ButtonStyle.Link)
            .setURL(game.storeUrl)
            .setEmoji("🎮")
    );

    return { embed, row };
}

function buildStatusEmbed(gamesCount = 0, nextPollAt = null) {
    const nextCheck = nextPollAt ? new Date(nextPollAt) : new Date(Date.now() + POLL_INTERVAL_MS);
    return new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("🔍 Sucht nach kostenlosen Spielen...")
        .setDescription(
            "Der Bot überwacht automatisch Epic Games, GOG, Steam und weitere Stores.\n" +
            "Sobald ein Spiel kostenlos verfügbar ist, erscheint es direkt hier."
        )
        .addFields(
            { name: "🎮 Aktuell im Cache", value: `**${gamesCount}** kostenlose Spiele`, inline: true },
            { name: "🕐 Nächste Prüfung", value: `<t:${Math.floor(nextCheck.getTime() / 1000)}:R>`, inline: true },
        )
        .setFooter({ text: "EselModerator • Suche läuft automatisch" })
        .setTimestamp();
}

const STATUS_REFRESH_MS = 60 * 1000; // update status embed every minute

class FreeGamesNotifier {
    constructor() {
        this.client = null;
        this.timer = null;
        this.statusTimer = null;
        this.running = false;
        this.lastPollAt = null;
        this.cachedGamesCount = 0;
    }

    start(client) {
        if (this.timer) return;
        this.client = client;
        this.timer = setInterval(() => {
            this.runOnce().catch(err =>
                console.error("[FreeGames] Poll failed:", err.message)
            );
        }, POLL_INTERVAL_MS);
        // Refresh status embeds every minute
        this.statusTimer = setInterval(() => {
            this._refreshAllStatusEmbeds().catch(() => {});
        }, STATUS_REFRESH_MS);
        // Initial run after 30s to let the bot settle
        setTimeout(() => {
            this.runOnce().catch(err =>
                console.error("[FreeGames] Initial poll failed:", err.message)
            );
        }, 30000);
        console.log("✅ Free games notifier started (via freegamesapi: Epic, GOG, Steam, Humble, itch.io)");
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        if (this.statusTimer) clearInterval(this.statusTimer);
        this.timer = null;
        this.statusTimer = null;
        this.client = null;
    }

    async _refreshAllStatusEmbeds() {
        if (!this.client) return;
        for (const guild of this.client.guilds.cache.values()) {
            const config = getGuildConfig(guild.id);
            const settings = normalizeFreeGamesConfig(config);
            if (!settings.enabled || !settings.channelId || !settings.statusMessageId) continue;
            const channel =
                guild.channels.cache.get(settings.channelId) ||
                await guild.channels.fetch(settings.channelId).catch(() => null);
            if (!channel?.isTextBased?.()) continue;
            const nextPollAt = this.lastPollAt ? this.lastPollAt + POLL_INTERVAL_MS : null;
            const embed = buildStatusEmbed(this.cachedGamesCount, nextPollAt);
            channel.messages.fetch(settings.statusMessageId)
                .then(msg => msg.edit({ embeds: [embed] }))
                .catch(() => {});
        }
    }

    async runOnce({ force = false } = {}) {
        if (!this.client || this.running) return;
        this.running = true;
        this.lastPollAt = Date.now();
        try {
            const games = await fetchAllFreeGames();
            this.cachedGamesCount = games.length;
            if (!games.length) return;

            for (const guild of this.client.guilds.cache.values()) {
                await this.notifyGuild(guild, games, { force }).catch(err =>
                    console.error(`[FreeGames] Guild ${guild.id} failed:`, err.message)
                );
            }
        } catch (err) {
            console.error("[FreeGames] runOnce failed:", err.message);
        } finally {
            this.running = false;
        }
    }

    async notifyGuild(guild, games, { force = false } = {}) {
        const config = getGuildConfig(guild.id);
        const settings = normalizeFreeGamesConfig(config);

        if (!settings.enabled || !settings.channelId) return;

        const channel =
            guild.channels.cache.get(settings.channelId) ||
            (await guild.channels.fetch(settings.channelId).catch(() => null));

        if (!channel?.isTextBased?.()) return;

        // On first run after setup, mark existing games as seen without posting (anti-spam)
        if (!settings.firstRunDone && !force) {
            const seenIds = games.map(g => g.id).filter(Boolean);
            const newSettings = { ...settings, postedIds: seenIds, firstRunDone: true };
            setGuildConfig(guild.id, { freeGames: newSettings });
            // Post status embed so the channel looks active right away
            await this._refreshStatusEmbed(channel, guild.id, newSettings, games.length, true).catch(() => {});
            return;
        }

        // Apply platform filter if configured
        const filteredGames = settings.filter === "serious"
            ? games.filter(g => SERIOUS_PLATFORMS.includes(g.platform))
            : games;

        const newGames = filteredGames.filter(g => g.id && !settings.postedIds.includes(g.id));
        if (!newGames.length && !force) {
            // No new games – silently update the status embed in place
            await this._refreshStatusEmbed(channel, guild.id, settings, games.length, false).catch(() => {});
            return;
        }

        const gamesToPost = force ? filteredGames : newGames;
        const mention = settings.mentionRoleId ? `<@&${settings.mentionRoleId}> ` : "";

        // Remove old status embed so the new one appears below the game posts
        if (settings.statusMessageId) {
            await channel.messages.fetch(settings.statusMessageId)
                .then(m => m.delete())
                .catch(() => {});
        }

        for (const game of gamesToPost) {
            try {
                const { embed, row } = buildGameEmbed(game);
                await channel.send({
                    content: mention || undefined,
                    embeds: [embed],
                    components: [row],
                });
            } catch (err) {
                console.error(`[FreeGames] Failed to post "${game.title}":`, err.message);
            }
        }

        let updatedSettings = settings;
        if (!force) {
            const updatedIds = [...settings.postedIds, ...newGames.map(g => g.id).filter(Boolean)];
            const trimmed = updatedIds.slice(-MAX_POSTED_IDS);
            updatedSettings = { ...settings, postedIds: trimmed, firstRunDone: true };
            setGuildConfig(guild.id, { freeGames: updatedSettings });
        }

        // Post new status embed at the bottom (after the game posts)
        await this._refreshStatusEmbed(channel, guild.id, updatedSettings, games.length, true).catch(() => {});
    }

    async _refreshStatusEmbed(channel, guildId, settings, gamesCount, forceNew = false) {
        const nextPollAt = this.lastPollAt ? this.lastPollAt + POLL_INTERVAL_MS : null;
        const embed = buildStatusEmbed(gamesCount, nextPollAt);
        if (!forceNew && settings.statusMessageId) {
            try {
                const msg = await channel.messages.fetch(settings.statusMessageId);
                await msg.edit({ embeds: [embed] });
                return;
            } catch {
                // Message deleted or not found – fall through to post a new one
            }
        }
        const msg = await channel.send({ embeds: [embed] });
        setGuildConfig(guildId, {
            freeGames: { ...settings, statusMessageId: msg.id },
        });
    }
}

const freeGamesNotifier = new FreeGamesNotifier();

freeGamesNotifier.postToChannel = async function (channel) {
    const games = await fetchAllFreeGames();
    if (!games.length) return 0;
    for (const game of games) {
        const { embed, row } = buildGameEmbed(game);
        await channel.send({ embeds: [embed], components: [row] });
    }
    return games.length;
};

freeGamesNotifier.postStatusEmbed = async function (channel, guildId) {
    const config = getGuildConfig(guildId);
    const settings = normalizeFreeGamesConfig(config);
    const games = await fetchAllFreeGames().catch(() => []);
    await freeGamesNotifier._refreshStatusEmbed(channel, guildId, settings, games.length, true);
};

module.exports = freeGamesNotifier;
module.exports.normalizeFreeGamesConfig = normalizeFreeGamesConfig;
