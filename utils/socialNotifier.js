const axios = require("axios");
const { EmbedBuilder } = require("discord.js");
const { getGuildConfig, setGuildConfig } = require("./config");
const { parseBoolean } = require("./valueParsers");

const SCHEDULER_TICK_MS = 60 * 1000;
const MAX_FEEDS_PER_GUILD = 10;
const REQUEST_TIMEOUT = 12000;

function stripCdata(value) {
    return String(value || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function decodeXml(value) {
    return stripCdata(value)
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function tagValue(xml, tag) {
    const match = String(xml || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
    return match ? decodeXml(match[1]) : "";
}

function attrValue(xml, tag, attr) {
    const match = String(xml || "").match(new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["'][^>]*>`, "i"));
    return match ? decodeXml(match[1]) : "";
}

function normalizeUrl(value) {
    const url = String(value || "").trim();
    return /^https?:\/\//i.test(url) ? url : "";
}

async function buildYouTubeFeedUrl(source) {
    const raw = String(source || "").trim();
    const channelMatch = raw.match(/(UC[a-zA-Z0-9_-]{20,})/);
    if (channelMatch) {
        return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelMatch[1])}`;
    }
    if (/^@[\w.-]+$/.test(raw) || /youtube\.com\/@[\w.-]+/i.test(raw)) {
        const handle = raw.match(/@[\w.-]+/)?.[0];
        if (!handle) return "";
        const page = await axios.get(`https://www.youtube.com/${handle}`, { timeout: REQUEST_TIMEOUT, responseType: "text" });
        const pageText = String(page.data || "");
        const resolved = pageText.match(/"channelId":"(UC[a-zA-Z0-9_-]{20,})"/)?.[1]
            || pageText.match(/\/channel\/(UC[a-zA-Z0-9_-]{20,})/)?.[1];
        if (resolved) {
            return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(resolved)}`;
        }
    }
    return "";
}

function applyTemplate(template, data) {
    const source = String(template || "{mention}{source}: {title}\n{url}");
    return source.replace(/\{(\w+)\}/g, (_, key) => {
        const value = data[key];
        return value === undefined || value === null ? "" : String(value);
    }).replace(/[ \t]+\n/g, "\n").trim();
}

function normalizeFeed(feed = {}, index = 0) {
    const type = ["youtube", "twitch", "rss"].includes(feed.type) ? feed.type : "rss";
    return {
        id: String(feed.id || `feed-${index + 1}`).trim().slice(0, 60) || `feed-${index + 1}`,
        enabled: parseBoolean(feed.enabled, true),
        type,
        label: String(feed.label || (type === "twitch" ? "Twitch" : type === "youtube" ? "YouTube" : "RSS Feed")).trim().slice(0, 80),
        source: String(feed.source || "").trim().slice(0, 500),
        messageTemplate: String(feed.messageTemplate || "{mention}{source}: {title}\n{url}").trim().slice(0, 500),
        lastItemId: feed.lastItemId || null,
        lastLiveId: feed.lastLiveId || null,
        lastCheckedAt: feed.lastCheckedAt || null,
        lastPostedAt: feed.lastPostedAt || null,
    };
}

function normalizeSettings(config = {}) {
    const social = config.social && typeof config.social === "object" ? config.social : {};
    const feeds = Array.isArray(social.feeds) ? social.feeds : [];
    return {
        enabled: parseBoolean(social.enabled, parseBoolean(config.modules?.social)),
        announcementChannelId: social.announcementChannelId || null,
        mentionText: String(social.mentionText || "").trim().slice(0, 80),
        pollMinutes: Math.max(2, Math.min(60, Number(social.pollMinutes) || 5)),
        feeds: feeds.map(normalizeFeed).filter(feed => feed.source).slice(0, MAX_FEEDS_PER_GUILD),
    };
}

class SocialNotifier {
    constructor() {
        this.client = null;
        this.timer = null;
        this.running = false;
        this.twitchToken = null;
        this.twitchTokenExpiresAt = 0;
        this.guildLastPoll = new Map();
    }

    start(client) {
        if (this.timer) return;
        this.client = client;
        this.timer = setInterval(() => this.runOnce().catch(error => {
            console.error("[SocialNotifier] Poll failed:", error.message);
        }), SCHEDULER_TICK_MS);
        setTimeout(() => this.runOnce().catch(error => {
            console.error("[SocialNotifier] Initial poll failed:", error.message);
        }), 15000);
        console.log("✅ Social notifier started");
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.client = null;
        this.guildLastPoll.clear();
    }

    async runOnce({ force = false } = {}) {
        if (!this.client || this.running) return;
        this.running = true;
        try {
            for (const guild of this.client.guilds.cache.values()) {
                await this.runGuild(guild, { force }).catch(error => {
                    console.error(`[SocialNotifier] ${guild.id}:`, error.message);
                });
            }
        } finally {
            this.running = false;
        }
    }

    async runGuild(guild, { force = false } = {}) {
        const config = getGuildConfig(guild.id);
        const settings = normalizeSettings(config);
        if (!settings.enabled || !settings.announcementChannelId || !settings.feeds.length) return;

        const intervalMs = Math.max(2, Number(settings.pollMinutes) || 5) * 60 * 1000;
        const lastPoll = this.guildLastPoll.get(guild.id) || 0;
        if (!force && Date.now() - lastPoll < intervalMs) return;
        this.guildLastPoll.set(guild.id, Date.now());

        const channel = guild.channels.cache.get(settings.announcementChannelId)
            || await guild.channels.fetch(settings.announcementChannelId).catch(() => null);
        if (!channel?.isTextBased?.()) return;

        const nextFeeds = [];
        let changed = false;
        for (let i = 0; i < settings.feeds.length; i += 1) {
            const feed = settings.feeds[i];
            if (!feed.enabled) {
                nextFeeds.push(feed);
                continue;
            }

            const before = JSON.stringify(feed);
            let nextFeed = feed;
            try {
                nextFeed = await this.checkFeed(channel, settings, feed);
            } catch (error) {
                console.error(`[SocialNotifier] Feed ${feed.id} failed:`, error.message);
                nextFeed = { ...feed, lastError: error.message.slice(0, 180) };
            }
            nextFeed.lastCheckedAt = Date.now();
            nextFeeds.push(nextFeed);
            if (before !== JSON.stringify(nextFeed)) changed = true;
        }

        if (changed) {
            setGuildConfig(guild.id, {
                social: {
                    ...settings,
                    feeds: nextFeeds,
                },
            });
        }
    }

    async checkFeed(channel, settings, feed) {
        if (feed.type === "twitch") return this.checkTwitch(channel, settings, feed);
        if (feed.type === "youtube") return this.checkXmlFeed(channel, settings, feed, await buildYouTubeFeedUrl(feed.source));
        return this.checkXmlFeed(channel, settings, feed, normalizeUrl(feed.source));
    }

    async checkXmlFeed(channel, settings, feed, url) {
        if (!url) return feed;
        const response = await axios.get(url, { timeout: REQUEST_TIMEOUT, responseType: "text" });
        const xml = String(response.data || "");
        const itemBlock = (xml.match(/<entry[\s\S]*?<\/entry>/i) || xml.match(/<item[\s\S]*?<\/item>/i) || [])[0];
        if (!itemBlock) return feed;

        const id = tagValue(itemBlock, "yt:videoId") || tagValue(itemBlock, "id") || tagValue(itemBlock, "guid") || tagValue(itemBlock, "link");
        const title = tagValue(itemBlock, "title") || feed.label;
        const author = tagValue(itemBlock, "name") || tagValue(itemBlock, "author") || feed.label;
        const link = attrValue(itemBlock, "link", "href") || tagValue(itemBlock, "link");
        const itemId = String(id || link || title).trim();
        if (!itemId) return feed;

        if (!feed.lastItemId) {
            return { ...feed, lastItemId: itemId };
        }
        if (feed.lastItemId === itemId) return feed;

        await this.sendUpdate(channel, settings, feed, {
            title,
            author,
            url: normalizeUrl(link),
            source: feed.label,
            type: feed.type === "youtube" ? "YouTube" : "RSS",
        });

        return { ...feed, lastItemId: itemId, lastPostedAt: Date.now() };
    }

    async getTwitchToken() {
        if (this.twitchToken && Date.now() < this.twitchTokenExpiresAt - 60000) return this.twitchToken;
        const clientId = process.env.TWITCH_CLIENT_ID;
        const clientSecret = process.env.TWITCH_CLIENT_SECRET;
        if (!clientId || !clientSecret) return null;

        const response = await axios.post("https://id.twitch.tv/oauth2/token", null, {
            timeout: REQUEST_TIMEOUT,
            params: {
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: "client_credentials",
            },
        });
        this.twitchToken = response.data?.access_token || null;
        this.twitchTokenExpiresAt = Date.now() + (Number(response.data?.expires_in || 3600) * 1000);
        return this.twitchToken;
    }

    async checkTwitch(channel, settings, feed) {
        const login = String(feed.source || "").replace(/^@/, "").trim().toLowerCase();
        if (!login) return feed;
        const token = await this.getTwitchToken();
        if (!token) return feed;

        const response = await axios.get("https://api.twitch.tv/helix/streams", {
            timeout: REQUEST_TIMEOUT,
            headers: {
                "Client-ID": process.env.TWITCH_CLIENT_ID,
                Authorization: `Bearer ${token}`,
            },
            params: { user_login: login },
        });

        const stream = response.data?.data?.[0];
        if (!stream) return feed;
        if (!feed.lastLiveId) {
            return { ...feed, lastLiveId: stream.id };
        }
        if (feed.lastLiveId === stream.id) return feed;

        await this.sendUpdate(channel, settings, feed, {
            title: stream.title || `${stream.user_name} ist live`,
            url: `https://twitch.tv/${login}`,
            source: feed.label || stream.user_name || login,
            type: "Twitch",
            channel: stream.user_name || login,
            game: stream.game_name || "",
            viewerCount: stream.viewer_count || 0,
        });

        return { ...feed, lastLiveId: stream.id, lastPostedAt: Date.now() };
    }

    async sendUpdate(channel, settings, feed, data) {
        const mention = settings.mentionText ? `${settings.mentionText} ` : "";
        const payload = {
            ...data,
            mention,
            url: data.url || "",
            source: data.source || feed.label,
        };
        const content = applyTemplate(feed.messageTemplate, payload).slice(0, 1900);
        const embed = new EmbedBuilder()
            .setColor(feed.type === "twitch" ? 0x9146ff : feed.type === "youtube" ? 0xff0033 : 0x38bdf8)
            .setTitle(String(payload.title || `${payload.source} Update`).slice(0, 256))
            .setDescription(String(payload.source || "").slice(0, 200))
            .setTimestamp();

        if (payload.url) embed.setURL(payload.url);
        if (payload.game) embed.addFields({ name: "Kategorie", value: String(payload.game).slice(0, 1024), inline: true });
        if (payload.viewerCount) embed.addFields({ name: "Zuschauer", value: String(payload.viewerCount), inline: true });

        // `content` mixes in payload.title/source, which come straight from
        // an external RSS/YouTube/Twitch feed the bot doesn't control -- a
        // feed author could name a video "@everyone free nitro" and trigger
        // a mass ping. Blanket-enabling parse:["everyone","roles","users"]
        // honors any mention pattern anywhere in the final string, feed-sourced
        // or not. Instead, only allow exactly the mention the guild admin
        // configured via settings.mentionText, extracted into an explicit
        // allow-list -- everything else is inert text even if it looks like one.
        const allowedMentions = { parse: [], roles: [], users: [] };
        if (settings.mentionText) {
            if (/@everyone|@here/.test(settings.mentionText)) allowedMentions.parse.push("everyone");
            for (const m of settings.mentionText.matchAll(/<@&(\d+)>/g)) allowedMentions.roles.push(m[1]);
            for (const m of settings.mentionText.matchAll(/<@!?(\d+)>/g)) allowedMentions.users.push(m[1]);
        }

        await channel.send({
            content: content || undefined,
            embeds: [embed],
            allowedMentions,
        });
    }
}

module.exports = new SocialNotifier();
module.exports.normalizeSettings = normalizeSettings;
