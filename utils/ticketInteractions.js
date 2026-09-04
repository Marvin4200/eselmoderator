// Ticket-Panel-Interaktionen (Select-Menu -> Modal -> Ticket erstellen, Claim/Unclaim/Close/
// Priority/Status-Buttons, Feedback-Sterne) -- 1:1 aus fahrstuhl/index.js extrahiert. Die
// Live-Dashboard-Events (emitActivityEvent) wurden bewusst weggelassen, siehe AutoMod-Modul
// fuer dieselbe Begruendung.
const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
} = require("discord.js");
const ticketManager = require("./ticketManager");
const { findTicketCategory } = require("./ticketPanel");

function findTicketChannelsByOwner(guild, ownerId) {
    if (!guild || !ownerId) return [];
    return guild.channels.cache
        .filter((channel) => {
            if (!channel?.topic || !channel.isTextBased?.()) return false;
            const ticketInfo = ticketManager.parseTicketTopic(channel.topic);
            return ticketInfo.isTicket && ticketInfo.ownerId === ownerId;
        })
        .sort((left, right) => Number(right.createdTimestamp || 0) - Number(left.createdTimestamp || 0))
        .map((channel) => channel);
}

async function openTicketForInteraction(interaction, config, reason = "Opened from ticket panel") {
    const options = typeof reason === "object" && reason !== null ? reason : { reason };
    return ticketManager.openTicket(interaction, config, {
        reason: options.reason,
        priority: options.priority || config.tickets?.defaultPriority || "normal",
        typeLabel: options.typeLabel || "Support",
        categoryId: options.categoryId || null,
        staffRoleId: options.staffRoleId || null,
    });
}

// Dispatcher fuer alle "ticket:"-customIds (Buttons, Select-Menu, Modal-Submits).
// Rueckgabe true = wurde behandelt, false = kein Ticket-Interaction (Aufrufer macht weiter).
async function handleTicketInteraction(interaction, { getGuildConfig, moduleEnabled, safeReply }) {
    const { MessageFlags } = require("discord.js");

    if (interaction.isModalSubmit?.() && interaction.customId === "ticket:close_reason") {
        if (!interaction.guild) return true;
        const config = getGuildConfig(interaction.guild.id);
        if (!moduleEnabled(config, "tickets", false)) {
            await safeReply(interaction, { content: "Tickets are disabled on this server.", flags: [MessageFlags.Ephemeral] });
            return true;
        }
        const reason = interaction.fields.getTextInputValue("reason");
        await ticketManager.closeTicket(interaction, config, { reason });
        return true;
    }

    if (interaction.isModalSubmit?.() && interaction.customId.startsWith("ticket:intake:")) {
        if (!interaction.guild) return true;
        const config = getGuildConfig(interaction.guild.id);
        if (!moduleEnabled(config, "tickets", false)) {
            await safeReply(interaction, { content: "Tickets are disabled on this server.", flags: [MessageFlags.Ephemeral] });
            return true;
        }
        const typeKey = interaction.customId.split(":")[2] || "support";
        const selectedType = findTicketCategory(config.tickets || {}, typeKey) || {
            label: "Support",
            priority: config.tickets?.defaultPriority || "normal",
            categoryId: null,
            staffRoleId: null,
        };
        const reason = interaction.fields.getTextInputValue("reason");
        const extra = interaction.fields.getTextInputValue("extra") || "";
        await openTicketForInteraction(interaction, config, {
            reason: extra ? `${reason}\n\nExtra: ${extra}` : reason,
            priority: selectedType.priority || config.tickets?.defaultPriority || "normal",
            typeLabel: selectedType.label || "Support",
            categoryId: selectedType.categoryId || null,
            staffRoleId: selectedType.staffRoleId || null,
        });
        return true;
    }

    if (interaction.isButton?.() && interaction.customId.startsWith("ticket:feedback:")) {
        const parts = interaction.customId.split(":");
        await ticketManager.recordTicketFeedback(interaction, parts[2], parts[3]);
        return true;
    }

    const isTicketButton = interaction.isButton?.() && interaction.customId.startsWith("ticket:") && interaction.customId !== "ticket:type";
    if (isTicketButton) {
        if (!interaction.guild) {
            await safeReply(interaction, { content: "Tickets only work inside a server.", flags: [MessageFlags.Ephemeral] });
            return true;
        }
        const config = getGuildConfig(interaction.guild.id);
        if (!moduleEnabled(config, "tickets", false)) {
            await safeReply(interaction, { content: "Tickets are disabled on this server.", flags: [MessageFlags.Ephemeral] });
            return true;
        }

        if (interaction.customId === "ticket:open") {
            await openTicketForInteraction(interaction, config);
            return true;
        }
        if (interaction.customId === "ticket:claim") {
            await ticketManager.claimTicket(interaction, config);
            return true;
        }
        if (interaction.customId === "ticket:unclaim") {
            await ticketManager.unclaimTicket(interaction, config);
            return true;
        }
        if (interaction.customId === "ticket:close") {
            if (config.tickets?.requireCloseReason) {
                const modal = new ModalBuilder().setCustomId("ticket:close_reason").setTitle("Close Ticket");
                const reasonInput = new TextInputBuilder()
                    .setCustomId("reason")
                    .setLabel("Close reason")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(500)
                    .setPlaceholder("What was resolved, escalated, or rejected?");
                modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
                await interaction.showModal(modal);
                return true;
            }
            await ticketManager.closeTicket(interaction, config, { reason: "Closed with panel button" });
            return true;
        }
        if (interaction.customId.startsWith("ticket:priority:")) {
            const priority = interaction.customId.split(":")[2] || "normal";
            await ticketManager.setTicketPriority(interaction, config, priority);
            return true;
        }
        if (interaction.customId.startsWith("ticket:status:")) {
            const status = interaction.customId.split(":")[2] || "open";
            await ticketManager.setTicketStatus(interaction, config, status);
            return true;
        }
        return true;
    }

    if (interaction.isStringSelectMenu?.() && interaction.customId === "ticket:type") {
        if (!interaction.guild) {
            await safeReply(interaction, { content: "Tickets only work inside a server.", flags: [MessageFlags.Ephemeral] });
            return true;
        }
        const config = getGuildConfig(interaction.guild.id);
        if (!moduleEnabled(config, "tickets", false)) {
            await safeReply(interaction, { content: "Tickets are disabled on this server.", flags: [MessageFlags.Ephemeral] });
            return true;
        }
        const typeKey = interaction.values?.[0] || "support";
        const selectedType = findTicketCategory(config.tickets || {}, typeKey) || {
            key: "support",
            label: "Support",
            priority: config.tickets?.defaultPriority || "normal",
            description: "General support request",
        };
        const modal = new ModalBuilder()
            .setCustomId(`ticket:intake:${selectedType.key}`)
            .setTitle(`${selectedType.label.slice(0, 32)} Ticket`);
        const reasonInput = new TextInputBuilder()
            .setCustomId("reason")
            .setLabel("Describe your request")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(800)
            .setPlaceholder("Explain what happened, what you need, or paste relevant IDs/links.");
        const extraInput = new TextInputBuilder()
            .setCustomId("extra")
            .setLabel("Extra context")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(160)
            .setPlaceholder("Order ID, user ID, appeal case, proof link...");
        modal.addComponents(
            new ActionRowBuilder().addComponents(reasonInput),
            new ActionRowBuilder().addComponents(extraInput)
        );
        await interaction.showModal(modal);
        return true;
    }

    return false;
}

module.exports = {
    findTicketChannelsByOwner,
    openTicketForInteraction,
    handleTicketInteraction,
};
