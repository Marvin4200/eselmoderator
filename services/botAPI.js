/**
 * EselModerator Bot - HTTP API Server
 *
 * Phase 1: nur /health (oeffentlich) und ein Bearer-geschuetztes Grundgeruest fuer spaetere
 * Routen. /premium/activate (fuer shop.eselbande.com) kommt in Phase 3, sobald es Features
 * gibt, die es gating -- Muster identisch zu fahrstuhl/services/botAPI.js.
 */

const express = require('express');
const APIResponse = require('./apiResponse');

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
