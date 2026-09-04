const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
} = require("discord.js");
const { parseBoolean } = require("./valueParsers");

// Eselbande brand tokens, mirroring the CSS variables used on eselbande.com
// (--accent2 #667eea) and the reaction-role panels.
const BRAND = {
    name: "Eselbande",
    domain: "eselbande.com",
    color: 0x667EEA,
};

const PRIORITY_KEYS = ["low", "normal", "high"];
const CATEGORY_LIMIT = 25;
const DIVIDER = "────────────────────────────";

const PANEL_DEFAULTS = {
    title: "Discord Ticket System",
    description: "Du brauchst Hilfe? Wähle unten eine Kategorie aus und unser Team kümmert sich um dein Anliegen.",
    buttonLabel: "Ticket öffnen",
    placeholder: "Choose a category ...",
    footerText: BRAND.domain,
    brandName: BRAND.name,
    bannerUrl: "",
};

const DEFAULT_CATEGORIES = [
    { key: "support", label: "Support", emoji: "🎫", description: "Allgemeine Hilfe vom Team.", priority: "normal" },
    { key: "kauf", label: "Kauf & Zahlung", emoji: "💳", description: "Fragen zu Käufen, Zahlungen oder Rechnungen.", priority: "normal" },
    { key: "bug", label: "Fehler melden", emoji: "🐛", description: "Melde einen Bug oder ein technisches Problem.", priority: "high" },
    { key: "partner", label: "Partnerschaft", emoji: "🤝", description: "Kooperationen und Partneranfragen.", priority: "low" },
    { key: "sonstiges", label: "Sonstiges", emoji: "📋", description: "Alles, was in keine andere Kategorie passt.", priority: "normal" },
];

function parsePanelColor(value, fallback = BRAND.color) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xFFFFFF) return value;
    const raw = String(value || "").trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(raw)) return fallback;
    return parseInt(raw, 16);
}

function colorToHex(value) {
    return `#${parsePanelColor(value).toString(16).padStart(6, "0")}`;
}

// Accepts unicode emoji, a raw custom emoji id, or the <:name:id> / <a:name:id> form.
function parsePanelEmoji(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const custom = raw.match(/^<(a)?:([a-zA-Z0-9_]{2,32}):(\d{15,25})>$/);
    if (custom) return { id: custom[3], name: custom[2], animated: Boolean(custom[1]) };
    if (/^\d{15,25}$/.test(raw)) return { id: raw };
    return { name: raw.slice(0, 32) };
}

function normalizeTicketTypes(rawTypes = []) {
    const source = Array.isArray(rawTypes) ? rawTypes : [];
    const rows = (source.length ? source : DEFAULT_CATEGORIES)
        .map((type, index) => {
            const label = String(type?.label || "").trim().slice(0, 80);
            const key = String(type?.key || label || `type-${index + 1}`)
                .toLowerCase()
                .replace(/[^a-z0-9_-]/g, "")
                .slice(0, 40);
            return {
                key: key || `type-${index + 1}`,
                // Kein Platzhalter-Label: leere Eintraege werden unten verworfen,
                // so wie es das Dashboard zusagt ("Leere Bezeichnungen werden ignoriert").
                label,
                emoji: String(type?.emoji || "").trim().slice(0, 40),
                description: String(type?.description || "").trim().slice(0, 100),
                priority: PRIORITY_KEYS.includes(type?.priority) ? type.priority : "normal",
                categoryId: String(type?.categoryId || "").trim() || null,
                staffRoleId: String(type?.staffRoleId || "").trim() || null,
            };
        })
        .filter(type => type.label)
        .slice(0, CATEGORY_LIMIT);

    // Duplicate keys would make two options unaddressable in the select menu.
    const seen = new Set();
    const unique = rows.map((type, index) => {
        if (!seen.has(type.key)) {
            seen.add(type.key);
            return type;
        }
        const key = `${type.key}-${index + 1}`.slice(0, 40);
        seen.add(key);
        return { ...type, key };
    });

    return unique.length ? unique : normalizeTicketTypes(DEFAULT_CATEGORIES);
}

function findTicketCategory(settings = {}, key) {
    const categories = normalizeTicketTypes(settings.ticketTypes);
    return categories.find(category => category.key === key) || null;
}

function normalizeTicketSlaMinutes(value, fallback = 240) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return fallback;
    return Math.max(0, Math.min(10080, Math.round(minutes)));
}

function normalizeTicketPanelInfo(raw = {}) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
        enabled: parseBoolean(source.enabled, false),
        showOpenTickets: parseBoolean(source.showOpenTickets, false),
        showAverageResolution: parseBoolean(source.showAverageResolution, false),
        showOverdueTickets: parseBoolean(source.showOverdueTickets, false),
        showLastUpdated: parseBoolean(source.showLastUpdated, false),
    };
}

function resolveTicketPanelDesign(settings = {}) {
    const source = settings && typeof settings === "object" ? settings : {};
    return {
        title: String(source.panelTitle || PANEL_DEFAULTS.title).slice(0, 120),
        description: String(source.panelDescription || PANEL_DEFAULTS.description).slice(0, 1200),
        buttonLabel: String(source.panelButtonLabel || PANEL_DEFAULTS.buttonLabel).slice(0, 80),
        placeholder: String(source.panelPlaceholder || PANEL_DEFAULTS.placeholder).slice(0, 150),
        footerText: String(source.panelFooterText || PANEL_DEFAULTS.footerText).slice(0, 2048),
        brandName: String(source.panelBrandName || PANEL_DEFAULTS.brandName).slice(0, 100),
        bannerUrl: /^https?:\/\//i.test(String(source.panelBannerUrl || "").trim())
            ? String(source.panelBannerUrl).trim().slice(0, 500)
            : "",
        color: parsePanelColor(source.panelColor),
        showLiveStatus: parseBoolean(source.panelShowLiveStatus, true),
        showStaffOnline: parseBoolean(source.panelShowStaffOnline, true),
        showQueue: parseBoolean(source.panelShowQueue, true),
        showRating: parseBoolean(source.panelShowRating, true),
    };
}

// A guild can have several deployed panel messages (one per channel, up to its plan's
// ticketPanels limit). `settings.panels` is the current shape; a guild whose panel predates
// this array still has the old singular panelChannelId/panelMessageId fields, so those are
// read as a one-item array here rather than requiring every caller to migrate the stored config.
function normalizeTicketPanels(settings = {}) {
    if (Array.isArray(settings.panels)) {
        return settings.panels
            .filter(panel => panel && panel.channelId && panel.messageId)
            .map(panel => ({ channelId: String(panel.channelId), messageId: String(panel.messageId) }));
    }
    if (settings.panelChannelId && settings.panelMessageId) {
        return [{ channelId: String(settings.panelChannelId), messageId: String(settings.panelMessageId) }];
    }
    return [];
}

function collectStaffRoleIds(settings = {}) {
    const roleIds = new Set();
    if (settings.staffRoleId) roleIds.add(String(settings.staffRoleId));
    for (const category of normalizeTicketTypes(settings.ticketTypes)) {
        if (category.staffRoleId) roleIds.add(String(category.staffRoleId));
    }
    return [...roleIds];
}

// Presence is only cached for members who are actually online, so an offline
// team simply yields 0 rather than an inaccurate count.
function countStaffOnline(guild, settings = {}) {
    const roleIds = collectStaffRoleIds(settings);
    if (!guild || !roleIds.length) return { online: 0, total: 0, tracked: false };

    const counted = new Set();
    let online = 0;
    for (const roleId of roleIds) {
        const role = guild.roles.cache.get(roleId);
        if (!role) continue;
        for (const member of role.members.values()) {
            if (member.user?.bot || counted.has(member.id)) continue;
            counted.add(member.id);
            const status = member.presence?.status;
            if (status && status !== "offline") online += 1;
        }
    }
    return { online, total: counted.size, tracked: counted.size > 0 };
}

function buildQueueLabel(ticketStats) {
    const open = Number(ticketStats?.open || 0);
    const overdue = Number(ticketStats?.overdueOpen || 0);
    if (overdue > 0) return `${overdue} überfällig`;
    if (open === 0) return "Queue frei";
    return open === 1 ? "1 offenes Ticket" : `${open} offene Tickets`;
}

function buildRatingLabel(ticketStats) {
    const count = Number(ticketStats?.feedback?.count || 0);
    if (!count) return null;
    const average = Number(ticketStats?.feedback?.average || 0);
    if (!Number.isFinite(average) || average <= 0) return null;
    return `${average.toFixed(1)}★ (${count})`;
}

function buildLiveStatusLine({ guild, settings, ticketStats, design }) {
    if (!design.showLiveStatus) return null;

    const parts = [];
    const staff = design.showStaffOnline ? countStaffOnline(guild, settings) : null;
    if (staff?.tracked) parts.push(`${staff.online} Staff online`);
    if (design.showQueue) parts.push(buildQueueLabel(ticketStats));
    if (design.showRating) {
        const rating = buildRatingLabel(ticketStats);
        if (rating) parts.push(rating);
    }
    if (!parts.length) return null;

    const indicator = staff?.tracked && staff.online === 0 ? "🟠" : "🟢";
    return `${indicator} ${parts.join(" • ")}`;
}

function appendTicketPanelInfoField(embed, ticketStats, ticketPanelInfo) {
    const info = normalizeTicketPanelInfo(ticketPanelInfo);
    if (!info.enabled) return;

    const lines = [];
    if (info.showOpenTickets) {
        lines.push(`Offene Tickets: ${Number(ticketStats?.open || 0)}`);
    }
    if (info.showAverageResolution) {
        const avgMinutes = ticketStats?.avgResolutionMinutes;
        const avgLabel = avgMinutes === null || avgMinutes === undefined
            ? "Keine Daten"
            : `${Math.max(0, Math.round(Number(avgMinutes) || 0))} Min`;
        lines.push(`Ø Lösungszeit: ${avgLabel}`);
    }
    if (info.showOverdueTickets) {
        lines.push(`Überfällig: ${Number(ticketStats?.overdueOpen || 0)}`);
    }
    if (info.showLastUpdated) {
        lines.push(`Aktualisiert: <t:${Math.floor(Date.now() / 1000)}:R>`);
    }

    if (lines.length > 0) {
        embed.addFields({
            name: "📊 Ticket-Status",
            value: lines.join("\n"),
            inline: false,
        });
    }
}

function buildTicketPanel({ guild = null, settings = {}, ticketStats = null } = {}) {
    const design = resolveTicketPanelDesign(settings);
    const iconURL = guild?.iconURL?.({ size: 128 }) || undefined;

    const statusLine = buildLiveStatusLine({ guild, settings, ticketStats, design });
    const description = [design.description, DIVIDER, statusLine]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 4000);

    const embed = new EmbedBuilder()
        .setColor(design.color)
        .setAuthor({ name: `${design.brandName} • online`, iconURL })
        .setTitle(design.title)
        .setDescription(description)
        .setFooter({ text: design.footerText, iconURL })
        .setTimestamp();

    if (design.bannerUrl) embed.setImage(design.bannerUrl);
    appendTicketPanelInfoField(embed, ticketStats, settings.ticketPanelInfo);

    const components = [];
    // Ein Select-Menue ohne Optionen weist Discord zurueck, deshalb faellt ein
    // Panel ohne gueltige Kategorie auf den Button zurueck.
    const menuCategories = normalizeTicketTypes(settings.ticketTypes);
    if (parseBoolean(settings.enableTicketTypes, false) && menuCategories.length) {
        const menu = new StringSelectMenuBuilder()
            .setCustomId("ticket:type")
            .setPlaceholder(design.placeholder)
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(menuCategories.map(category => {
                const option = {
                    label: category.label,
                    value: category.key,
                    description: category.description || `${category.priority} priority`,
                };
                const emoji = parsePanelEmoji(category.emoji);
                if (emoji) option.emoji = emoji;
                return option;
            }));
        components.push(new ActionRowBuilder().addComponents(menu));
    } else {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("ticket:open")
                .setLabel(design.buttonLabel)
                .setStyle(ButtonStyle.Primary)
                .setEmoji("🎫")
        ));
    }

    return { embeds: [embed], components };
}

module.exports = {
    BRAND,
    DEFAULT_CATEGORIES,
    PANEL_DEFAULTS,
    appendTicketPanelInfoField,
    buildTicketPanel,
    colorToHex,
    countStaffOnline,
    findTicketCategory,
    normalizeTicketPanelInfo,
    normalizeTicketPanels,
    normalizeTicketSlaMinutes,
    normalizeTicketTypes,
    parsePanelColor,
    resolveTicketPanelDesign,
};
