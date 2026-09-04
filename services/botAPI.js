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
