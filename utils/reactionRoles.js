// Reaction-Roles: Normalisierung (aus fahrstuhl/services/botAPI.js) + Button/Select-Handling
// (aus fahrstuhl/index.js's InteractionCreate-Block, customId-Praefixe "rr:"/"rrs:").
const { parseBoolean } = require("./valueParsers");

function discordImageUrl(value) {
    const url = String(value || "").trim();
    return /^https?:\/\//i.test(url) ? url.slice(0, 500) : "";
}

function booleanWithDefault(value, fallback = false) {
    return parseBoolean(value, fallback);
}

function normalizeReactionRoleRows(rows = []) {
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    return rows
        .map(row => ({
            roleId: String(row?.roleId || "").trim(),
            label: String(row?.label || "").trim().slice(0, 80),
            emoji: String(row?.emoji || "").trim().slice(0, 32),
        }))
        .filter(row => {
            if (!row.roleId || seen.has(row.roleId)) return false;
            seen.add(row.roleId);
            return true;
        })
        .slice(0, 25);
}

function normalizeReactionRolePanel(panel = {}, fallback = {}) {
    const id = String(panel?.id || fallback.id || `panel-${Date.now().toString(36)}`).trim().slice(0, 40);
    const rawMode = panel?.mode || fallback.mode;
    const mode = rawMode === "select" || rawMode === "menu" ? "select" : "buttons";
    const messageId = panel?.messageId || panel?.lastPanelMessageId || fallback.messageId || fallback.lastPanelMessageId || null;
    const channelId = panel?.channelId || fallback.channelId || null;
    return {
        id,
        panelId: id,
        channelId,
        title: String(panel?.title || fallback.title || "Choose your roles").slice(0, 120),
        description: String(panel?.description || fallback.description || "Use the controls below to add or remove roles.").slice(0, 1000),
        mode,
        exclusive: booleanWithDefault(panel?.exclusive, booleanWithDefault(fallback.exclusive, false)),
        thumbnailUrl: discordImageUrl(panel?.thumbnailUrl || fallback.thumbnailUrl || ""),
        imageUrl: discordImageUrl(panel?.imageUrl || fallback.imageUrl || ""),
        footerText: String(panel?.footerText || fallback.footerText || "").trim().slice(0, 2048),
        authorText: String(panel?.authorText || fallback.authorText || "").trim().slice(0, 256),
        roles: normalizeReactionRoleRows(panel?.roles || fallback.roles || []),
        messageId,
        lastPanelMessageId: messageId,
        lastPanelChannelId: panel?.lastPanelChannelId || fallback.lastPanelChannelId || channelId,
    };
}

function normalizeReactionRolePanels(reactionRoles = {}) {
    const source = reactionRoles && typeof reactionRoles === "object" ? reactionRoles : {};
    const rawPanels = Array.isArray(source.panels) ? source.panels : [];
    const panels = rawPanels
        .map(panel => normalizeReactionRolePanel(panel))
        .filter(panel => panel.id);

    if (!panels.length && (source.roles || source.channelId || source.title || source.description)) {
        panels.push(normalizeReactionRolePanel({
            id: source.panelId || "default",
            channelId: source.channelId || null,
            title: source.title,
            description: source.description,
            mode: source.mode,
            roles: source.roles || [],
            lastPanelMessageId: source.lastPanelMessageId || null,
            lastPanelChannelId: source.lastPanelChannelId || null,
        }));
    }

    if (!panels.length) {
        panels.push(normalizeReactionRolePanel({ id: "default" }));
    }

    const seen = new Set();
    return panels.filter(panel => {
        if (seen.has(panel.id)) return false;
        seen.add(panel.id);
        return true;
    }).slice(0, 25);
}

// 1:1 aus fahrstuhl/index.js's InteractionCreate-Handler ("rr:"-Praefix, Button-Panels).
async function handleReactionRoleButton(interaction, { getGuildConfig, moduleEnabled, safeReply }) {
    const { MessageFlags } = require("discord.js");
    if (!interaction.guild) {
        return safeReply(interaction, { content: "Reaction roles only work inside a server.", flags: [MessageFlags.Ephemeral] });
    }

    const parts = interaction.customId.split(":");
    const panelId = parts.length >= 3 ? parts[1] : "default";
    const roleId = parts.length >= 3 ? parts.slice(2).join(":") : interaction.customId.slice(3);
    const config = getGuildConfig(interaction.guild.id);
    if (!moduleEnabled(config, "reactionRoles", false)) {
        return safeReply(interaction, { content: "Reaction Roles are disabled on this server.", flags: [MessageFlags.Ephemeral] });
    }

    const panels = normalizeReactionRolePanels(config.reactionRoles || {});
    const activePanel = panels.find(panel => String(panel.id) === panelId) || panels[0];
    const configuredRoles = Array.isArray(activePanel?.roles) ? activePanel.roles : [];
    const configured = configuredRoles.find(item => String(item.roleId) === roleId);
    if (!configured) {
        return safeReply(interaction, { content: "This role button is no longer configured.", flags: [MessageFlags.Ephemeral] });
    }

    const role = interaction.guild.roles.cache.get(roleId);
    const botMember = interaction.guild.members.me;
    const canManage = botMember?.permissions?.has(require("discord.js").PermissionsBitField.Flags.ManageRoles) ?? false;
    if (!role || !canManage || role.managed || role.position >= (botMember?.roles?.highest?.position ?? 0)) {
        return safeReply(interaction, { content: "EselModerator cannot assign this role. Check Manage Roles and role order.", flags: [MessageFlags.Ephemeral] });
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const hadRole = member.roles.cache.has(role.id);
    const exclusive = !!activePanel?.exclusive;
    if (hadRole) {
        await member.roles.remove(role, "Reaction role button toggle");
    } else {
        if (exclusive) {
            const otherRoleIds = configuredRoles.map(item => String(item.roleId)).filter(id => id !== String(role.id));
            for (const otherRoleId of otherRoleIds) {
                const otherRole = interaction.guild.roles.cache.get(otherRoleId);
                if (!otherRole || !member.roles.cache.has(otherRoleId)) continue;
                if (otherRole.managed || otherRole.position >= (botMember?.roles?.highest?.position ?? 0)) continue;
                await member.roles.remove(otherRole, "Reaction role exclusive panel switch").catch(() => {});
            }
        }
        await member.roles.add(role, "Reaction role button toggle");
    }

    return safeReply(interaction, {
        content: hadRole ? `Removed ${role}.` : `Added ${role}.`,
        flags: [MessageFlags.Ephemeral],
        allowedMentions: { roles: [] },
    });
}

// 1:1 aus fahrstuhl/index.js's InteractionCreate-Handler ("rrs:"-Praefix, Select-Menu-Panels).
async function handleReactionRoleSelect(interaction, { getGuildConfig, moduleEnabled, safeReply }) {
    const { MessageFlags, PermissionsBitField } = require("discord.js");
    if (!interaction.guild) {
        return safeReply(interaction, { content: "Reaction roles only work inside a server.", flags: [MessageFlags.Ephemeral] });
    }

    const panelId = interaction.customId.slice(4);
    const config = getGuildConfig(interaction.guild.id);
    if (!moduleEnabled(config, "reactionRoles", false)) {
        return safeReply(interaction, { content: "Reaction Roles are disabled on this server.", flags: [MessageFlags.Ephemeral] });
    }

    const panels = normalizeReactionRolePanels(config.reactionRoles || {});
    const panel = panels.find(item => String(item.id) === panelId);
    const configuredRoles = Array.isArray(panel?.roles) ? panel.roles : [];
    if (!configuredRoles.length) {
        return safeReply(interaction, { content: "This role menu is no longer configured.", flags: [MessageFlags.Ephemeral] });
    }

    const allowedRoleIds = new Set(configuredRoles.map(item => String(item.roleId)));
    const exclusive = !!panel?.exclusive;
    const rawSelected = (interaction.values || []).filter(roleId => allowedRoleIds.has(roleId));
    const selectedRoleIds = new Set(exclusive && rawSelected.length > 1 ? [rawSelected[0]] : rawSelected);
    const botMember = interaction.guild.members.me;
    const canManage = botMember?.permissions?.has(PermissionsBitField.Flags.ManageRoles) ?? false;
    if (!canManage) {
        return safeReply(interaction, { content: "EselModerator cannot assign roles. Check Manage Roles permission.", flags: [MessageFlags.Ephemeral] });
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    const added = [];
    const removed = [];
    for (const roleId of allowedRoleIds) {
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role || role.managed || role.position >= (botMember?.roles?.highest?.position ?? 0)) continue;
        const hasRole = member.roles.cache.has(role.id);
        if (selectedRoleIds.has(role.id) && !hasRole) {
            await member.roles.add(role, "Reaction role menu select");
            added.push(role.name);
        } else if (!selectedRoleIds.has(role.id) && hasRole) {
            await member.roles.remove(role, "Reaction role menu select");
            removed.push(role.name);
        }
    }

    const parts = [];
    if (added.length) parts.push(`Added: ${added.join(", ")}`);
    if (removed.length) parts.push(`Removed: ${removed.join(", ")}`);
    return safeReply(interaction, {
        content: parts.length ? parts.join("\n") : "No role changes.",
        flags: [MessageFlags.Ephemeral],
        allowedMentions: { roles: [] },
    });
}

module.exports = {
    discordImageUrl,
    normalizeReactionRoleRows,
    normalizeReactionRolePanels,
    handleReactionRoleButton,
    handleReactionRoleSelect,
};
