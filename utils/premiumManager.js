/**
 * Premium Manager -- EselModerator
 *
 * Eigenes, von Fahrstuhl unabhaengiges Premium-System. Echte Tier-Limits (Ticket-Panels,
 * AutoMod-Regeln, XP-Multiplikator etc.) kommen modulweise in Phase 2/3 dazu, sobald die
 * jeweiligen Features portiert sind -- Platzhalter hier bewusst minimal gehalten.
 */

const PremiumDatabase = require('./premiumDatabase');

class PremiumManager {
    constructor() {
        this.db = PremiumDatabase;
    }

    async initialize() {
        await this.db.init();
        console.log('✓ Premium Manager initialized');
    }

    async isPremium(userId) {
        return await this.db.isPremium(userId);
    }

    async isPro(userId) {
        return await this.db.isPro(userId);
    }

    // mode: 'extend' (default, verlaengert Restzeit) | 'set' (absolute Laufzeit)
    async activatePremium(userId, daysValid = 30, tier = 'basic', mode = 'extend') {
        await this.db.activate(userId, daysValid, tier, mode);
        return await this.db.getUserInfo(userId);
    }

    async activatePro(userId, daysValid = 30) {
        return this.activatePremium(userId, daysValid, 'pro');
    }

    async deactivatePremium(userId) {
        await this.db.deactivate(userId);
    }

    async getUserInfo(userId) {
        return await this.db.getUserInfo(userId);
    }

    async getAllPremium() {
        return await this.db.getAllPremium();
    }

    async getGuildTier(guildId, ownerId = null) {
        const plan = await this.db.getGuildPlan(guildId);
        if (plan) {
            return {
                tier: plan.tier === 'pro' ? 'pro' : 'basic',
                hasPremium: true,
                isPro: plan.tier === 'pro',
                expiresAt: plan.expires_at,
                source: 'guild',
                purchasedBy: plan.purchased_by || null,
            };
        }

        if (ownerId) {
            const ownerPremium = await this.isPremium(ownerId);
            if (ownerPremium) {
                const ownerPro = await this.isPro(ownerId);
                const info = await this.getUserInfo(ownerId);
                return {
                    tier: ownerPro ? 'pro' : 'basic',
                    hasPremium: true,
                    isPro: ownerPro,
                    expiresAt: info ? info.expires_at : null,
                    source: 'owner',
                    purchasedBy: ownerId,
                };
            }
        }

        return { tier: 'free', hasPremium: false, isPro: false, expiresAt: null, source: 'none', purchasedBy: null };
    }

    async activateGuildPlan(guildId, daysValid = 30, tier = 'basic', purchasedBy = null, mode = 'extend') {
        return await this.db.activateGuild(guildId, daysValid, tier, purchasedBy, mode);
    }

    async deactivateGuildPlan(guildId) {
        await this.db.deactivateGuild(guildId);
    }

    async getAllGuildPlans() {
        return await this.db.getAllGuildPlans();
    }

    async wasEventProcessed(eventId) {
        return await this.db.wasEventProcessed(eventId);
    }

    async markEventProcessed(eventId, source = 'paddle') {
        return await this.db.markEventProcessed(eventId, source);
    }

    async wasReminderSent(targetKey, expiresAt, milestone) {
        return await this.db.wasReminderSent(targetKey, expiresAt, milestone);
    }

    async markReminderSent(targetKey, expiresAt, milestone) {
        return await this.db.markReminderSent(targetKey, expiresAt, milestone);
    }

    async pruneReminderLog(olderThanDays = 120) {
        return await this.db.pruneReminderLog(olderThanDays);
    }
}

module.exports = new PremiumManager();
