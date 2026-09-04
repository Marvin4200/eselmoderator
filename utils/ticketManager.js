const {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    PermissionsBitField,
} = require("discord.js");
const { sendServerLog } = require("./serverLogger");
const ticketStore = require("./ticketStore");
const { buildTicketPanel, normalizeTicketPanels, resolveTicketPanelDesign } = require("./ticketPanel");
const { parseBoolean } = require("./valueParsers");

const PRIORITIES = {
    low: { label: "Low", color: 0x57F287, prefix: "low" },
    normal: { label: "Normal", color: 0xF0B232, prefix: "ticket" },
    high: { label: "High", color: 0xED4245, prefix: "high" },
};

const STATUSES = {
    open: { label: "Open", color: 0x5865F2 },
    waiting_user: { label: "Waiting for User", color: 0xF0B232 },
    waiting_staff: { label: "Waiting for Staff", color: 0xEB459E },
    resolved: { label: "Resolved", color: 0x57F287 },
};

function cleanText(value, fallback = "") {
    const text = String(value || "").trim();
    return text || fallback;
}

function safeChannelName(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 18) || "user";
}

function parseTicketTopic(topic = "") {
    const data = {
        isTicket: false,
        ownerId: null,
        ownerTag: null,
        priority: "normal",
        claimedBy: null,
        type: "Support",
        status: "open",
        reason: "",
    };
    if (!topic.includes("eselmoderator-ticket:")) return data;
    data.isTicket = true;
    const parts = topic.split("|").map(part => part.trim());
    const ownerPart = parts.shift() || "";
    data.ownerId = ownerPart.replace("eselmoderator-ticket:", "").trim() || null;
    for (const part of parts) {
        const idx = part.indexOf(":");
        if (idx === -1) {
            if (!data.ownerTag) data.ownerTag = part;
            continue;
        }
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (key === "owner") data.ownerTag = value;
        if (key === "priority" && PRIORITIES[value]) data.priority = value;
        if (key === "claimed") data.claimedBy = value === "none" ? null : value;
        if (key === "type") data.type = value || "Support";
        if (key === "status" && STATUSES[value]) data.status = value;
        if (key === "reason") data.reason = value;
    }
    return data;
}

// The topic is a "|"-delimited key:value string that parseTicketTopic()
// re-parses later. Free-text fields (reason/type/owner tag) MUST NOT contain
// "|" or ":" — otherwise a user-supplied reason like
// "x | claimed:someone | status:resolved" gets split into extra fields and
// re-parsed as real data, letting any ticket opener forge their own
// claimedBy/priority/status and bypass the isTicketStaff() checks that gate
// claimTicket/setTicketPriority/setTicketStatus.
function stripTopicDelimiters(value) {
    return String(value || "").replace(/[|:]/g, "");
}

function buildTicketTopic({ user, reason, priority = "normal", claimedBy = null, type = "Support", status = "open" }) {
    const safeReason = stripTopicDelimiters(cleanText(reason, "No reason provided").replace(/\s+/g, " ")).slice(0, 220);
    const safeType = stripTopicDelimiters(cleanText(type, "Support").replace(/\s+/g, " ")).slice(0, 40);
    const safeOwnerTag = stripTopicDelimiters(user.tag || user.username);
    return `eselmoderator-ticket:${user.id} | owner:${safeOwnerTag} | priority:${PRIORITIES[priority] ? priority : "normal"} | claimed:${claimedBy || "none"} | type:${safeType} | status:${STATUSES[status] ? status : "open"} | reason:${safeReason}`;
}

function isTicketChannel(channel) {
    return !!channel?.topic && parseTicketTopic(channel.topic).isTicket;
}

function isTicketStaff(interaction, settings = {}) {
    const hasStaffRole = settings.staffRoleId && interaction.member?.roles?.cache?.has(settings.staffRoleId);
    const hasManageChannels = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageChannels);
    return !!hasStaffRole || !!hasManageChannels;
}

function ticketMemberOverwrite(userId) {
    return {
        id: userId,
        allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.EmbedLinks,
        ],
    };
}

function feedbackComponents(channelId) {
    return [
        new ActionRowBuilder().addComponents(
            [1, 2, 3, 4, 5].map(rating =>
                new ButtonBuilder()
                    .setCustomId(`ticket:feedback:${channelId}:${rating}`)
                    .setLabel(String(rating))
                    .setStyle(rating >= 4 ? ButtonStyle.Success : rating === 3 ? ButtonStyle.Primary : ButtonStyle.Secondary)
            )
        ),
    ];
}

async function sendTicketFeedbackRequest(interaction, info, closeReason) {
    if (!info.ownerId || info.ownerId === interaction.user.id) return;
    const user = await interaction.client.users.fetch(info.ownerId).catch(() => null);
    if (!user) return;
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("How was your support experience?")
        .setDescription(`Your ticket **${interaction.channel.name}** was closed. Rate the support from **1** to **5**.`)
        .addFields(
            { name: "Closed By", value: interaction.user.tag, inline: true },
            { name: "Reason", value: cleanText(closeReason, "No close reason provided").slice(0, 300), inline: false }
        )
        .setFooter({ text: "Your feedback helps the team improve." })
        .setTimestamp();
    await user.send({
        embeds: [embed],
        components: feedbackComponents(interaction.channel.id),
    }).catch(() => {});
}

function ticketControls({ claimedBy = null, priority = "normal", status = "open", enableClaiming = true } = {}) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("ticket:claim")
                .setLabel(claimedBy ? "Claimed" : "Claim")
                .setStyle(claimedBy ? ButtonStyle.Secondary : ButtonStyle.Success)
                .setDisabled(!enableClaiming || !!claimedBy),
            new ButtonBuilder()
                .setCustomId("ticket:unclaim")
                .setLabel("Unclaim")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(!enableClaiming || !claimedBy),
            new ButtonBuilder()
                .setCustomId("ticket:priority:high")
                .setLabel("High")
                .setStyle(priority === "high" ? ButtonStyle.Danger : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId("ticket:priority:normal")
                .setLabel("Normal")
                .setStyle(priority === "normal" ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId("ticket:close")
                .setLabel("Close")
                .setStyle(ButtonStyle.Danger)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId("ticket:status:waiting_user")
                .setLabel("Waiting User")
                .setStyle(status === "waiting_user" ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId("ticket:status:waiting_staff")
                .setLabel("Waiting Staff")
                .setStyle(status === "waiting_staff" ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId("ticket:status:resolved")
                .setLabel("Resolved")
                .setStyle(status === "resolved" ? ButtonStyle.Success : ButtonStyle.Secondary)
        ),
    ];
}

async function prepareTicketControlReply(interaction) {
    // Button handlers may run DB + channel updates that exceed Discord's 3s ack window.
    if (typeof interaction?.isButton === "function" && interaction.isButton() && !interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
}

function sendTicketControlReply(interaction, payload) {
    if (interaction?.deferred && !interaction.replied) {
        return interaction.editReply(payload).catch(() => {});
    }
    if (interaction?.replied || interaction?.deferred) {
        return interaction.followUp(payload).catch(() => {});
    }
    return interaction.reply(payload).catch(() => {});
}

async function openTicket(interaction, config, options = {}) {
    const settings = config.tickets || {};
    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
        return interaction.reply({
            content: "Tickets need **Manage Channels** permission.",
            flags: [MessageFlags.Ephemeral],
        }).catch(() => {});
    }

    const existing = interaction.guild.channels.cache.find(channel =>
        channel.topic?.includes(`eselmoderator-ticket:${interaction.user.id}`)
    );
    if (existing) {
        return interaction.reply({
            content: `You already have an open ticket: <#${existing.id}>`,
            flags: [MessageFlags.Ephemeral],
        }).catch(() => {});
    }

    const reason = cleanText(options.reason, "No reason provided").slice(0, 300);
    const priority = PRIORITIES[options.priority || settings.defaultPriority] ? (options.priority || settings.defaultPriority) : "normal";
    const typeLabel = cleanText(options.typeLabel, "Support").slice(0, 40);
    const priorityInfo = PRIORITIES[priority];
    const safeName = safeChannelName(interaction.user.username);

    // A ticket category may route to its own Discord category and notify its own
    // team; both fall back to the guild-wide ticket settings.
    const parentId = options.categoryId && interaction.guild.channels.cache.get(options.categoryId)?.type === 4
        ? options.categoryId
        : settings.categoryId;
    const staffRoleIds = [options.staffRoleId, settings.staffRoleId]
        .filter(roleId => roleId && interaction.guild.roles.cache.has(roleId));
    const uniqueStaffRoleIds = [...new Set(staffRoleIds)];

    const overwrites = [
        { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        ticketMemberOverwrite(interaction.user.id),
        {
            id: me.id,
            allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory,
                PermissionsBitField.Flags.ManageChannels,
                PermissionsBitField.Flags.ManageMessages,
            ],
        },
    ];
    for (const roleId of uniqueStaffRoleIds) {
        overwrites.push(ticketMemberOverwrite(roleId));
    }

    const channel = await interaction.guild.channels.create({
        name: `${priorityInfo.prefix}-${safeName}`,
        type: 0,
        parent: parentId || undefined,
        topic: buildTicketTopic({ user: interaction.user, reason, priority, type: typeLabel }),
        permissionOverwrites: overwrites,
        reason: `EselModerator ticket opened by ${interaction.user.tag}`,
    });

    const staffMention = uniqueStaffRoleIds.map(roleId => `<@&${roleId}>`).join(" ");
    const embed = new EmbedBuilder()
        .setColor(priorityInfo.color)
        .setTitle(`${priorityInfo.label} Priority ${typeLabel} Ticket`)
        .setDescription(`${staffMention ? `${staffMention} ` : ""}<@${interaction.user.id}> opened a private support ticket.`)
        .addFields(
            { name: "Type", value: typeLabel, inline: true },
            { name: "Reason", value: reason, inline: false },
            { name: "Priority", value: priorityInfo.label, inline: true },
            { name: "Claimed By", value: "Unclaimed", inline: true },
            { name: "Controls", value: "Staff can claim or change priority. Anyone with access can close when resolved.", inline: false }
        )
        .setFooter({ text: resolveTicketPanelDesign(settings).footerText })
        .setTimestamp();

    await channel.send({
        content: staffMention || undefined,
        embeds: [embed],
        components: ticketControls({ priority, status: "open", enableClaiming: parseBoolean(settings.enableClaiming, true) }),
    });
    await ticketStore.recordOpen({
        channel,
        user: interaction.user,
        type: typeLabel,
        priority,
        status: "open",
        reason,
    });
    sendServerLog(interaction.guild, config, "tickets", {
        title: "Ticket Opened",
        description: `${interaction.user} opened ${channel}.`,
        color: priorityInfo.color,
        fields: [
            { name: "User", value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
            { name: "Type", value: typeLabel, inline: true },
            { name: "Priority", value: priorityInfo.label, inline: true },
            { name: "Reason", value: reason, inline: false },
        ],
    }).catch(() => {});
    refreshTicketPanel(interaction.guild, config).catch(() => {});

    return interaction.reply({
        content: `Ticket created: <#${channel.id}>`,
        flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
}

async function updateTicketControlsMessage(channel, info, settings = {}) {
    try {
        const messages = await channel.messages.fetch({ limit: 15 }).catch(() => null);
        if (!messages) return;
        const controlsMsg = messages.find(m => m.author.id === channel.guild.members.me?.id && m.components?.length > 0);
        if (!controlsMsg) return;
        await controlsMsg.edit({
            components: ticketControls({
                claimedBy: info.claimedBy || null,
                priority: info.priority || 'normal',
                status: info.status || 'open',
                enableClaiming: parseBoolean(settings.enableClaiming, true),
            }),
        }).catch(() => {});
    } catch {}
}

// Keeps every deployed panel's "Staff online / Queue / Rating" line current. Called after every
// open/close (immediate feedback) and on an interval (utils/ticketPanel.js's staff-online count
// otherwise only reflects reality at the moment the dashboard last redeployed a panel). A guild
// can have several panels (one per channel, up to its plan's limit); all of them share the same
// settings, so one freshly-built embed/components payload is reused for each.
async function refreshTicketPanel(guild, config) {
    const settings = config?.tickets || {};
    const panels = normalizeTicketPanels(settings);
    if (!panels.length || !guild) return;
    try {
        const ticketStats = await ticketStore.getTicketStats(guild.id, { slaMinutes: settings.slaMinutes });
        const panel = buildTicketPanel({ guild, settings, ticketStats });
        for (const { channelId, messageId } of panels) {
            const channel = guild.channels.cache.get(channelId)
                || await guild.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased?.()) continue;
            const message = await channel.messages.fetch(messageId).catch(() => null);
            if (!message) continue;
            await message.edit(panel).catch(() => {});
        }
    } catch {
        // Best-effort — a panel refresh must never break the ticket flow that triggered it.
    }
}

async function claimTicket(interaction, config) {
    const settings = config.tickets || {};
    if (!isTicketChannel(interaction.channel)) {
        return interaction.reply({ content: "This is not a EselModerator ticket channel.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    if (!isTicketStaff(interaction, settings)) {
        return interaction.reply({ content: "Only staff can claim tickets.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }

    const info = parseTicketTopic(interaction.channel.topic);
    if (info.claimedBy) {
        return interaction.reply({ content: `This ticket is already claimed by <@${info.claimedBy}>.`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }

    await interaction.channel.setTopic(buildTicketTopic({
        user: { id: info.ownerId || interaction.user.id, tag: info.ownerTag || "unknown" },
        reason: info.reason,
        priority: info.priority,
        claimedBy: interaction.user.id,
        type: info.type,
        status: info.status,
    })).catch(() => {});
    await ticketStore.updateState(interaction.channel, { claimedBy: interaction.user.id });

    const updatedInfo = { ...info, claimedBy: interaction.user.id };
    await updateTicketControlsMessage(interaction.channel, updatedInfo, settings);

    const embed = new EmbedBuilder()
        .setDescription(`${interaction.user} is now handling this ticket.`)
        .setTimestamp();
    return interaction.reply({ embeds: [embed] }).catch(() => {});
}

async function unclaimTicket(interaction, config) {
    const settings = config.tickets || {};
    if (!isTicketChannel(interaction.channel)) {
        return interaction.reply({ content: "This is not a EselModerator ticket channel.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    if (!isTicketStaff(interaction, settings)) {
        return interaction.reply({ content: "Only staff can unclaim tickets.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    const info = parseTicketTopic(interaction.channel.topic);
    await interaction.channel.setTopic(buildTicketTopic({
        user: { id: info.ownerId || interaction.user.id, tag: info.ownerTag || "unknown" },
        reason: info.reason,
        priority: info.priority,
        claimedBy: null,
        type: info.type,
        status: info.status,
    })).catch(() => {});
    await ticketStore.updateState(interaction.channel, { claimedBy: null });
    const updatedInfoUnclaim = { ...info, claimedBy: null };
    await updateTicketControlsMessage(interaction.channel, updatedInfoUnclaim, settings);
    const embed = new EmbedBuilder()
        .setColor(0xF0B232)
        .setTitle("Ticket Unclaimed")
        .setDescription(`${interaction.user} released this ticket back to the team.`)
        .setTimestamp();
    return interaction.reply({ embeds: [embed] }).catch(() => {});
}

async function setTicketPriority(interaction, config, priority) {
    await prepareTicketControlReply(interaction);
    const settings = config.tickets || {};
    if (!isTicketChannel(interaction.channel)) {
        return sendTicketControlReply(interaction, { content: "This is not a EselModerator ticket channel.", flags: [MessageFlags.Ephemeral] });
    }
    if (!isTicketStaff(interaction, settings)) {
        return sendTicketControlReply(interaction, { content: "Only staff can change ticket priority.", flags: [MessageFlags.Ephemeral] });
    }
    if (!PRIORITIES[priority]) priority = "normal";

    const info = parseTicketTopic(interaction.channel.topic);
    await interaction.channel.setTopic(buildTicketTopic({
        user: { id: info.ownerId || interaction.user.id, tag: info.ownerTag || "unknown" },
        reason: info.reason,
        priority,
        claimedBy: info.claimedBy,
        type: info.type,
        status: info.status,
    })).catch(() => {});
    const baseName = interaction.channel.name.replace(/^(low|high|ticket)-/, "");
    await interaction.channel.setName(`${PRIORITIES[priority].prefix}-${baseName}`).catch(() => {});
    await ticketStore.updateState(interaction.channel, { priority });

    const updatedInfoPrio = { ...info, priority };
    await updateTicketControlsMessage(interaction.channel, updatedInfoPrio, settings);

    const embed = new EmbedBuilder()
        .setDescription(`${interaction.user} set this ticket to **${PRIORITIES[priority].label}** priority.`)
        .setTimestamp();
    return sendTicketControlReply(interaction, { embeds: [embed] });
}

async function setTicketStatus(interaction, config, status) {
    await prepareTicketControlReply(interaction);
    const settings = config.tickets || {};
    if (!isTicketChannel(interaction.channel)) {
        return sendTicketControlReply(interaction, { content: "This is not a EselModerator ticket channel.", flags: [MessageFlags.Ephemeral] });
    }
    if (!isTicketStaff(interaction, settings)) {
        return sendTicketControlReply(interaction, { content: "Only staff can change ticket status.", flags: [MessageFlags.Ephemeral] });
    }
    if (!STATUSES[status]) status = "open";
    const info = parseTicketTopic(interaction.channel.topic);
    await interaction.channel.setTopic(buildTicketTopic({
        user: { id: info.ownerId || interaction.user.id, tag: info.ownerTag || "unknown" },
        reason: info.reason,
        priority: info.priority,
        claimedBy: info.claimedBy,
        type: info.type,
        status,
    })).catch(() => {});
    await ticketStore.updateState(interaction.channel, { status });
    const updatedInfoStatus = { ...info, status };
    await updateTicketControlsMessage(interaction.channel, updatedInfoStatus, settings);
    const embed = new EmbedBuilder()
        .setColor(STATUSES[status].color)
        .setTitle("Ticket Status Updated")
        .setDescription(`${interaction.user} set this ticket to **${STATUSES[status].label}**.`)
        .setTimestamp();
    return sendTicketControlReply(interaction, { embeds: [embed] });
}

async function addTicketNote(interaction, config, note) {
    const settings = config.tickets || {};
    if (!isTicketChannel(interaction.channel)) {
        return interaction.reply({ content: "This is not a EselModerator ticket channel.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    if (!isTicketStaff(interaction, settings)) {
        return interaction.reply({ content: "Only staff can add internal ticket notes.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    const text = cleanText(note).slice(0, 1200);
    if (!text) {
        return interaction.reply({ content: "Add a note text first.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    await ticketStore.appendNote({ channel: interaction.channel, actor: interaction.user, note: text });
    sendServerLog(interaction.guild, config, "tickets", {
        title: "Ticket Note Added",
        description: `${interaction.user} added an internal note to ${interaction.channel}.`,
        color: 0x5865F2,
        fields: [
            { name: "Staff", value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
            { name: "Note", value: text.slice(0, 900), inline: false },
        ],
    }).catch(() => {});
    return interaction.reply({
        content: "Internal staff note saved to the ticket archive.",
        flags: [MessageFlags.Ephemeral],
    }).catch(() => {});
}

async function addTicketUser(interaction, config, user) {
    const settings = config.tickets || {};
    if (!isTicketChannel(interaction.channel)) {
        return interaction.reply({ content: "This is not a EselModerator ticket channel.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    if (!isTicketStaff(interaction, settings)) {
        return interaction.reply({ content: "Only staff can add users to tickets.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    if (!user || user.bot) {
        return interaction.reply({ content: "Pick a real server member.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) {
        return interaction.reply({ content: "That user is not in this server.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    await interaction.channel.permissionOverwrites.edit(user.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        AttachFiles: true,
        EmbedLinks: true,
    }, { reason: `Ticket access granted by ${interaction.user.tag}` }).catch(error => {
        throw new Error(`Could not add user to ticket: ${error.message}`);
    });
    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle("User Added")
        .setDescription(`${user} can now view and reply in this ticket.`)
        .setTimestamp();
    return interaction.reply({ embeds: [embed] }).catch(() => {});
}

async function removeTicketUser(interaction, config, user) {
    const settings = config.tickets || {};
    if (!isTicketChannel(interaction.channel)) {
        return interaction.reply({ content: "This is not a EselModerator ticket channel.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    if (!isTicketStaff(interaction, settings)) {
        return interaction.reply({ content: "Only staff can remove users from tickets.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    const info = parseTicketTopic(interaction.channel.topic);
    if (!user || user.id === info.ownerId) {
        return interaction.reply({ content: "The ticket owner cannot be removed from their own ticket.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (settings.staffRoleId && member?.roles?.cache?.has(settings.staffRoleId)) {
        return interaction.reply({ content: "That member has the staff role, so role access still applies.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    await interaction.channel.permissionOverwrites.delete(user.id, `Ticket access removed by ${interaction.user.tag}`).catch(error => {
        throw new Error(`Could not remove user from ticket: ${error.message}`);
    });
    const embed = new EmbedBuilder()
        .setColor(0xF0B232)
        .setTitle("User Removed")
        .setDescription(`${user} no longer has a direct ticket permission overwrite.`)
        .setTimestamp();
    return interaction.reply({ embeds: [embed] }).catch(() => {});
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function buildTranscript(channel, closedBy) {
    const info = parseTicketTopic(channel.topic);
    let transcriptText = `Ticket Transcript - ${channel.name}\n`;
    let transcriptHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(channel.name)} Transcript</title><style>body{font-family:Inter,Arial,sans-serif;background:#111827;color:#e5e7eb;padding:24px}.meta{background:#1f2937;border:1px solid #374151;border-radius:8px;padding:16px;margin-bottom:16px}.msg{padding:10px 0;border-bottom:1px solid #253044}.author{font-weight:700;color:#93c5fd}.time{color:#9ca3af;font-size:12px}.content{white-space:pre-wrap;margin-top:4px}.att{color:#fbbf24}</style></head><body><h1>${escapeHtml(channel.name)} Transcript</h1><div class="meta">`;
    transcriptText += `Ticket Owner: ${info.ownerTag || "Unknown"} (${info.ownerId || "unknown"})\n`;
    transcriptText += `Priority: ${PRIORITIES[info.priority]?.label || "Normal"}\n`;
    transcriptText += `Type: ${info.type || "Support"}\n`;
    transcriptText += `Status: ${STATUSES[info.status]?.label || "Open"}\n`;
    transcriptText += `Claimed By: ${info.claimedBy || "Unclaimed"}\n`;
    transcriptText += `Reason: ${info.reason || "No reason provided"}\n`;
    transcriptText += `Closed by: ${closedBy.tag} (${closedBy.id})\n`;
    transcriptText += `Closed at: ${new Date().toISOString()}\n`;
    transcriptText += `--------------------------------------------------\n\n`;
    transcriptHtml += `<strong>Owner:</strong> ${escapeHtml(info.ownerTag || info.ownerId || "Unknown")}<br><strong>Type:</strong> ${escapeHtml(info.type || "Support")}<br><strong>Priority:</strong> ${escapeHtml(PRIORITIES[info.priority]?.label || "Normal")}<br><strong>Status:</strong> ${escapeHtml(STATUSES[info.status]?.label || "Open")}<br><strong>Claimed:</strong> ${escapeHtml(info.claimedBy || "Unclaimed")}<br><strong>Reason:</strong> ${escapeHtml(info.reason || "No reason provided")}<br><strong>Closed by:</strong> ${escapeHtml(closedBy.tag)}<br><strong>Closed at:</strong> ${escapeHtml(new Date().toISOString())}</div>`;

    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const sortedMessages = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const msg of sortedMessages) {
            const time = msg.createdAt.toISOString();
            const content = msg.content || "[no text content]";
            transcriptText += `[${time}] ${msg.author.tag}: ${content}\n`;
            transcriptHtml += `<div class="msg"><div><span class="author">${escapeHtml(msg.author.tag)}</span> <span class="time">${escapeHtml(time)}</span></div><div class="content">${escapeHtml(content)}</div>`;
            for (const att of msg.attachments.values()) {
                transcriptText += ` > Attachment: ${att.url}\n`;
                transcriptHtml += `<div class="att">Attachment: <a href="${escapeHtml(att.url)}">${escapeHtml(att.url)}</a></div>`;
            }
            for (const embed of msg.embeds) {
                if (embed.title) transcriptText += ` > Embed: ${embed.title}\n`;
                if (embed.title) transcriptHtml += `<div class="att">Embed: ${escapeHtml(embed.title)}</div>`;
            }
            transcriptHtml += `</div>`;
        }
    } catch (error) {
        transcriptText += `\n[Error fetching messages: ${error.message}]\n`;
        transcriptHtml += `<div class="msg">Error fetching messages: ${escapeHtml(error.message)}</div>`;
    }
    transcriptHtml += `</body></html>`;
    return { text: transcriptText, html: transcriptHtml };
}

async function closeTicket(interaction, config, options = {}) {
    const settings = config.tickets || {};
    if (!isTicketChannel(interaction.channel)) {
        return interaction.reply({ content: "This only works inside a EselModerator ticket channel.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }

    const info = parseTicketTopic(interaction.channel.topic);
    const isOwner = info.ownerId === interaction.user.id;
    if (!isOwner && !isTicketStaff(interaction, settings)) {
        return interaction.reply({ content: "Only the ticket owner or staff can close this ticket.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    const closeReason = cleanText(options.reason, "");
    if (settings.requireCloseReason && !closeReason) {
        return interaction.reply({ content: "A close reason is required for this server.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    const finalCloseReason = cleanText(closeReason, "No close reason provided").slice(0, 500);

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply().catch(() => {});
    }

    const transcript = await buildTranscript(interaction.channel, interaction.user);
    const textAttachment = new AttachmentBuilder(Buffer.from(transcript.text, "utf-8"), { name: `transcript-${interaction.channel.name}.txt` });
    const htmlAttachment = new AttachmentBuilder(Buffer.from(transcript.html, "utf-8"), { name: `transcript-${interaction.channel.name}.html` });

    if (settings.transcriptChannelId) {
        const transcriptChannel = interaction.guild.channels.cache.get(settings.transcriptChannelId)
            || await interaction.guild.channels.fetch(settings.transcriptChannelId).catch(() => null);
        if (transcriptChannel?.isTextBased?.()) {
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle("Ticket Transcript")
                .setDescription(`Ticket **${interaction.channel.name}** was closed by ${interaction.user}.`)
                .addFields(
                    { name: "Owner", value: info.ownerId ? `<@${info.ownerId}>` : "Unknown", inline: true },
                    { name: "Priority", value: PRIORITIES[info.priority]?.label || "Normal", inline: true },
                    { name: "Claimed By", value: info.claimedBy ? `<@${info.claimedBy}>` : "Unclaimed", inline: true },
                    { name: "Type", value: info.type || "Support", inline: true }
                )
                .setTimestamp();
            const sent = await transcriptChannel.send({ embeds: [embed], files: [textAttachment, htmlAttachment] }).catch(() => null);
            await ticketStore.recordClose({
                channel: interaction.channel,
                closedBy: interaction.user,
                closeReason: finalCloseReason,
                transcriptChannelId: transcriptChannel.id,
                transcriptMessageId: sent?.id || null,
            });
        } else {
            await ticketStore.recordClose({
                channel: interaction.channel,
                closedBy: interaction.user,
                closeReason: finalCloseReason,
            });
        }
    } else {
        await ticketStore.recordClose({
            channel: interaction.channel,
            closedBy: interaction.user,
            closeReason: finalCloseReason,
        });
    }

    refreshTicketPanel(interaction.guild, config).catch(() => {});
    await sendTicketFeedbackRequest(interaction, info, finalCloseReason);

    sendServerLog(interaction.guild, config, "tickets", {
        title: "Ticket Closed",
        description: `${interaction.user} closed ${interaction.channel}.`,
        color: 0xff6b6b,
        fields: [
            { name: "Owner", value: info.ownerId ? `<@${info.ownerId}>\n\`${info.ownerId}\`` : "Unknown", inline: true },
            { name: "Closed By", value: `${interaction.user.tag}\n\`${interaction.user.id}\``, inline: true },
            { name: "Reason", value: finalCloseReason, inline: false },
        ],
    }).catch(() => {});

    const closeMessage = { content: `Closing ticket in ${settings.closeDelaySeconds || 5} seconds. Transcript has been saved when configured.` };
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(closeMessage).catch(() => {});
    } else {
        await interaction.reply(closeMessage).catch(() => {});
    }
    setTimeout(() => {
        interaction.channel?.delete(`EselModerator ticket closed by ${interaction.user.tag}`).catch(error => {
            console.warn(`Ticket delete failed in ${interaction.guild.name}: ${error.message}`);
        });
    }, Math.max(1, Math.min(30, Number(settings.closeDelaySeconds) || 5)) * 1000);
}

async function recordTicketFeedback(interaction, channelId, rating) {
    const safeRating = Math.max(1, Math.min(5, Number(rating) || 0));
    if (!channelId || !safeRating) {
        return interaction.reply({ content: "Invalid feedback button.", flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
    await ticketStore.recordFeedback({
        channelId,
        rating: safeRating,
        user: interaction.user,
    });
    const content = `Thanks for rating this ticket ${safeRating}/5.`;
    if (interaction.isButton?.()) {
        return interaction.update({ content, embeds: [], components: [] }).catch(() =>
            interaction.reply({ content, flags: [MessageFlags.Ephemeral] }).catch(() => {})
        );
    }
    return interaction.reply({ content, flags: [MessageFlags.Ephemeral] }).catch(() => {});
}

module.exports = {
    PRIORITIES,
    STATUSES,
    addTicketNote,
    addTicketUser,
    buildTranscript,
    claimTicket,
    closeTicket,
    isTicketChannel,
    openTicket,
    parseTicketTopic,
    recordTicketFeedback,
    refreshTicketPanel,
    removeTicketUser,
    setTicketPriority,
    setTicketStatus,
    ticketControls,
    unclaimTicket,
    updateTicketControlsMessage,
};
