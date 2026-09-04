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
const { handleReactionRoleButton, handleReactionRoleSelect } = require("../utils/reactionRoles");
const { tempVoiceChannels } = require("../utils/tempVoice");
const levelingManager = require("../utils/levelingManager");
const ticketManager = require("../utils/ticketManager");
const { handleTicketInteraction } = require("../utils/ticketInteractions");

function moduleEnabled(config, key, fallback = false) {
    const modules = config.modules || {};
    return parseBoolean(modules[key], fallback);
}

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
    new SlashCommandBuilder()
        .setName("voice")
        .setDescription("🔊 Manage your temporary voice channel")
        .addSubcommand(subcommand =>
            subcommand
                .setName("rename")
                .setDescription("Rename your temp voice channel")
                .addStringOption(option =>
                    option.setName("name")
                        .setDescription("New channel name (max 90 chars)")
                        .setRequired(true)
                        .setMaxLength(90)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("lock")
                .setDescription("Lock your temp voice channel (nobody can join)")
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("unlock")
                .setDescription("Unlock your temp voice channel (everyone can join again)")
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("limit")
                .setDescription("Set a user limit for your temp voice channel")
                .addIntegerOption(option =>
                    option.setName("slots")
                        .setDescription("Max users (0 = no limit)")
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(99)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("kick")
                .setDescription("Kick a user from your temp voice channel")
                .addUserOption(option =>
                    option.setName("user")
                        .setDescription("The user to kick from the channel")
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("claim")
                .setDescription("Claim ownership of a temp voice channel (if owner left)")
        ),
    new SlashCommandBuilder()
        .setName("rank")
        .setDescription("📈 Show your server level or another user's rank")
        .addUserOption(option =>
            option.setName("user")
                .setDescription("The user")
                .setRequired(false)
        ),
    new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("🏆 Show this server's leveling leaderboard")
        .addIntegerOption(option =>
            option.setName("page")
                .setDescription("Leaderboard page number")
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(200)
        ),
    new SlashCommandBuilder()
        .setName("leveling")
        .setDescription("📈 Manage leveling data for this server")
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName("resetuser")
                .setDescription("Reset XP and level for a specific member")
                .addUserOption(option =>
                    option.setName("user")
                        .setDescription("The member to reset")
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("resetserver")
                .setDescription("Reset ALL leveling data for this server (cannot be undone)")
        ),
    new SlashCommandBuilder()
        .setName("ticket")
        .setDescription("🎫 Open, manage and close private support tickets")
        .addSubcommand(subcommand =>
            subcommand
                .setName("open")
                .setDescription("Open a private support ticket")
                .addStringOption(option =>
                    option.setName("reason")
                        .setDescription("What do you need help with?")
                        .setRequired(false)
                        .setMaxLength(120)
                )
                .addStringOption(option =>
                    option.setName("priority")
                        .setDescription("How urgent is this ticket?")
                        .setRequired(false)
                        .addChoices(
                            { name: "Normal", value: "normal" },
                            { name: "High", value: "high" },
                            { name: "Low", value: "low" }
                        )
                )
                .addStringOption(option =>
                    option.setName("type")
                        .setDescription("What kind of ticket is this?")
                        .setRequired(false)
                        .addChoices(
                            { name: "Support", value: "Support" },
                            { name: "Report", value: "Report" },
                            { name: "Appeal", value: "Appeal" },
                            { name: "Partnership", value: "Partnership" },
                            { name: "Other", value: "Other" }
                        )
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("close")
                .setDescription("Close this ticket channel")
                .addStringOption(option =>
                    option.setName("reason")
                        .setDescription("Why is this ticket being closed?")
                        .setRequired(false)
                        .setMaxLength(160)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("note")
                .setDescription("Add an internal staff note to this ticket")
                .addStringOption(option =>
                    option.setName("text")
                        .setDescription("Internal note for the ticket archive")
                        .setRequired(true)
                        .setMaxLength(1000)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("adduser")
                .setDescription("Give another member access to this ticket")
                .addUserOption(option =>
                    option.setName("user")
                        .setDescription("Member to add")
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("removeuser")
                .setDescription("Remove a directly added member from this ticket")
                .addUserOption(option =>
                    option.setName("user")
                        .setDescription("Member to remove")
                        .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("claim")
                .setDescription("Claim this ticket as the handling staff member")
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("unclaim")
                .setDescription("Release this ticket back to the team")
        ),
    new SlashCommandBuilder()
        .setName("serverbackup")
        .setDescription("💾 Backup and view your server structure (roles, channels, emojis, settings)")
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName("create")
                .setDescription("Create a full server backup (roles, channels, emojis, settings)")
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("list")
                .setDescription("List existing server backups")
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName("info")
                .setDescription("Show details of a specific backup")
                .addStringOption(option =>
                    option.setName("filename")
                        .setDescription("Backup ID (from /serverbackup list)")
                        .setRequired(true)
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

// 1:1 aus fahrstuhl/commands/index.js (voice-Block) uebernommen.
async function handleVoiceCommand(interaction) {
    const sub = interaction.options.getSubcommand();
    const member = interaction.member;
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
        return safeReply(interaction, { content: "❌ Du bist in keinem Voice-Channel.", flags: [MessageFlags.Ephemeral] });
    }

    const tvData = tempVoiceChannels?.get(voiceChannel.id);
    const isOwner = tvData?.ownerId === interaction.user.id;

    if (sub === "claim") {
        if (!tvData) {
            return safeReply(interaction, { content: "❌ Das ist kein Temp Voice Channel.", flags: [MessageFlags.Ephemeral] });
        }
        const ownerInChannel = voiceChannel.members.has(tvData.ownerId);
        if (ownerInChannel) {
            return safeReply(interaction, { content: "❌ Der Owner ist noch im Channel. Du kannst ihn nicht claimen.", flags: [MessageFlags.Ephemeral] });
        }
        tempVoiceChannels.set(voiceChannel.id, { ...tvData, ownerId: interaction.user.id });
        try {
            await getPool().query("UPDATE temp_voice_channels SET owner_id = ? WHERE channel_id = ?", [interaction.user.id, voiceChannel.id]);
        } catch (dbErr) {
            console.warn(`⚠️ Failed to persist temp voice claim for ${voiceChannel.id}: ${dbErr.message}`);
        }
        return safeReply(interaction, { content: `✅ Du bist jetzt Owner von **${voiceChannel.name}**.`, flags: [MessageFlags.Ephemeral] });
    }

    if (!tvData) {
        return safeReply(interaction, { content: "❌ Das ist kein Temp Voice Channel.", flags: [MessageFlags.Ephemeral] });
    }
    if (!isOwner) {
        return safeReply(interaction, { content: "❌ Du bist nicht der Owner dieses Channels.", flags: [MessageFlags.Ephemeral] });
    }

    const config = getGuildConfig(interaction.guildId);
    const tvSettings = (config.tempVoice && typeof config.tempVoice === "object") ? config.tempVoice : {};

    if (sub === "rename") {
        if (!parseBoolean(tvSettings.allowRename, true)) {
            return safeReply(interaction, { content: "❌ Rename ist auf diesem Server deaktiviert.", flags: [MessageFlags.Ephemeral] });
        }
        const newName = interaction.options.getString("name").replace(/[\\/#]/g, " ").trim().slice(0, 90);
        if (!newName) return safeReply(interaction, { content: "❌ Ungültiger Name.", flags: [MessageFlags.Ephemeral] });
        await voiceChannel.setName(newName, "EselModerator temp voice rename").catch(() => null);
        return safeReply(interaction, { content: `✅ Channel umbenannt zu **${newName}**.`, flags: [MessageFlags.Ephemeral] });
    }

    if (sub === "lock") {
        if (!parseBoolean(tvSettings.allowLock, true)) {
            return safeReply(interaction, { content: "❌ Lock ist auf diesem Server deaktiviert.", flags: [MessageFlags.Ephemeral] });
        }
        await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false }, { reason: "EselModerator temp voice lock" }).catch(() => null);
        return safeReply(interaction, { content: `🔒 **${voiceChannel.name}** ist jetzt gesperrt.`, flags: [MessageFlags.Ephemeral] });
    }

    if (sub === "unlock") {
        if (!parseBoolean(tvSettings.allowLock, true)) {
            return safeReply(interaction, { content: "❌ Lock ist auf diesem Server deaktiviert.", flags: [MessageFlags.Ephemeral] });
        }
        await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null }, { reason: "EselModerator temp voice unlock" }).catch(() => null);
        return safeReply(interaction, { content: `🔓 **${voiceChannel.name}** ist jetzt offen.`, flags: [MessageFlags.Ephemeral] });
    }

    if (sub === "limit") {
        if (!parseBoolean(tvSettings.allowLimit, true)) {
            return safeReply(interaction, { content: "❌ Limit ist auf diesem Server deaktiviert.", flags: [MessageFlags.Ephemeral] });
        }
        const slots = interaction.options.getInteger("slots");
        await voiceChannel.setUserLimit(slots, "EselModerator temp voice limit").catch(() => null);
        return safeReply(interaction, {
            content: slots === 0 ? `✅ User-Limit für **${voiceChannel.name}** entfernt.` : `✅ User-Limit auf **${slots}** gesetzt.`,
            flags: [MessageFlags.Ephemeral],
        });
    }

    if (sub === "kick") {
        const target = interaction.options.getMember("user");
        if (!target) return safeReply(interaction, { content: "❌ User nicht gefunden.", flags: [MessageFlags.Ephemeral] });
        if (target.id === interaction.user.id) return safeReply(interaction, { content: "❌ Du kannst dich nicht selbst kicken.", flags: [MessageFlags.Ephemeral] });
        if (!voiceChannel.members.has(target.id)) return safeReply(interaction, { content: "❌ Der User ist nicht in deinem Channel.", flags: [MessageFlags.Ephemeral] });
        await target.voice.disconnect("EselModerator temp voice kick").catch(() => null);
        return safeReply(interaction, { content: `✅ **${target.user.username}** wurde aus dem Channel geworfen.`, flags: [MessageFlags.Ephemeral] });
    }
}

// 1:1 aus fahrstuhl/commands/index.js (rank/leaderboard/leveling-Bloecke) uebernommen.
async function handleRankCommand(interaction) {
    const config = getGuildConfig(interaction.guildId);
    if (!parseBoolean(config.modules?.leveling, false)) {
        return safeReply(interaction, {
            content: "📈 Leveling is disabled on this server. Enable it in the EselModerator Dashboard under Modules.",
            flags: [MessageFlags.Ephemeral],
        });
    }

    const targetUser = interaction.options.getUser("user") || interaction.user;
    const settings = levelingManager.getLevelSettings(config);
    const rank = await levelingManager.getUserLevel(interaction.guildId, targetUser.id);
    const progress = rank.nextLevelXp > 0 ? Math.round((rank.currentXp / rank.nextLevelXp) * 100) : 0;
    const cooldownSeconds = Math.max(0, Math.round(settings.cooldownMs / 1000));
    const embed = new EmbedBuilder()
        .setColor(0x667eea)
        .setTitle(`📈 Rank: ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
        .addFields(
            { name: "Level", value: `**${rank.level}**`, inline: true },
            { name: "XP", value: `**${rank.xp}** total`, inline: true },
            { name: "Rank", value: rank.rank ? `#${rank.rank}` : "Not ranked yet", inline: true },
            { name: "Progress", value: `${rank.currentXp}/${rank.nextLevelXp} XP (${progress}%)`, inline: false },
            { name: "Messages", value: String(rank.messageCount || 0), inline: true }
        )
        .setFooter({ text: cooldownSeconds > 0 ? `XP counts once every ${cooldownSeconds}s per user.` : "Every message earns XP while Leveling is enabled." });
    return safeReply(interaction, { embeds: [embed] });
}

async function handleLeaderboardCommand(interaction) {
    const config = getGuildConfig(interaction.guildId);
    if (!parseBoolean(config.modules?.leveling, false)) {
        return safeReply(interaction, {
            content: "📈 Leveling is disabled on this server. Enable it in the EselModerator Dashboard under Modules.",
            flags: [MessageFlags.Ephemeral],
        });
    }

    const page = Math.max(1, interaction.options.getInteger("page") || 1);
    const pageSize = 10;
    const total = await levelingManager.getLeaderboardTotal(interaction.guildId);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * pageSize;
    const rows = await levelingManager.getLeaderboard(interaction.guildId, pageSize, offset);
    const lines = await Promise.all(rows.map(async (row) => {
        const member = await interaction.guild.members.fetch(row.userId).catch(() => null);
        const name = member?.displayName || `<@${row.userId}>`;
        return `**#${row.rank}** ${name} — Level **${row.level}**, ${row.xp} XP`;
    }));
    const embed = new EmbedBuilder()
        .setColor(0x51cf66)
        .setTitle(`🏆 ${interaction.guild.name} Leaderboard`)
        .setDescription(lines.length ? lines.join("\n") : "No XP has been tracked yet.")
        .setFooter({ text: `Page ${safePage}/${totalPages} · ${total} tracked users` });
    return safeReply(interaction, { embeds: [embed] });
}

async function handleLevelingAdminCommand(interaction) {
    const config = getGuildConfig(interaction.guildId);
    if (!parseBoolean(config.modules?.leveling, false)) {
        return safeReply(interaction, {
            content: "📈 Leveling is disabled on this server. Enable it in the EselModerator Dashboard under Modules.",
            flags: [MessageFlags.Ephemeral],
        });
    }

    const hasManageGuild = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)
        || interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
    if (!hasManageGuild) {
        return safeReply(interaction, { content: "📈 You need **Manage Server** permission to manage leveling data.", flags: [MessageFlags.Ephemeral] });
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "resetuser") {
        const targetUser = interaction.options.getUser("user");
        const affected = await levelingManager.resetUserXp(interaction.guildId, targetUser.id);
        const embed = new EmbedBuilder()
            .setColor(0xFEE75C)
            .setTitle("📈 XP Reset")
            .setDescription(affected > 0
                ? `XP and level data for **${targetUser.username}** has been reset.`
                : `**${targetUser.username}** had no XP data on this server.`)
            .setTimestamp();
        return safeReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }
    if (subcommand === "resetserver") {
        const affected = await levelingManager.resetGuildXp(interaction.guildId);
        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle("📈 Server XP Reset")
            .setDescription(`All leveling data for **${interaction.guild.name}** has been wiped.\n${affected} records deleted.`)
            .setTimestamp();
        return safeReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }
}

// 1:1 aus fahrstuhl/commands/index.js (ticket-Block) uebernommen.
async function handleTicketCommand(interaction) {
    const config = getGuildConfig(interaction.guildId);
    if (!moduleEnabled(config, "tickets", false)) {
        return safeReply(interaction, {
            content: "🎫 Tickets are disabled on this server. Enable them in the EselModerator Dashboard under Modules.",
            flags: [MessageFlags.Ephemeral],
        });
    }

    const settings = config.tickets || {};
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "open") {
        const reason = interaction.options.getString("reason") || "No reason provided";
        const priority = interaction.options.getString("priority") || settings.defaultPriority || "normal";
        return ticketManager.openTicket(interaction, config, {
            reason,
            priority,
            typeLabel: interaction.options.getString("type") || "Support",
        });
    }
    if (subcommand === "close") {
        const reason = interaction.options.getString("reason") || "";
        return ticketManager.closeTicket(interaction, config, { reason });
    }
    if (subcommand === "note") {
        return ticketManager.addTicketNote(interaction, config, interaction.options.getString("text"));
    }
    if (subcommand === "adduser") {
        return ticketManager.addTicketUser(interaction, config, interaction.options.getUser("user"));
    }
    if (subcommand === "removeuser") {
        return ticketManager.removeTicketUser(interaction, config, interaction.options.getUser("user"));
    }
    if (subcommand === "claim") {
        return ticketManager.claimTicket(interaction, config);
    }
    if (subcommand === "unclaim") {
        return ticketManager.unclaimTicket(interaction, config);
    }
}

// 1:1 aus fahrstuhl/commands/index.js (serverbackup-Block) uebernommen.
async function handleServerBackupCommand(interaction) {
    const member = interaction.member;
    const isAdmin = member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isAdmin && interaction.user.id !== process.env.OWNER_ID) {
        return safeReply(interaction, {
            content: "❌ Du brauchst Administrator-Rechte für diesen Command.",
            flags: [MessageFlags.Ephemeral],
        });
    }

    const sub = interaction.options.getSubcommand();
    const { createBackupJob, createServerBackup, listGuildBackups, getBackupById } = require("../utils/serverBackup");

    if (sub === "create") {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const botConfig = getGuildConfig(interaction.guild.id);
        const jobId = await createBackupJob(interaction.guild.id);
        createServerBackup(interaction.guild, botConfig, interaction.user.id, jobId).catch(err => {
            console.error('[serverbackup] create error:', err);
        });

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("💾 Server Backup gestartet")
            .setDescription("Das Backup läuft jetzt im Hintergrund.")
            .addFields(
                { name: "Job ID", value: `\`#${jobId}\``, inline: false },
                { name: "Status", value: "Im Dashboard unter Server-Backup live verfolgen.", inline: false },
            )
            .setFooter({ text: "EselModerator Server Backup • Async Queue" })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }

    if (sub === "list") {
        const backups = await listGuildBackups(interaction.guild.id);
        if (!backups.length) {
            return safeReply(interaction, { content: "📂 Keine Backups gefunden. Nutze `/serverbackup create`.", flags: [MessageFlags.Ephemeral] });
        }
        const list = backups.slice(0, 10).map((b) => {
            const when = `<t:${Math.floor(b.createdAt / 1000)}:f>`;
            const msgs = b.stats?.messages ?? '?';
            return `**#${b.id}** · ${when}\n   Rollen: ${b.stats?.roles ?? '?'} · Channels: ${b.stats?.channels ?? '?'} · Nachrichten: ${msgs}`;
        }).join('\n\n');
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`💾 Server Backups – ${interaction.guild.name}`)
            .setDescription(list)
            .setFooter({ text: `${backups.length} Backup(s) · /serverbackup info <id>` });
        return safeReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    if (sub === "info") {
        const filename = interaction.options.getString("filename");
        const backupId = parseInt(filename, 10);
        if (!Number.isFinite(backupId) || backupId < 1) {
            return safeReply(interaction, { content: "❌ Bitte gib eine gültige Backup-ID an (Zahl aus `/serverbackup list`).", flags: [MessageFlags.Ephemeral] });
        }
        const data = await getBackupById(backupId, interaction.guild.id);
        if (!data) {
            return safeReply(interaction, { content: "❌ Backup nicht gefunden.", flags: [MessageFlags.Ephemeral] });
        }
        const meta = data.meta;
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`💾 Backup #${meta.id}`)
            .addFields(
                { name: "Erstellt", value: `<t:${Math.floor(meta.createdAt / 1000)}:f>`, inline: true },
                { name: "Modus", value: String(meta.backupMode || meta.backup_mode || 'full'), inline: true },
                { name: "Rollen", value: String(meta.stats?.roles ?? '?'), inline: true },
                { name: "Channels", value: String(meta.stats?.channels ?? '?'), inline: true },
                { name: "Emojis", value: String(meta.stats?.emojis ?? '?'), inline: true },
                { name: "Sticker", value: String(meta.stats?.stickers ?? '?'), inline: true },
                { name: "Bans", value: String(meta.stats?.bans ?? '?'), inline: true },
                { name: "Nachrichten", value: String(meta.stats?.messages ?? '?'), inline: true },
            )
            .setFooter({ text: `Backup ID #${meta.id}` });
        return safeReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }
}

async function handleInteraction(interaction) {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === "mod") {
                return handleModCommand(interaction);
            }
            if (interaction.commandName === "voice") {
                return handleVoiceCommand(interaction);
            }
            if (interaction.commandName === "rank") {
                return handleRankCommand(interaction);
            }
            if (interaction.commandName === "leaderboard") {
                return handleLeaderboardCommand(interaction);
            }
            if (interaction.commandName === "leveling") {
                return handleLevelingAdminCommand(interaction);
            }
            if (interaction.commandName === "ticket") {
                return handleTicketCommand(interaction);
            }
            if (interaction.commandName === "serverbackup") {
                return handleServerBackupCommand(interaction);
            }
            return;
        }

        const handledAsTicket = await handleTicketInteraction(interaction, { getGuildConfig, moduleEnabled, safeReply });
        if (handledAsTicket) return;

        if (interaction.isButton?.() && interaction.customId?.startsWith("rr:")) {
            return handleReactionRoleButton(interaction, { getGuildConfig, moduleEnabled, safeReply });
        }
        if (interaction.isStringSelectMenu?.() && interaction.customId?.startsWith("rrs:")) {
            return handleReactionRoleSelect(interaction, { getGuildConfig, moduleEnabled, safeReply });
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
