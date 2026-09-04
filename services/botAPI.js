/**
 * EselModerator Bot - HTTP API Server
 *
 * Phase 1: nur /health (oeffentlich) und ein Bearer-geschuetztes Grundgeruest fuer spaetere
 * Routen. /premium/activate (fuer shop.eselbande.com) kommt in Phase 3, sobald es Features
 * gibt, die es gating -- Muster identisch zu fahrstuhl/services/botAPI.js.
 */

const express = require('express');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, PermissionsBitField } = require('discord.js');
const APIResponse = require('./apiResponse');
const { getGuildConfig, setGuildConfig } = require('../utils/config');
const { normalizeReactionRoleRows, normalizeReactionRolePanels } = require('../utils/reactionRoles');
const {
    buildTicketPanel,
    colorToHex,
    normalizeTicketPanelInfo,
    normalizeTicketPanels,
    normalizeTicketSlaMinutes,
    normalizeTicketTypes,
    resolveTicketPanelDesign,
} = require('../utils/ticketPanel');
const ticketStore = require('../utils/ticketStore');
const premiumManager = require('../utils/premiumManager');
const { normalizeAutoModSettings } = require('../utils/automod');
const levelingManager = require('../utils/levelingManager');
const { parseBoolean } = require('../utils/valueParsers');
const socialNotifier = require('../utils/socialNotifier');
const freeGamesNotifier = require('../utils/freeGamesNotifier');

const MODULE_KEYS = ['moderation', 'automod', 'welcome', 'reactionRoles', 'leveling', 'tempVoice', 'tickets', 'social'];

function discordImageUrl(value) {
    const url = String(value || '').trim();
    return /^https?:\/\//i.test(url) ? url.slice(0, 500) : '';
}

function booleanWithDefault(value, fallback = false) {
    const { parseBoolean } = require('../utils/valueParsers');
    return parseBoolean(value, fallback);
}

function ticketPanelBoolean(bodyValue, existingValue, fallback) {
    const source = bodyValue === undefined || bodyValue === null ? existingValue : bodyValue;
    return booleanWithDefault(source, fallback);
}

// Panel-Design liegt im selben Config-Blob wie die Verhaltens-Einstellungen -- Settings-Route
// und Panel-Deploy-Route loesen es beide gleich auf.
function ticketPanelSettingsFromBody(body = {}, existing = {}) {
    const current = existing && typeof existing === 'object' ? existing : {};
    const design = resolveTicketPanelDesign(current);
    const text = (value, fallbackValue, maxLength) => {
        const raw = String(value ?? '').trim();
        return (raw || fallbackValue).slice(0, maxLength);
    };
    return {
        panelTitle: text(body?.panelTitle, design.title, 120),
        panelDescription: text(body?.panelDescription, design.description, 1200),
        panelButtonLabel: text(body?.panelButtonLabel, design.buttonLabel, 80),
        panelPlaceholder: text(body?.panelPlaceholder, design.placeholder, 150),
        panelFooterText: text(body?.panelFooterText, design.footerText, 2048),
        panelBrandName: text(body?.panelBrandName, design.brandName, 100),
        panelBannerUrl: discordImageUrl(body?.panelBannerUrl ?? current.panelBannerUrl ?? ''),
        panelColor: colorToHex(body?.panelColor ?? current.panelColor),
        panelShowLiveStatus: ticketPanelBoolean(body?.panelShowLiveStatus, current.panelShowLiveStatus, true),
        panelShowStaffOnline: ticketPanelBoolean(body?.panelShowStaffOnline, current.panelShowStaffOnline, true),
        panelShowQueue: ticketPanelBoolean(body?.panelShowQueue, current.panelShowQueue, true),
        panelShowRating: ticketPanelBoolean(body?.panelShowRating, current.panelShowRating, true),
    };
}

// Verweise auf geloeschte Kanaele/Rollen stillschweigend entfernen statt den ganzen Save
// abzulehnen, wenn z.B. eine Staff-Rolle auf Discord-Seite geloescht wurde.
function sanitizeTicketCategoriesForGuild(guild, rawCategories) {
    return normalizeTicketTypes(rawCategories).map(category => ({
        ...category,
        categoryId: category.categoryId && guild.channels.cache.get(category.categoryId)?.type === 4
            ? category.categoryId
            : null,
        staffRoleId: category.staffRoleId && guild.roles.cache.has(category.staffRoleId)
            ? category.staffRoleId
            : null,
    }));
}

class BotAPIServer {
    constructor(client) {
        this.client = client;
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        this.app.use(express.json({ limit: '2mb' }));

        this.app.use((req, res, next) => {
            if (req.path === '/health') return next();

            const expectedToken = process.env.BOT_API_TOKEN;
            if (!expectedToken) {
                return res.status(503).json(APIResponse.error('BOT_API_TOKEN is not configured', 'BOT_API_TOKEN_MISSING'));
            }
            const auth = req.headers.authorization || '';
            if (auth !== `Bearer ${expectedToken}`) {
                return res.status(401).json(APIResponse.unauthorized('Invalid API token'));
            }
            next();
        });
    }

    setupRoutes() {
        this.app.get('/health', (req, res) => {
            const discordBereit = this.client.isReady?.() === true && this.client.ws?.status === 0;
            res.json(APIResponse.success({
                bot: this.client.user ? this.client.user.username : 'offline',
                uptime: this.client.uptime,
                guilds: this.client.guilds.cache.size,
                discord: {
                    bereit: discordBereit,
                    wsStatus: this.client.ws?.status ?? null,
                    pingMs: this.client.ws?.ping ?? null,
                },
            }, 'Bot is healthy', 'HEALTH_OK'));
        });

        // --- Generische Endpunkte, die (fast) jede Dashboard-Seite braucht ---

        this.app.get('/guilds', (req, res) => {
            const guilds = [...this.client.guilds.cache.values()].map(g => ({
                id: g.id,
                name: g.name,
                icon: g.iconURL({ size: 64 }) || null,
                memberCount: g.memberCount,
            }));
            res.json(APIResponse.success({ guilds }, 'Guilds fetched', 'GUILDS_OK'));
        });

        this.app.get('/guilds/:guildId/context', async (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));

            const categories = guild.channels.cache
                .filter(c => c.type === 4)
                .map(c => ({ id: c.id, name: c.name, position: c.position }))
                .sort((a, b) => a.position - b.position);
            const channels = guild.channels.cache
                .filter(c => c.type === 0 && !c.isThread?.())
                .map(c => ({ id: c.id, name: c.name, position: c.position, parentId: c.parentId }))
                .sort((a, b) => a.position - b.position);
            const voiceChannels = guild.channels.cache
                .filter(c => c.type === 2)
                .map(c => ({ id: c.id, name: c.name, position: c.position, parentId: c.parentId }))
                .sort((a, b) => a.position - b.position);
            const roles = guild.roles.cache
                .filter(r => r.name !== '@everyone')
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position, managed: r.managed }))
                .sort((a, b) => b.position - a.position);

            res.json(APIResponse.success({
                guildId: guild.id,
                guildName: guild.name,
                categories,
                channels,
                voiceChannels,
                roles,
            }, 'Guild context fetched', 'GUILD_CONTEXT_OK'));
        });

        this.app.get('/guilds/:guildId/modules', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            const modules = config.modules && typeof config.modules === 'object' ? config.modules : {};
            const result = {};
            for (const key of MODULE_KEYS) result[key] = parseBoolean(modules[key], false);
            res.json(APIResponse.success({ guildId: guild.id, modules: result }, 'Modules fetched', 'MODULES_OK'));
        });

        this.app.post('/guilds/:guildId/modules', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            const current = config.modules && typeof config.modules === 'object' ? config.modules : {};
            const modules = { ...current };
            for (const key of MODULE_KEYS) {
                if (req.body?.[key] !== undefined) modules[key] = parseBoolean(req.body[key], false);
            }
            setGuildConfig(guild.id, { modules });
            res.json(APIResponse.success({ guildId: guild.id, modules }, 'Modules updated', 'MODULES_UPDATED'));
        });

        this.app.get('/guilds/:guildId/premium', async (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const limits = await premiumManager.getGuildFeatureLimits(guild.id, guild.ownerId);
            const tierInfo = await premiumManager.getGuildTier(guild.id, guild.ownerId);
            res.json(APIResponse.success({ guildId: guild.id, featureLimits: limits, ...tierInfo }, 'Premium fetched', 'PREMIUM_OK'));
        });

        // --- AutoMod ---
        this.app.get('/guilds/:guildId/automod', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            res.json(APIResponse.success({
                guildId: guild.id,
                automod: normalizeAutoModSettings(config.automod || {}),
            }, 'AutoMod settings fetched', 'AUTOMOD_OK'));
        });

        this.app.post('/guilds/:guildId/automod', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const automod = normalizeAutoModSettings(req.body || {});
            setGuildConfig(guild.id, { automod });
            res.json(APIResponse.success({ guildId: guild.id, automod }, 'AutoMod settings updated', 'AUTOMOD_UPDATED'));
        });

        // --- Welcome / Goodbye ---
        this.app.get('/guilds/:guildId/welcome', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            const welcome = config.welcome && typeof config.welcome === 'object' ? config.welcome : {};
            res.json(APIResponse.success({ guildId: guild.id, welcome }, 'Welcome settings fetched', 'WELCOME_OK'));
        });

        this.app.post('/guilds/:guildId/welcome', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const body = req.body || {};
            const welcome = {
                welcomeEnabled: parseBoolean(body.welcomeEnabled, true),
                welcomeChannelId: String(body.welcomeChannelId || '').trim() || null,
                welcomeMessage: String(body.welcomeMessage || '').slice(0, 2000),
                welcomeAsEmbed: parseBoolean(body.welcomeAsEmbed, false),
                welcomeEmbedTitle: String(body.welcomeEmbedTitle || '').slice(0, 256),
                welcomeEmbedColor: String(body.welcomeEmbedColor || '').slice(0, 7),
                welcomeCardEnabled: parseBoolean(body.welcomeCardEnabled, false),
                welcomeCardTitle: String(body.welcomeCardTitle || '').slice(0, 256),
                welcomeCardSubtitle: String(body.welcomeCardSubtitle || '').slice(0, 512),
                aiWelcomeEnabled: parseBoolean(body.aiWelcomeEnabled, false),
                aiCharacter: String(body.aiCharacter || 'friendly').slice(0, 32),
                goodbyeEnabled: parseBoolean(body.goodbyeEnabled, false),
                goodbyeChannelId: String(body.goodbyeChannelId || '').trim() || null,
                goodbyeMessage: String(body.goodbyeMessage || '').slice(0, 2000),
                goodbyeAsEmbed: parseBoolean(body.goodbyeAsEmbed, false),
                autoroleEnabled: parseBoolean(body.autoroleEnabled, false),
                autoroleId: String(body.autoroleId || '').trim() || null,
            };
            if (welcome.welcomeChannelId && !guild.channels.cache.get(welcome.welcomeChannelId)) {
                return res.status(400).json(APIResponse.badRequest('Welcome channel not found'));
            }
            if (welcome.goodbyeChannelId && !guild.channels.cache.get(welcome.goodbyeChannelId)) {
                return res.status(400).json(APIResponse.badRequest('Goodbye channel not found'));
            }
            if (welcome.autoroleId && !guild.roles.cache.has(welcome.autoroleId)) {
                return res.status(400).json(APIResponse.badRequest('Autorole not found'));
            }
            setGuildConfig(guild.id, { welcome });
            res.json(APIResponse.success({ guildId: guild.id, welcome }, 'Welcome settings updated', 'WELCOME_UPDATED'));
        });

        // --- Reaction Roles (Panel-Konfiguration; Versand siehe /reaction-roles/send weiter unten) ---
        this.app.get('/guilds/:guildId/reaction-roles', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            const panels = normalizeReactionRolePanels(config.reactionRoles || {});
            res.json(APIResponse.success({ guildId: guild.id, panels }, 'Reaction role panels fetched', 'REACTION_ROLES_OK'));
        });

        this.app.post('/guilds/:guildId/reaction-roles', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            const existing = config.reactionRoles && typeof config.reactionRoles === 'object' ? config.reactionRoles : {};
            const incomingPanels = Array.isArray(req.body?.panels) ? req.body.panels : [];
            const panels = normalizeReactionRolePanels({ panels: incomingPanels.length ? incomingPanels : existing.panels });
            setGuildConfig(guild.id, { reactionRoles: { ...existing, panels } });
            res.json(APIResponse.success({ guildId: guild.id, panels }, 'Reaction role panels updated', 'REACTION_ROLES_UPDATED'));
        });

        // --- Leveling ---
        this.app.get('/guilds/:guildId/leveling', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            res.json(APIResponse.success({
                guildId: guild.id,
                leveling: levelingManager.getLevelSettings(config),
            }, 'Leveling settings fetched', 'LEVELING_OK'));
        });

        this.app.post('/guilds/:guildId/leveling', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            // getLevelSettings() clamped/normalisiert alle Werte -- so speichern wir nie
            // ungueltige Rohdaten, unabhaengig davon was das Formular schickt.
            const leveling = levelingManager.getLevelSettings({ leveling: req.body || {} });
            setGuildConfig(guild.id, { leveling });
            res.json(APIResponse.success({ guildId: guild.id, leveling }, 'Leveling settings updated', 'LEVELING_UPDATED'));
        });

        this.app.get('/guilds/:guildId/leveling/leaderboard', async (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
            const offset = Math.max(0, Number(req.query.offset) || 0);
            const [leaderboard, total] = await Promise.all([
                levelingManager.getLeaderboard(guild.id, limit, offset),
                levelingManager.getLeaderboardTotal(guild.id),
            ]);
            res.json(APIResponse.success({ guildId: guild.id, leaderboard, total }, 'Leaderboard fetched', 'LEADERBOARD_OK'));
        });

        // --- Temp Voice ---
        this.app.get('/guilds/:guildId/tempvoice', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            const tempVoice = config.tempVoice && typeof config.tempVoice === 'object' ? config.tempVoice : {};
            res.json(APIResponse.success({ guildId: guild.id, tempVoice }, 'Temp-voice settings fetched', 'TEMPVOICE_OK'));
        });

        this.app.post('/guilds/:guildId/tempvoice', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const body = req.body || {};
            const hubChannelId = String(body.hubChannelId || '').trim() || null;
            const categoryId = String(body.categoryId || '').trim() || null;
            if (hubChannelId && guild.channels.cache.get(hubChannelId)?.type !== 2) {
                return res.status(400).json(APIResponse.badRequest('Hub channel must be a voice channel'));
            }
            if (categoryId && guild.channels.cache.get(categoryId)?.type !== 4) {
                return res.status(400).json(APIResponse.badRequest('Category not found'));
            }
            const tempVoice = {
                enabled: parseBoolean(body.enabled, false),
                hubChannelId,
                categoryId,
                channelNameTemplate: String(body.channelNameTemplate || "{username}'s Channel").slice(0, 90),
                userLimit: Math.max(0, Math.min(99, Number(body.userLimit) || 0)),
                bitrate: Math.max(0, Math.min(384, Number(body.bitrate) || 0)),
                allowRename: parseBoolean(body.allowRename, true),
                allowLock: parseBoolean(body.allowLock, true),
                allowLimit: parseBoolean(body.allowLimit, true),
                deleteWhenEmpty: parseBoolean(body.deleteWhenEmpty, true),
            };
            setGuildConfig(guild.id, { tempVoice });
            res.json(APIResponse.success({ guildId: guild.id, tempVoice }, 'Temp-voice settings updated', 'TEMPVOICE_UPDATED'));
        });

        // --- Social Alerts (Twitch/YouTube/RSS) ---
        this.app.get('/guilds/:guildId/social', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            res.json(APIResponse.success({
                guildId: guild.id,
                social: socialNotifier.normalizeSettings(config),
            }, 'Social settings fetched', 'SOCIAL_OK'));
        });

        this.app.post('/guilds/:guildId/social', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const body = req.body || {};
            if (body.announcementChannelId && guild.channels.cache.get(body.announcementChannelId)?.type !== 0) {
                return res.status(400).json(APIResponse.badRequest('Announcement channel not found'));
            }
            const social = socialNotifier.normalizeSettings({ social: body });
            setGuildConfig(guild.id, { social });
            res.json(APIResponse.success({ guildId: guild.id, social }, 'Social settings updated', 'SOCIAL_UPDATED'));
        });

        // --- Freegames Notifier ---
        this.app.get('/guilds/:guildId/freegames', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            res.json(APIResponse.success({
                guildId: guild.id,
                freeGames: freeGamesNotifier.normalizeFreeGamesConfig(config),
            }, 'Freegames settings fetched', 'FREEGAMES_OK'));
        });

        this.app.post('/guilds/:guildId/freegames', (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const body = req.body || {};
            if (body.channelId && guild.channels.cache.get(body.channelId)?.type !== 0) {
                return res.status(400).json(APIResponse.badRequest('Channel not found'));
            }
            if (body.mentionRoleId && !guild.roles.cache.has(body.mentionRoleId)) {
                return res.status(400).json(APIResponse.badRequest('Mention role not found'));
            }
            const existing = getGuildConfig(guild.id);
            const current = freeGamesNotifier.normalizeFreeGamesConfig(existing);
            const freeGames = freeGamesNotifier.normalizeFreeGamesConfig({
                freeGames: {
                    ...current,
                    enabled: parseBoolean(body.enabled, false),
                    channelId: String(body.channelId || '').trim() || null,
                    mentionRoleId: String(body.mentionRoleId || '').trim() || null,
                    filter: body.filter === 'serious' ? 'serious' : 'all',
                },
            });
            setGuildConfig(guild.id, { freeGames });
            res.json(APIResponse.success({ guildId: guild.id, freeGames }, 'Freegames settings updated', 'FREEGAMES_UPDATED'));
        });

        this.app.post('/guilds/:guildId/freegames/post-now', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const config = getGuildConfig(guild.id);
                const settings = freeGamesNotifier.normalizeFreeGamesConfig(config);
                if (!settings.channelId) return res.status(400).json(APIResponse.badRequest('Kein Kanal konfiguriert'));
                const channel = guild.channels.cache.get(settings.channelId) || await guild.channels.fetch(settings.channelId).catch(() => null);
                if (!channel?.isTextBased?.()) return res.status(400).json(APIResponse.badRequest('Kanal nicht gefunden'));
                const count = await freeGamesNotifier.postToChannel(channel);
                res.json(APIResponse.success({ guildId: guild.id, posted: count }, 'Freegames posted', 'FREEGAMES_POSTED'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'FREEGAMES_POST_FAILED'));
            }
        });

        // ============ DISCORD SERVER BACKUPS ============
        // 1:1 aus fahrstuhl/services/botAPI.js uebernommen, nur ohne den dort zusaetzlichen
        // getDashboardGuildAccess()-Check -- der globale Bearer-Token + die PHP-seitige
        // isServerAdmin()-Pruefung im Dashboard reichen hier wie bei allen anderen Routen.

        this.app.get('/guilds/:guildId/discord-backups', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const { listGuildBackups } = require('../utils/serverBackup');
                const backups = await listGuildBackups(guild.id);
                res.json(APIResponse.success({ backups, total: backups.length }, 'Backups listed', 'DISCORD_BACKUPS_LIST'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'DISCORD_BACKUPS_LIST_FAILED'));
            }
        });

        this.app.get('/guilds/:guildId/discord-backups/schedule', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const { getBackupSchedule } = require('../utils/serverBackup');
                const schedule = await getBackupSchedule(guild.id);
                res.json(APIResponse.success(schedule, 'Backup schedule fetched', 'DISCORD_BACKUP_SCHEDULE_GET'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'DISCORD_BACKUP_SCHEDULE_GET_FAILED'));
            }
        });

        this.app.post('/guilds/:guildId/discord-backups/schedule', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const { upsertBackupSchedule } = require('../utils/serverBackup');
                const updatedBy = String(req.get('x-dashboard-user-id') || '').trim() || null;
                const schedule = await upsertBackupSchedule(guild.id, {
                    enabled: req.body?.enabled === true,
                    intervalHours: Number(req.body?.intervalHours || 24),
                    retentionCount: Number(req.body?.retentionCount || 10),
                    backupMode: String(req.body?.backupMode || 'full').toLowerCase(),
                }, updatedBy);
                res.json(APIResponse.success(schedule, 'Backup schedule updated', 'DISCORD_BACKUP_SCHEDULE_SET'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'DISCORD_BACKUP_SCHEDULE_SET_FAILED'));
            }
        });

        this.app.post('/guilds/:guildId/discord-backups/create', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const { createBackupJob, createServerBackup } = require('../utils/serverBackup');
                const botConfig = getGuildConfig(guild.id);
                const createdBy = String(req.get('x-dashboard-user-id') || '').trim() || null;
                const jobId = await createBackupJob(guild.id);
                // Sofort antworten -- Backup laeuft im Hintergrund (vermeidet Timeout bei grossen Servern).
                res.json(APIResponse.success({ status: 'queued', jobId }, 'Backup wird im Hintergrund erstellt', 'DISCORD_BACKUP_QUEUED'));
                createServerBackup(guild, botConfig, createdBy, jobId).catch(err => {
                    console.error('[ServerBackup] Background backup failed:', err);
                });
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'DISCORD_BACKUP_CREATE_FAILED'));
            }
        });

        this.app.get('/guilds/:guildId/backup-jobs/:jobId', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const jobId = parseInt(req.params.jobId, 10);
                if (!Number.isFinite(jobId) || jobId < 1) return res.status(400).json(APIResponse.badRequest('Invalid job ID'));
                const { getBackupJob } = require('../utils/serverBackup');
                const job = await getBackupJob(jobId);
                if (!job || job.guildId !== guild.id) return res.status(404).json(APIResponse.notFound('Job not found'));
                res.json(APIResponse.success(job, 'Job status', 'BACKUP_JOB_STATUS'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'BACKUP_JOB_STATUS_FAILED'));
            }
        });

        this.app.get('/guilds/:guildId/backup-jobs/latest', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const { getLatestRunningBackupJob } = require('../utils/serverBackup');
                const job = await getLatestRunningBackupJob(guild.id);
                if (!job) return res.status(404).json(APIResponse.notFound('No running job'));
                res.json(APIResponse.success(job, 'Latest running backup job', 'BACKUP_JOB_LATEST'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'BACKUP_JOB_LATEST_FAILED'));
            }
        });

        this.app.get('/guilds/:guildId/discord-backups/:backupId', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const backupId = parseInt(req.params.backupId, 10);
                if (!Number.isFinite(backupId) || backupId < 1) return res.status(400).json(APIResponse.badRequest('Invalid backup ID'));
                const { getBackupById } = require('../utils/serverBackup');
                const backup = await getBackupById(backupId, guild.id);
                if (!backup) return res.status(404).json(APIResponse.notFound('Backup not found'));
                const filename = `discord-backup-${guild.id}-${backup.meta.createdAt}.json`;
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                res.send(JSON.stringify(backup, null, 2));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'DISCORD_BACKUP_DOWNLOAD_FAILED'));
            }
        });

        this.app.delete('/guilds/:guildId/discord-backups/:backupId', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const backupId = parseInt(req.params.backupId, 10);
                if (!Number.isFinite(backupId) || backupId < 1) return res.status(400).json(APIResponse.badRequest('Invalid backup ID'));
                const { deleteBackup } = require('../utils/serverBackup');
                const deleted = await deleteBackup(backupId, guild.id);
                if (!deleted) return res.status(404).json(APIResponse.notFound('Backup not found'));
                res.json(APIResponse.success({ backupId }, 'Backup deleted', 'DISCORD_BACKUP_DELETED'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'DISCORD_BACKUP_DELETE_FAILED'));
            }
        });

        this.app.post('/guilds/:guildId/discord-backups/restore', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Target guild not found or bot is not in it'));
                const backupId = parseInt(req.body?.backupId, 10);
                if (!Number.isFinite(backupId) || backupId < 1) return res.status(400).json(APIResponse.badRequest('Invalid backup ID'));
                const { getBackupMetaById } = require('../utils/serverBackup');
                const backupMeta = await getBackupMetaById(backupId);
                if (!backupMeta) return res.status(404).json(APIResponse.notFound('Backup not found'));
                const options = {
                    settings: req.body?.options?.settings === true,
                    roles: req.body?.options?.roles !== false,
                    channels: req.body?.options?.channels !== false,
                    emojis: req.body?.options?.emojis === true,
                    messages: req.body?.options?.messages !== false,
                    autoVerify: req.body?.options?.autoVerify !== false,
                    wipeExisting: req.body?.options?.wipeExisting === true,
                    messageMode: String(req.body?.options?.messageMode || 'embed').toLowerCase(),
                    sourceGuildId: backupMeta.guildId,
                };
                const { createRestoreJob, restoreServerBackup } = require('../utils/serverBackup');
                const jobId = await createRestoreJob(backupId, guild.id);
                res.json(APIResponse.success({ status: 'queued', jobId, targetGuild: guild.name, sourceGuildId: backupMeta.guildId }, 'Restore wird im Hintergrund ausgeführt', 'DISCORD_BACKUP_RESTORE_QUEUED'));
                restoreServerBackup(guild, backupId, options, jobId).catch(err => {
                    console.error('[ServerBackup] Background restore failed:', err);
                });
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'DISCORD_BACKUP_RESTORE_FAILED'));
            }
        });

        this.app.post('/guilds/:guildId/discord-backups/restore-preview', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Target guild not found or bot is not in it'));
                const backupId = parseInt(req.body?.backupId, 10);
                if (!Number.isFinite(backupId) || backupId < 1) return res.status(400).json(APIResponse.badRequest('Invalid backup ID'));
                const { getBackupMetaById, getRestorePreview } = require('../utils/serverBackup');
                const backupMeta = await getBackupMetaById(backupId);
                if (!backupMeta) return res.status(404).json(APIResponse.notFound('Backup not found'));
                const options = {
                    settings: req.body?.options?.settings === true,
                    roles: req.body?.options?.roles !== false,
                    channels: req.body?.options?.channels !== false,
                    emojis: req.body?.options?.emojis === true,
                    messages: req.body?.options?.messages !== false,
                    autoVerify: req.body?.options?.autoVerify !== false,
                    wipeExisting: req.body?.options?.wipeExisting === true,
                    sourceGuildId: backupMeta.guildId,
                };
                const preview = await getRestorePreview(guild, backupId, options);
                res.json(APIResponse.success(preview, 'Restore preview generated', 'DISCORD_BACKUP_RESTORE_PREVIEW'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'DISCORD_BACKUP_RESTORE_PREVIEW_FAILED'));
            }
        });

        this.app.post('/guilds/:guildId/discord-backups/verify', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Target guild not found'));
                const backupId = parseInt(req.body?.backupId, 10);
                if (!Number.isFinite(backupId) || backupId < 1) return res.status(400).json(APIResponse.badRequest('Invalid backup ID'));
                const { getBackupMetaById, verifyRestoreOutcome } = require('../utils/serverBackup');
                const backupMeta = await getBackupMetaById(backupId);
                if (!backupMeta) return res.status(404).json(APIResponse.notFound('Backup not found'));
                const report = await verifyRestoreOutcome(guild, backupId, { sourceGuildId: backupMeta.guildId });
                res.json(APIResponse.success(report, 'Restore verification generated', 'DISCORD_BACKUP_VERIFY_OK'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'DISCORD_BACKUP_VERIFY_FAILED'));
            }
        });

        this.app.get('/guilds/:guildId/restore-jobs/:jobId', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const jobId = parseInt(req.params.jobId, 10);
                if (!Number.isFinite(jobId) || jobId < 1) return res.status(400).json(APIResponse.badRequest('Invalid job ID'));
                const { getRestoreJob } = require('../utils/serverBackup');
                const job = await getRestoreJob(jobId);
                if (!job || job.targetGuildId !== guild.id) return res.status(404).json(APIResponse.notFound('Job not found'));
                res.json(APIResponse.success(job, 'Job status', 'RESTORE_JOB_STATUS'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'RESTORE_JOB_STATUS_FAILED'));
            }
        });

        this.app.get('/guilds/:guildId/restore-jobs/latest', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
                const { getLatestRunningRestoreJob } = require('../utils/serverBackup');
                const job = await getLatestRunningRestoreJob(guild.id);
                if (!job) return res.status(404).json(APIResponse.notFound('No running job'));
                res.json(APIResponse.success(job, 'Latest running restore job', 'RESTORE_JOB_LATEST'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'RESTORE_JOB_LATEST_FAILED'));
            }
        });

        // --- Moderation: Fall-Historie ---
        this.app.get('/guilds/:guildId/moderation/cases', async (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const { getPool } = require('../utils/db');
            const pool = getPool();
            const page = Math.max(1, Number(req.query.page) || 1);
            const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize) || 20));
            const typeArg = req.query.type ? String(req.query.type) : null;
            const userIdArg = req.query.userId ? String(req.query.userId) : null;

            const params = [guild.id];
            let where = 'guild_id = ?';
            if (typeArg) { where += ' AND type = ?'; params.push(typeArg); }
            if (userIdArg) { where += ' AND user_id = ?'; params.push(userIdArg); }

            const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM moderation_cases WHERE ${where}`, params);
            const totalCount = Number(total) || 0;
            const queryParams = [...params, pageSize, (page - 1) * pageSize];
            const [rows] = await pool.query(
                `SELECT id, user_id, moderator_id, type, reason, status, duration_ms, expires_at, created_at, updated_at
                 FROM moderation_cases WHERE ${where}
                 ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                queryParams
            );
            res.json(APIResponse.success({
                guildId: guild.id, cases: rows, total: totalCount, page, pageSize,
            }, 'Moderation cases fetched', 'MODERATION_CASES_OK'));
        });

        // Minimale Verwaltungs-API fuer Reaction-Role-Panels, solange es noch kein eigenes
        // Dashboard gibt -- gleiches Muster wie fahrstuhl/services/botAPI.js's
        // /reaction-roles/send-Route, per Bearer-Token abgesichert (siehe setupMiddleware).
        this.app.post('/guilds/:guildId/reaction-roles/send', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));

                const config = getGuildConfig(guild.id);
                const reactionRoles = config.reactionRoles && typeof config.reactionRoles === 'object' ? config.reactionRoles : {};
                const modules = config.modules && typeof config.modules === 'object' ? config.modules : {};
                if (!modules.reactionRoles) {
                    return res.status(400).json(APIResponse.badRequest('Enable the reactionRoles module first (config.modules.reactionRoles)'));
                }

                const panels = normalizeReactionRolePanels(reactionRoles);
                const panelId = String(req.body?.panelId || reactionRoles.panelId || panels[0]?.id || 'default');
                const panel = panels.find(item => item.id === panelId) || panels[0];
                if (!panel) return res.status(400).json(APIResponse.badRequest('Configure at least one reaction role panel first'));

                const channelId = String(req.body?.channelId || panel.channelId || reactionRoles.channelId || '').trim();
                const channel = channelId
                    ? (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null))
                    : null;
                if (!channel || channel.type !== 0 || channel.isThread?.()) {
                    return res.status(400).json(APIResponse.badRequest('Please choose a text channel'));
                }
                const roles = normalizeReactionRoleRows(panel.roles);
                if (!roles.length) return res.status(400).json(APIResponse.badRequest('Configure at least one role first'));
                if (!(guild.members.me?.permissionsIn(channel)?.has(PermissionsBitField.Flags.SendMessages) ?? false)) {
                    return res.status(400).json(APIResponse.badRequest('EselModerator cannot send messages in this channel'));
                }

                const embed = new EmbedBuilder()
                    .setColor(0x667EEA)
                    .setTitle(panel.title || 'Choose your roles')
                    .setDescription(panel.description || 'Use the controls below to add or remove roles.');
                if (panel.thumbnailUrl) embed.setThumbnail(panel.thumbnailUrl);
                if (panel.imageUrl) embed.setImage(panel.imageUrl);
                if (panel.footerText) embed.setFooter({ text: panel.footerText });
                if (panel.authorText) embed.setAuthor({ name: panel.authorText });

                const row = new ActionRowBuilder();
                if (panel.mode === 'select') {
                    const selectRoles = roles.slice(0, 25);
                    const maxValues = panel.exclusive ? 1 : Math.min(selectRoles.length, 25);
                    row.addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId(`rrs:${panel.id}`)
                            .setPlaceholder(panel.exclusive ? 'Choose one role' : 'Choose roles')
                            .setMinValues(0)
                            .setMaxValues(maxValues)
                            .addOptions(selectRoles.map(item => {
                                const role = guild.roles.cache.get(item.roleId);
                                const option = { label: item.label || role?.name || 'Role', value: item.roleId };
                                if (item.emoji) option.emoji = item.emoji;
                                return option;
                            }))
                    );
                } else {
                    row.addComponents(roles.slice(0, 5).map(item => {
                        const role = guild.roles.cache.get(item.roleId);
                        const button = new ButtonBuilder()
                            .setCustomId(`rr:${panel.id}:${item.roleId}`)
                            .setLabel(item.label || role?.name || 'Role')
                            .setStyle(ButtonStyle.Secondary);
                        if (item.emoji) button.setEmoji(item.emoji);
                        return button;
                    }));
                }

                let message = null;
                if (panel.lastPanelChannelId && panel.lastPanelMessageId) {
                    const existingChannel = guild.channels.cache.get(panel.lastPanelChannelId)
                        || await guild.channels.fetch(panel.lastPanelChannelId).catch(() => null);
                    if (existingChannel?.messages) {
                        const existingMessage = await existingChannel.messages.fetch(panel.lastPanelMessageId).catch(() => null);
                        if (existingMessage) message = await existingMessage.edit({ embeds: [embed], components: [row] }).catch(() => null);
                    }
                }
                if (!message) message = await channel.send({ embeds: [embed], components: [row] });

                const updatedPanel = { ...panel, channelId, lastPanelChannelId: channel.id, messageId: message.id, lastPanelMessageId: message.id };
                const updatedPanels = panels.map(item => item.id === panel.id ? updatedPanel : item);
                setGuildConfig(guild.id, { reactionRoles: { ...reactionRoles, panels: updatedPanels } });

                res.json(APIResponse.success({
                    guildId: guild.id,
                    channelId: channel.id,
                    panelId: panel.id,
                    messageId: message.id,
                    url: message.url,
                }, 'Reaction role panel sent', 'REACTION_ROLE_PANEL_SENT'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'REACTION_ROLE_PANEL_SEND_FAILED'));
            }
        });

        // Minimale Ticket-Verwaltungs-API, solange es noch kein eigenes Dashboard gibt --
        // Muster + Logik 1:1 aus fahrstuhl/services/botAPI.js's Ticket-Routen (inkl. der
        // Multi-Panel-Unterstuetzung dieser Session), nur ohne die dashboard-spezifische
        // Zugriffspruefung (hier reicht der globale Bearer-Token).
        this.app.get('/guilds/:guildId/tickets', async (req, res) => {
            const guild = this.client.guilds.cache.get(req.params.guildId);
            if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));
            const config = getGuildConfig(guild.id);
            const tickets = config.tickets && typeof config.tickets === 'object' ? config.tickets : {};
            const panels = normalizeTicketPanels(tickets);
            const stats = await ticketStore.getTicketStats(guild.id, { slaMinutes: tickets.slaMinutes || 240 }).catch(() => null);
            res.json(APIResponse.success({ guildId: guild.id, tickets, panels, stats }, 'Ticket settings fetched', 'TICKETS_OK'));
        });

        this.app.post('/guilds/:guildId/tickets', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));

                const categoryId = String(req.body?.categoryId || '').trim();
                const staffRoleId = String(req.body?.staffRoleId || '').trim();
                const transcriptChannelId = String(req.body?.transcriptChannelId || '').trim();
                if (categoryId && guild.channels.cache.get(categoryId)?.type !== 4) {
                    return res.status(400).json(APIResponse.badRequest('Ticket category not found'));
                }
                if (transcriptChannelId && guild.channels.cache.get(transcriptChannelId)?.type !== 0) {
                    return res.status(400).json(APIResponse.badRequest('Transcript channel not found'));
                }
                if (staffRoleId && !guild.roles.cache.has(staffRoleId)) {
                    return res.status(400).json(APIResponse.badRequest('Staff role not found'));
                }

                const config = getGuildConfig(guild.id);
                const tickets = {
                    ...(config.tickets || {}),
                    categoryId: categoryId || null,
                    staffRoleId: staffRoleId || null,
                    transcriptChannelId: transcriptChannelId || null,
                    defaultPriority: ['low', 'normal', 'high'].includes(req.body?.defaultPriority) ? req.body.defaultPriority : 'normal',
                    closeDelaySeconds: Math.max(1, Math.min(30, Number(req.body?.closeDelaySeconds) || 5)),
                    slaMinutes: normalizeTicketSlaMinutes(req.body?.slaMinutes, 240),
                    requireCloseReason: booleanWithDefault(req.body?.requireCloseReason, false),
                    enableClaiming: booleanWithDefault(req.body?.enableClaiming, true),
                    enableTicketTypes: booleanWithDefault(req.body?.enableTicketTypes, false),
                    ticketTypes: sanitizeTicketCategoriesForGuild(guild, req.body?.ticketTypes),
                    ...ticketPanelSettingsFromBody(req.body, config.tickets),
                    ticketPanelInfo: normalizeTicketPanelInfo(req.body?.ticketPanelInfo || config.tickets?.ticketPanelInfo),
                };
                setGuildConfig(guild.id, { tickets });

                const deployedPanels = normalizeTicketPanels(tickets);
                if (deployedPanels.length) {
                    const panelStats = await ticketStore.getTicketStats(guild.id, { slaMinutes: tickets.slaMinutes });
                    const panel = buildTicketPanel({ guild, settings: tickets, ticketStats: panelStats });
                    for (const { channelId, messageId } of deployedPanels) {
                        const panelChannel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
                        if (!panelChannel?.isTextBased?.()) continue;
                        const panelMessage = await panelChannel.messages.fetch(messageId).catch(() => null);
                        if (panelMessage) await panelMessage.edit(panel).catch(() => {});
                    }
                }

                res.json(APIResponse.success({ guildId: guild.id, tickets }, 'Ticket settings updated', 'TICKET_SETTINGS_UPDATED'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'TICKET_SETTINGS_UPDATE_FAILED'));
            }
        });

        this.app.post('/guilds/:guildId/tickets/panel', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));

                const config = getGuildConfig(guild.id);
                const channelId = String(req.body?.channelId || '').trim();
                const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
                if (!channel || !channel.isTextBased?.()) {
                    return res.status(400).json(APIResponse.badRequest('Kanal nicht gefunden oder kein Text-Kanal'));
                }
                const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
                if (botMember) {
                    const perms = channel.permissionsFor(botMember);
                    if (!perms?.has('SendMessages')) return res.status(400).json(APIResponse.badRequest('EselModerator hat keine Schreibberechtigung in diesem Kanal'));
                    if (!perms?.has('EmbedLinks')) return res.status(400).json(APIResponse.badRequest('EselModerator benötigt die Berechtigung "Links einbetten" in diesem Kanal'));
                }

                const incomingTicketSettings = {
                    categoryId: String(req.body?.categoryId || '').trim() || null,
                    staffRoleId: String(req.body?.staffRoleId || '').trim() || null,
                    transcriptChannelId: String(req.body?.transcriptChannelId || '').trim() || null,
                    defaultPriority: ['low', 'normal', 'high'].includes(req.body?.defaultPriority) ? req.body.defaultPriority : 'normal',
                    closeDelaySeconds: Math.max(1, Math.min(30, Number(req.body?.closeDelaySeconds) || 5)),
                    slaMinutes: normalizeTicketSlaMinutes(req.body?.slaMinutes, 240),
                    requireCloseReason: booleanWithDefault(req.body?.requireCloseReason, false),
                    enableClaiming: booleanWithDefault(req.body?.enableClaiming, true),
                    enableTicketTypes: booleanWithDefault(req.body?.enableTicketTypes, false),
                    ticketTypes: sanitizeTicketCategoriesForGuild(guild, req.body?.ticketTypes),
                    ticketPanelInfo: normalizeTicketPanelInfo(req.body?.ticketPanelInfo || config.tickets?.ticketPanelInfo),
                };
                const settings = {
                    ...(config.tickets && typeof config.tickets === 'object' ? config.tickets : {}),
                    ...incomingTicketSettings,
                    ...ticketPanelSettingsFromBody(req.body, config.tickets),
                };
                const panelStats = await ticketStore.getTicketStats(guild.id, { slaMinutes: settings.slaMinutes });
                const panel = buildTicketPanel({ guild, settings, ticketStats: panelStats });

                // Ein Server kann mehrere Panels haben (eins pro Kanal); erneutes Senden in
                // einen Kanal mit bereits aktivem Panel aktualisiert dieses statt ein neues
                // zu zaehlen.
                const existingPanels = normalizeTicketPanels(config.tickets);
                const existingPanelIndex = existingPanels.findIndex(p => p.channelId === channel.id);
                const isNewPanelDeployment = existingPanelIndex === -1;
                const limits = await premiumManager.getGuildFeatureLimits(guild.id, guild.ownerId);
                if (limits.ticketPanels >= 0 && isNewPanelDeployment && existingPanels.length >= limits.ticketPanels) {
                    return res.status(403).json({ success: false, error: 'Feature limit reached', code: 'LIMIT_REACHED', limitKey: 'ticketPanels', limit: limits.ticketPanels, current: existingPanels.length, upgrade: true });
                }

                let message = null;
                if (!isNewPanelDeployment) {
                    const existingMsg = await channel.messages.fetch(existingPanels[existingPanelIndex].messageId).catch(() => null);
                    if (existingMsg) message = await existingMsg.edit(panel).catch(() => null);
                }
                if (!message) message = await channel.send(panel);

                const updatedPanels = [...existingPanels];
                if (isNewPanelDeployment) updatedPanels.push({ channelId: channel.id, messageId: message.id });
                else updatedPanels[existingPanelIndex] = { channelId: channel.id, messageId: message.id };

                setGuildConfig(guild.id, { tickets: { ...settings, panels: updatedPanels } });

                res.json(APIResponse.success({
                    guildId: guild.id, channelId: channel.id, messageId: message.id, url: message.url,
                }, 'Ticket panel sent', 'TICKET_PANEL_SENT'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'TICKET_PANEL_SEND_FAILED'));
            }
        });

        this.app.post('/guilds/:guildId/tickets/panel/remove', async (req, res) => {
            try {
                const guild = this.client.guilds.cache.get(req.params.guildId);
                if (!guild) return res.status(404).json(APIResponse.notFound('Guild not found'));

                const channelId = String(req.body?.channelId || '').trim();
                const config = getGuildConfig(guild.id);
                const existingPanels = normalizeTicketPanels(config.tickets);
                const target = existingPanels.find(p => p.channelId === channelId);
                if (!target) return res.status(404).json(APIResponse.notFound('Kein Panel in diesem Kanal gefunden'));

                const channel = guild.channels.cache.get(target.channelId) || await guild.channels.fetch(target.channelId).catch(() => null);
                if (channel?.isTextBased?.()) {
                    const message = await channel.messages.fetch(target.messageId).catch(() => null);
                    if (message) await message.delete().catch(() => {});
                }

                const remainingPanels = existingPanels.filter(p => p.channelId !== channelId);
                setGuildConfig(guild.id, { tickets: { ...(config.tickets || {}), panels: remainingPanels } });

                res.json(APIResponse.success({ guildId: guild.id, channelId, remaining: remainingPanels.length }, 'Ticket panel removed', 'TICKET_PANEL_REMOVED'));
            } catch (error) {
                res.status(500).json(APIResponse.error(error.message, 'TICKET_PANEL_REMOVE_FAILED'));
            }
        });

        // 1:1 aus fahrstuhl/services/botAPI.js uebernommen -- der Endpunkt, den
        // shop.eselbande.com fuer EselModerator-Produkte aufrufen wird (Phase 5).
        this.app.post('/premium/activate', async (req, res) => {
            try {
                const { userId, daysValid = 30, tier = 'basic' } = req.body;
                if (!userId) return res.status(400).json({ error: 'userId required' });
                if (!['basic', 'pro'].includes(tier)) return res.status(400).json({ error: 'tier must be basic or pro' });
                const days = Math.max(1, Math.min(36500, Number(daysValid) || 30));
                const mode = req.body.mode === 'set' ? 'set' : 'extend';

                await premiumManager.activatePremium(userId, days, tier, mode);
                const info = await premiumManager.getUserInfo(userId);

                try {
                    const user = await this.client.users.fetch(userId).catch(() => null);
                    if (user) {
                        const expiresAt = new Date(info.expires_at);
                        const tierLabel = tier === 'pro' ? '👑 Pro' : '💎 Premium';
                        const embed = new EmbedBuilder()
                            .setColor(tier === 'pro' ? 0xFFD700 : 0x4CAF50)
                            .setTitle(`✅ ${tierLabel} Activated`)
                            .setDescription(`You now have **${tierLabel}** access on EselModerator!`)
                            .addFields(
                                { name: 'Tier', value: tierLabel },
                                { name: 'Days', value: String(days) },
                                { name: 'Expires', value: expiresAt.toLocaleString() }
                            )
                            .setTimestamp();
                        user.send({ embeds: [embed] }).catch(() => {});
                    }
                } catch (dmError) {
                    console.error('Error sending premium activation DM:', dmError.message);
                }

                res.json(APIResponse.success({
                    userId, tier: info.tier, isPremium: info.is_premium, expiresAt: info.expires_at,
                }, `${tier} activated for ${days} days`, 'PREMIUM_ACTIVATED'));
            } catch (error) {
                console.error('Premium activation error:', error);
                res.status(500).json(APIResponse.error(error.message, 'PREMIUM_ACTIVATION_FAILED'));
            }
        });

        this.app.post('/premium/deactivate', async (req, res) => {
            try {
                const { userId } = req.body;
                if (!userId) return res.status(400).json(APIResponse.badRequest('userId required'));

                await premiumManager.deactivatePremium(userId);

                try {
                    const user = await this.client.users.fetch(userId).catch(() => null);
                    if (user) {
                        const embed = new EmbedBuilder()
                            .setColor(0xff6b6b)
                            .setTitle('❌ Premium Removed')
                            .setDescription('Your EselModerator Premium access has been removed.')
                            .setTimestamp();
                        user.send({ embeds: [embed] }).catch(() => {});
                    }
                } catch (dmError) {
                    console.error('Error sending premium deactivation DM:', dmError.message);
                }

                res.json(APIResponse.success({ userId }, 'Premium deactivated', 'PREMIUM_DEACTIVATED'));
            } catch (error) {
                console.error('Premium deactivation error:', error);
                res.status(500).json(APIResponse.error(error.message, 'PREMIUM_DEACTIVATION_FAILED'));
            }
        });
    }

    start(port = 3003) {
        this.server = this.app.listen(port, '0.0.0.0', () => {
            console.log(`\n✓ Bot API Server läuft auf Port ${port}`);
        });
        return this.server;
    }

    stop() {
        if (this.server) {
            this.server.close();
            console.log('✓ Bot API Server gestoppt');
        }
    }
}

module.exports = BotAPIServer;
