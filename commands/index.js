// EselModerator Slash-Commands.
//
// Bringt Command-Definitionen (fuer die Discord-Registrierung) und die Ausfuehrungslogik
// zusammen, gleiches Muster wie fahrstuhl/commands/index.js. Aktuell nur /mod (Phase 2,
// Moderation) -- weitere Module (AutoMod, Welcome, Reaction-Roles, Leveling, Tickets, ...)
// kommen als weitere `if (interaction.commandName === ...)`-Bloecke dazu.
const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    PermissionsBitField,
} = require("discord.js");
const { safeReply } = require("../utils/index");
const { getGuildConfig } = require("../utils/config");
const { parseBoolean } = require("../utils/valueParsers");
const { sendServerLog } = require("../utils/serverLogger");
const { getPool } = require("../utils/db");

const commands = [
    new SlashCommandBuilder()
        .setName("mod")
        .setDescription("🛡️ Moderate your server and track cases")
        .addSubcommand(subcommand =>
            subcommand
                .setName("warn")
                .setDescription("Warn a member and save the case")
                .addUserOption(option =>
                    option.setName("user")
                        .setDescription("The member to warn")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName("reason")
                        .setDescription("Why are they being warned?")
                        .setRequired(false)
                        .setMaxLength(250)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("timeout")
                .setDescription("Timeout a member and save the case")
                .addUserOption(option =>
                    option.setName("user")
                        .setDescription("The member to timeout")
                        .setRequired(true)
                )
                .addIntegerOption(option =>
                    option.setName("minutes")
                        .setDescription("Timeout duration in minutes")
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(10080)
                )
                .addStringOption(option =>
                    option.setName("reason")
                        .setDescription("Why are they being timed out?")
                        .setRequired(false)
                        .setMaxLength(250)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("untimeout")
                .setDescription("Remove an active timeout")
                .addUserOption(option =>
                    option.setName("user")
                        .setDescription("The member to untimeout")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName("reason")
                        .setDescription("Why is the timeout removed?")
                        .setRequired(false)
                        .setMaxLength(250)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("ban")
                .setDescription("Ban a member from the server")
                .addUserOption(option =>
                    option.setName("user")
                        .setDescription("The member to ban")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName("reason")
                        .setDescription("Why are they being banned?")
                        .setRequired(false)
                        .setMaxLength(250)
                )
                .addIntegerOption(option =>
                    option.setName("delete_messages")
                        .setDescription("Delete message history from last X hours (default: 0)")
                        .setRequired(false)
                        .setMinValue(0)
                        .setMaxValue(168)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("kick")
                .setDescription("Kick a member from the server")
                .addUserOption(option =>
                    option.setName("user")
                        .setDescription("The member to kick")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName("reason")
                        .setDescription("Why are they being kicked?")
                        .setRequired(false)
                        .setMaxLength(250)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("history")
                .setDescription("Show recent moderation cases for a member")
                .addUserOption(option =>
                    option.setName("user")
                        .setDescription("The member")
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("cases")
                .setDescription("Browse all mod cases for this server with optional filters")
                .addStringOption(option =>
                    option.setName("type")
                        .setDescription("Filter by case type")
                        .setRequired(false)
                        .addChoices(
                            { name: "Warn", value: "warn" },
                            { name: "Timeout", value: "timeout" },
                            { name: "Kick", value: "kick" },
                            { name: "Ban", value: "ban" },
                            { name: "Unban", value: "unban" },
                            { name: "AutoMod", value: "automod" },
                        )
                )
                .addIntegerOption(option =>
                    option.setName("page")
                        .setDescription("Page number (default: 1)")
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(100)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("unban")
                .setDescription("Unban a previously banned user by ID")
                .addStringOption(option =>
                    option.setName("userid")
                        .setDescription("The Discord user ID to unban")
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName("reason")
                        .setDescription("Why are they being unbanned?")
                        .setRequired(false)
                        .setMaxLength(250)
                )
        ),
];

// 1:1 aus fahrstuhl/commands/index.js (mod-Block) uebernommen -- Verhalten bewusst identisch,
// damit Server, die von Fahrstuhl migrieren, keine Ueberraschungen erleben.
async function handleModCommand(interaction) {
    const config = getGuildConfig(interaction.guildId);
    const enabled = parseBoolean(config.modules?.moderation, true);
    if (!enabled) {
        return safeReply(interaction, {
            content: "🛡️ Moderation is disabled on this server. Enable it in the EselModerator Dashboard under Modules.",
            flags: [MessageFlags.Ephemeral],
        });
    }

    const hasConfiguredAdminRole = config.adminRoleId && interaction.member.roles.cache.has(config.adminRoleId);
    const hasDiscordModPerms = interaction.memberPermissions?.has(PermissionsBitField.Flags.ModerateMembers)
        || interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages)
        || interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
    if (!hasConfiguredAdminRole && !hasDiscordModPerms) {
        return safeReply(interaction, {
            content: "🛡️ You need Discord moderation permissions or the configured Dashboard Admin role.",
            flags: [MessageFlags.Ephemeral],
        });
    }

    const createCase = async ({ userId, type, reason, durationMs = null, expiresAt = null, status = "active" }) => {
        const now = Date.now();
        const pool = getPool();
        const [result] = await pool.query(
            `INSERT INTO moderation_cases
                (guild_id, user_id, moderator_id, type, reason, duration_ms, expires_at, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [interaction.guildId, userId, interaction.user.id, type, reason, durationMs, expiresAt, status, now, now]
        );
        return Number(result.insertId || 0);
    };

    const subcommand = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser("user");
    const targetMember = targetUser
        ? await interaction.guild.members.fetch(targetUser.id).catch(() => null)
        : null;

    if (subcommand === "history") {
        const pool = getPool();
        const [rows] = await pool.query(
            `SELECT id, type, reason, status, duration_ms, expires_at, created_at
             FROM moderation_cases
             WHERE guild_id = ? AND user_id = ?
             ORDER BY created_at DESC
             LIMIT 8`,
            [interaction.guildId, targetUser.id]
        );
        const lines = rows.map(row => {
            const created = row.created_at ? `<t:${Math.floor(Number(row.created_at) / 1000)}:R>` : "unknown";
            const reason = String(row.reason || "No reason").slice(0, 90);
            return `#${row.id} **${row.type}** (${row.status}) ${created}\n${reason}`;
        });
        const embed = new EmbedBuilder()
            .setColor(0x667eea)
            .setTitle(`🛡️ Mod history: ${targetUser.username}`)
            .setDescription(lines.length ? lines.join("\n\n") : "No moderation cases found.")
            .setThumbnail(targetUser.displayAvatarURL({ size: 128 }));
        return safeReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    if (subcommand === "cases") {
        const pool = getPool();
        const typeArg = interaction.options.getString("type") || null;
        const page = Math.max(1, interaction.options.getInteger("page") || 1);
        const pageSize = 8;

        const params = [interaction.guildId];
        let where = "guild_id = ?";
        if (typeArg) { where += " AND type = ?"; params.push(typeArg); }

        const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM moderation_cases WHERE ${where}`, params);
        const totalCount = Number(total) || 0;
        const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
        const safePage = Math.min(page, totalPages);
        const queryParams = [...params, pageSize, (safePage - 1) * pageSize];
        const [rows] = await pool.query(
            `SELECT id, user_id, moderator_id, type, reason, status, created_at
             FROM moderation_cases WHERE ${where}
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            queryParams
        );

        const lines = rows.map(row => {
            const created = row.created_at ? `<t:${Math.floor(Number(row.created_at) / 1000)}:d>` : "unknown";
            const reason = String(row.reason || "No reason").slice(0, 70);
            return `#${row.id} **${row.type}** <@${row.user_id}> ${created}\n└ ${reason}`;
        });

        const embed = new EmbedBuilder()
            .setColor(0x667eea)
            .setTitle(`🛡️ Cases – ${interaction.guild.name}${typeArg ? ` (${typeArg})` : ""}`)
            .setDescription(lines.length ? lines.join("\n\n") : "No cases found.")
            .setFooter({ text: `Page ${safePage}/${totalPages} · ${totalCount} total · Use /mod cases page:<number>` });
        return safeReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    if (!targetMember) {
        return safeReply(interaction, {
            content: "🛡️ I could not find that member on this server.",
            flags: [MessageFlags.Ephemeral],
        });
    }

    if (targetMember.id === interaction.user.id || targetMember.id === interaction.client.user.id) {
        return safeReply(interaction, {
            content: "🛡️ That target is not valid for this moderation action.",
            flags: [MessageFlags.Ephemeral],
        });
    }

    if (subcommand === "warn") {
        const reason = interaction.options.getString("reason") || "No reason provided";
        const caseId = await createCase({ userId: targetMember.id, type: "warn", reason });
        const embed = new EmbedBuilder()
            .setColor(0xFEE75C)
            .setTitle("🛡️ Warning recorded")
            .addFields(
                { name: "Member", value: `<@${targetMember.id}>`, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false }
            )
            .setTimestamp();
        targetMember.send(`You were warned in **${interaction.guild.name}**: ${reason}`).catch(() => {});
        sendServerLog(interaction.guild, config, "moderation", {
            title: "Warning Recorded",
            description: `${interaction.user} warned ${targetMember.user}.`,
            color: 0xFEE75C,
            fields: [
                { name: "Member", value: `${targetMember.user.username}\n\`${targetMember.id}\``, inline: true },
                { name: "Moderator", value: `${interaction.user.username}\n\`${interaction.user.id}\``, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false },
            ],
        }).catch(() => {});
        return safeReply(interaction, { embeds: [embed] });
    }

    if (subcommand === "timeout") {
        if (!hasConfiguredAdminRole && !interaction.memberPermissions?.has(PermissionsBitField.Flags.ModerateMembers)) {
            return safeReply(interaction, {
                content: "🛡️ You need **Moderate Members** permission for /mod timeout.",
                flags: [MessageFlags.Ephemeral],
            });
        }
        const minutes = interaction.options.getInteger("minutes");
        const reason = interaction.options.getString("reason") || "No reason provided";
        const durationMs = minutes * 60 * 1000;
        const expiresAt = Date.now() + durationMs;
        const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
        if (!me?.permissions?.has(PermissionsBitField.Flags.ModerateMembers)) {
            return safeReply(interaction, {
                content: "🛡️ I need **Moderate Members** to timeout members.",
                flags: [MessageFlags.Ephemeral],
            });
        }
        if (!targetMember.moderatable) {
            return safeReply(interaction, {
                content: "🛡️ I cannot timeout this member. Check role hierarchy and permissions.",
                flags: [MessageFlags.Ephemeral],
            });
        }

        await targetMember.timeout(durationMs, `${reason} | by ${interaction.user.username}`);
        const caseId = await createCase({ userId: targetMember.id, type: "timeout", reason, durationMs, expiresAt });
        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("🛡️ Member timed out")
            .addFields(
                { name: "Member", value: `<@${targetMember.id}>`, inline: true },
                { name: "Duration", value: `${minutes} minute(s)`, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false }
            )
            .setTimestamp();
        sendServerLog(interaction.guild, config, "moderation", {
            title: "Member Timed Out",
            description: `${interaction.user} timed out ${targetMember.user}.`,
            color: 0xED4245,
            fields: [
                { name: "Member", value: `${targetMember.user.username}\n\`${targetMember.id}\``, inline: true },
                { name: "Moderator", value: `${interaction.user.username}\n\`${interaction.user.id}\``, inline: true },
                { name: "Duration", value: `${minutes} minute(s)`, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false },
            ],
        }).catch(() => {});
        return safeReply(interaction, { embeds: [embed] });
    }

    if (subcommand === "untimeout") {
        if (!hasConfiguredAdminRole && !interaction.memberPermissions?.has(PermissionsBitField.Flags.ModerateMembers)) {
            return safeReply(interaction, {
                content: "🛡️ You need **Moderate Members** permission for /mod untimeout.",
                flags: [MessageFlags.Ephemeral],
            });
        }
        const reason = interaction.options.getString("reason") || "Timeout cleared";
        const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
        if (!me?.permissions?.has(PermissionsBitField.Flags.ModerateMembers)) {
            return safeReply(interaction, {
                content: "🛡️ I need **Moderate Members** to remove timeouts.",
                flags: [MessageFlags.Ephemeral],
            });
        }
        if (!targetMember.moderatable) {
            return safeReply(interaction, {
                content: "🛡️ I cannot edit this member. Check role hierarchy and permissions.",
                flags: [MessageFlags.Ephemeral],
            });
        }

        await targetMember.timeout(null, `${reason} | by ${interaction.user.username}`);
        const pool = getPool();
        const now = Date.now();
        await pool.query(
            `UPDATE moderation_cases
             SET status = 'resolved', updated_at = ?
             WHERE guild_id = ? AND user_id = ? AND type = 'timeout' AND status = 'active'`,
            [now, interaction.guildId, targetMember.id]
        );
        const caseId = await createCase({ userId: targetMember.id, type: "untimeout", reason, status: "resolved" });
        const embed = new EmbedBuilder()
            .setColor(0x51cf66)
            .setTitle("🛡️ Timeout removed")
            .addFields(
                { name: "Member", value: `<@${targetMember.id}>`, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false }
            )
            .setTimestamp();
        sendServerLog(interaction.guild, config, "moderation", {
            title: "Timeout Removed",
            description: `${interaction.user} removed timeout from ${targetMember.user}.`,
            color: 0x51cf66,
            fields: [
                { name: "Member", value: `${targetMember.user.username}\n\`${targetMember.id}\``, inline: true },
                { name: "Moderator", value: `${interaction.user.username}\n\`${interaction.user.id}\``, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false },
            ],
        }).catch(() => {});
        return safeReply(interaction, { embeds: [embed] });
    }

    if (subcommand === "ban") {
        if (!hasConfiguredAdminRole && !interaction.memberPermissions?.has(PermissionsBitField.Flags.BanMembers)) {
            return safeReply(interaction, {
                content: "🛡️ You need **Ban Members** permission for /mod ban.",
                flags: [MessageFlags.Ephemeral],
            });
        }
        const reason = interaction.options.getString("reason") || "No reason provided";
        const deleteHours = interaction.options.getInteger("delete_messages") || 0;
        const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
        if (!me?.permissions?.has(PermissionsBitField.Flags.BanMembers)) {
            return safeReply(interaction, {
                content: "🛡️ I need **Ban Members** permission.",
                flags: [MessageFlags.Ephemeral],
            });
        }
        if (!targetMember.bannable) {
            return safeReply(interaction, {
                content: "🛡️ I cannot ban this member. Check role hierarchy and permissions.",
                flags: [MessageFlags.Ephemeral],
            });
        }

        await targetMember.send(`You were banned from **${interaction.guild.name}**: ${reason}`).catch(() => {});
        await targetMember.ban({ reason: `${reason} | by ${interaction.user.username}`, deleteMessageSeconds: deleteHours * 3600 });
        const caseId = await createCase({ userId: targetMember.id, type: "ban", reason });
        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("🛡️ Member banned")
            .addFields(
                { name: "Member", value: `${targetUser.username}\n\`${targetUser.id}\``, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false }
            )
            .setTimestamp();
        sendServerLog(interaction.guild, config, "moderation", {
            title: "Member Banned",
            description: `${interaction.user} banned ${targetUser.username}.`,
            color: 0xED4245,
            fields: [
                { name: "Member", value: `${targetUser.username}\n\`${targetUser.id}\``, inline: true },
                { name: "Moderator", value: `${interaction.user.username}\n\`${interaction.user.id}\``, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false },
            ],
        }).catch(() => {});
        return safeReply(interaction, { embeds: [embed] });
    }

    if (subcommand === "kick") {
        if (!hasConfiguredAdminRole && !interaction.memberPermissions?.has(PermissionsBitField.Flags.KickMembers)) {
            return safeReply(interaction, {
                content: "🛡️ You need **Kick Members** permission for /mod kick.",
                flags: [MessageFlags.Ephemeral],
            });
        }
        const reason = interaction.options.getString("reason") || "No reason provided";
        const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
        if (!me?.permissions?.has(PermissionsBitField.Flags.KickMembers)) {
            return safeReply(interaction, {
                content: "🛡️ I need **Kick Members** permission.",
                flags: [MessageFlags.Ephemeral],
            });
        }
        if (!targetMember.kickable) {
            return safeReply(interaction, {
                content: "🛡️ I cannot kick this member. Check role hierarchy and permissions.",
                flags: [MessageFlags.Ephemeral],
            });
        }

        await targetMember.send(`You were kicked from **${interaction.guild.name}**: ${reason}`).catch(() => {});
        await targetMember.kick(`${reason} | by ${interaction.user.username}`);
        const caseId = await createCase({ userId: targetMember.id, type: "kick", reason });
        const embed = new EmbedBuilder()
            .setColor(0xE67E22)
            .setTitle("🛡️ Member kicked")
            .addFields(
                { name: "Member", value: `${targetUser.username}\n\`${targetUser.id}\``, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false }
            )
            .setTimestamp();
        sendServerLog(interaction.guild, config, "moderation", {
            title: "Member Kicked",
            description: `${interaction.user} kicked ${targetUser.username}.`,
            color: 0xE67E22,
            fields: [
                { name: "Member", value: `${targetUser.username}\n\`${targetUser.id}\``, inline: true },
                { name: "Moderator", value: `${interaction.user.username}\n\`${interaction.user.id}\``, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false },
            ],
        }).catch(() => {});
        return safeReply(interaction, { embeds: [embed] });
    }

    if (subcommand === "unban") {
        if (!hasConfiguredAdminRole && !interaction.memberPermissions?.has(PermissionsBitField.Flags.BanMembers)) {
            return safeReply(interaction, {
                content: "🛡️ You need **Ban Members** permission for /mod unban.",
                flags: [MessageFlags.Ephemeral],
            });
        }
        const rawId = interaction.options.getString("userid").trim();
        const reason = interaction.options.getString("reason") || "No reason provided";
        const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
        if (!me?.permissions?.has(PermissionsBitField.Flags.BanMembers)) {
            return safeReply(interaction, {
                content: "🛡️ I need **Ban Members** permission to unban users.",
                flags: [MessageFlags.Ephemeral],
            });
        }
        if (!/^\d{17,20}$/.test(rawId)) {
            return safeReply(interaction, {
                content: "🛡️ Please provide a valid Discord user ID (17-20 digits).",
                flags: [MessageFlags.Ephemeral],
            });
        }

        const ban = await interaction.guild.bans.fetch(rawId).catch(() => null);
        if (!ban) {
            return safeReply(interaction, {
                content: `🛡️ User \`${rawId}\` is not currently banned on this server.`,
                flags: [MessageFlags.Ephemeral],
            });
        }

        await interaction.guild.members.unban(rawId, `${reason} | by ${interaction.user.username}`);
        const pool = getPool();
        const now = Date.now();
        await pool.query(
            `UPDATE moderation_cases
             SET status = 'resolved', updated_at = ?
             WHERE guild_id = ? AND user_id = ? AND type = 'ban' AND status = 'active'`,
            [now, interaction.guildId, rawId]
        );
        const caseId = await createCase({ userId: rawId, type: "unban", reason, status: "resolved" });
        const embed = new EmbedBuilder()
            .setColor(0x51cf66)
            .setTitle("🛡️ User unbanned")
            .addFields(
                { name: "User", value: `${ban.user.username}\n\`${rawId}\``, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false }
            )
            .setTimestamp();
        sendServerLog(interaction.guild, config, "moderation", {
            title: "User Unbanned",
            description: `${interaction.user} unbanned ${ban.user.username}.`,
            color: 0x51cf66,
            fields: [
                { name: "User", value: `${ban.user.username}\n\`${rawId}\``, inline: true },
                { name: "Moderator", value: `${interaction.user.username}\n\`${interaction.user.id}\``, inline: true },
                { name: "Case", value: `#${caseId}`, inline: true },
                { name: "Reason", value: reason, inline: false },
            ],
        }).catch(() => {});
        return safeReply(interaction, { embeds: [embed] });
    }
}

async function handleInteraction(interaction) {
    try {
        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === "mod") {
            return handleModCommand(interaction);
        }
    } catch (err) {
        if (err.code !== 10062 && err.code !== 40060) {
            console.error("Interaction handler error:", err);
        }
        await safeReply(interaction, {
            content: "❌ Something went wrong handling that command.",
            flags: [MessageFlags.Ephemeral],
        }).catch(() => {});
    }
}

module.exports = {
    commands,
    handleInteraction,
};
