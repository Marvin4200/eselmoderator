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
                // zu zaehlen. Kein Limit-Check hier (anders als bei fahrstuhl) -- kommt mit
                // den echten Premium-Tier-Definitionen in einer spaeteren Runde.
                const existingPanels = normalizeTicketPanels(config.tickets);
                const existingPanelIndex = existingPanels.findIndex(p => p.channelId === channel.id);
                const isNewPanelDeployment = existingPanelIndex === -1;

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
