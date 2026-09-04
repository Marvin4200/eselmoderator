const { getPool } = require("./db");

async function safeQuery(fn) {
    try {
        return await fn(getPool());
    } catch (error) {
        console.warn(`[Tickets] DB operation skipped: ${error.message}`);
        return null;
    }
}

async function recordOpen({ channel, user, type, priority, status = "open", claimedBy = null, reason = "" }) {
    const now = Date.now();
    await safeQuery(pool => pool.query(
        `
        INSERT INTO ticket_records
            (channel_id, guild_id, owner_id, owner_tag, type, priority, status, claimed_by, opened_by, reason, opened_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            type = VALUES(type),
            priority = VALUES(priority),
            status = VALUES(status),
            claimed_by = VALUES(claimed_by),
            reason = VALUES(reason),
            updated_at = VALUES(updated_at)
        `,
        [
            channel.id,
            channel.guild.id,
            user.id,
            user.tag || user.username || user.id,
            type || "Support",
            priority || "normal",
            status,
            claimedBy,
            user.id,
            reason || "",
            now,
            now,
        ]
    ));
}

async function updateState(channel, updates = {}) {
    const channelId = typeof channel === "string"
        ? channel
        : channel?.id || channel?.channelId || null;
    if (!channelId) {
        console.warn("[Tickets] updateState skipped: missing channel id");
        return null;
    }
    const fields = [];
    const values = [];
    for (const [key, column] of Object.entries({
        priority: "priority",
        status: "status",
        claimedBy: "claimed_by",
        type: "type",
        reason: "reason",
    })) {
        if (updates[key] !== undefined) {
            fields.push(`${column} = ?`);
            values.push(updates[key]);
        }
    }
    if (!fields.length) return;
    fields.push("updated_at = ?");
    values.push(Date.now(), channelId);
    await safeQuery(pool => pool.query(
        `UPDATE ticket_records SET ${fields.join(", ")} WHERE channel_id = ?`,
        values
    ));
}

async function recordClose({ channel, closedBy, closeReason, transcriptChannelId = null, transcriptMessageId = null }) {
    const now = Date.now();
    await safeQuery(pool => pool.query(
        `
        UPDATE ticket_records
        SET status = 'closed',
            closed_by = ?,
            close_reason = ?,
            closed_at = ?,
            transcript_channel_id = ?,
            transcript_message_id = ?,
            updated_at = ?
        WHERE channel_id = ?
        `,
        [
            closedBy?.id || null,
            closeReason || "",
            now,
            transcriptChannelId,
            transcriptMessageId,
            now,
            channel.id,
        ]
    ));
}

function noteLine(actor, note) {
    return JSON.stringify({
        at: Date.now(),
        actorId: actor?.id || null,
        actorTag: actor?.tag || actor?.username || actor?.id || "unknown",
        note: String(note || "").trim().slice(0, 1200),
    });
}

function countNotes(value) {
    return String(value || "")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .length;
}

async function appendNote({ channel, actor, note }) {
    const text = String(note || "").trim().slice(0, 1200);
    if (!text) return;
    const now = Date.now();
    await safeQuery(pool => pool.query(
        `
        UPDATE ticket_records
        SET internal_notes = CONCAT(COALESCE(internal_notes, ''), ?),
            updated_at = ?
        WHERE channel_id = ?
        `,
        [`${noteLine(actor, text)}\n`, now, channel.id]
    ));
}

async function recordFeedback({ channelId, rating, user, comment = "" }) {
    const safeRating = Math.max(1, Math.min(5, Number(rating) || 0));
    if (!safeRating) return false;
    const now = Date.now();
    await safeQuery(pool => pool.query(
        `
        UPDATE ticket_records
        SET feedback_rating = ?,
            feedback_user_id = ?,
            feedback_comment = ?,
            feedback_at = ?,
            updated_at = ?
        WHERE channel_id = ?
        `,
        [
            safeRating,
            user?.id || null,
            String(comment || "").trim().slice(0, 1000),
            now,
            now,
            channelId,
        ]
    ));
    return true;
}

async function getTicketStats(guildId, options = {}) {
    const rawSla = Number(options.slaMinutes);
    const slaMinutes = Number.isFinite(rawSla) ? Math.max(0, Math.round(rawSla)) : 0;
    // slaMinutes of 0 disables the SLA, so nothing counts as overdue.
    const overdueExpr = slaMinutes > 0
        ? "SUM(status = 'open' AND opened_at < NOW() - INTERVAL ? MINUTE)"
        : '0';
    const baseStatsParams = slaMinutes > 0 ? [slaMinutes, guildId] : [guildId];

    const baseStatsQuery = `
        SELECT
            COUNT(*) AS total,
            SUM(status = 'open') AS open,
            SUM(status = 'closed') AS closed,
            SUM(priority = 'high' AND status = 'open') AS highOpen,
            SUM(claimed_by IS NOT NULL AND status = 'open') AS claimedOpen,
            ${overdueExpr} AS overdueOpen,
            AVG(IF(feedback_rating IS NOT NULL, feedback_rating, NULL)) AS feedbackAvg,
            COUNT(IF(feedback_rating IS NOT NULL, 1, NULL)) AS feedbackCount
        FROM ticket_records
        WHERE guild_id = ?;
    `;

    const byStatusQuery = `
        SELECT status, COUNT(*) AS count
        FROM ticket_records
        WHERE guild_id = ?
        GROUP BY status;
    `;

    const byPriorityQuery = `
        SELECT priority, COUNT(*) AS count
        FROM ticket_records
        WHERE guild_id = ?
        GROUP BY priority;
    `;

    const topClaimersQuery = `
        SELECT claimed_by, COUNT(*) AS count
        FROM ticket_records
        WHERE guild_id = ? AND claimed_by IS NOT NULL
        GROUP BY claimed_by
        ORDER BY count DESC
        LIMIT 10;
    `;

    const resolvedStatsQuery = `
        SELECT 
            AVG(TIMESTAMPDIFF(MINUTE, opened_at, closed_at)) AS avgResolutionMinutes,
            COUNT(*) AS resolvedCount
        FROM ticket_records
        WHERE guild_id = ? AND status = 'closed';
    `;

    const [baseStats, byStatus, byPriority, topClaimers, resolvedStats] = await Promise.all([
        safeQuery(pool => pool.query(baseStatsQuery, baseStatsParams)),
        safeQuery(pool => pool.query(byStatusQuery, [guildId])),
        safeQuery(pool => pool.query(byPriorityQuery, [guildId])),
        safeQuery(pool => pool.query(topClaimersQuery, [guildId])),
        safeQuery(pool => pool.query(resolvedStatsQuery, [guildId]))
    ]);

    const rowsFromResult = (result) => {
        if (Array.isArray(result?.[0])) return result[0];
        if (Array.isArray(result)) return result;
        return [];
    };

    const firstRowFromResult = (result) => rowsFromResult(result)[0] || {};

    const baseRow = firstRowFromResult(baseStats);
    const statusRows = rowsFromResult(byStatus);
    const priorityRows = rowsFromResult(byPriority);
    const claimerRows = rowsFromResult(topClaimers);
    const resolvedRow = firstRowFromResult(resolvedStats);

    return {
        ...baseRow,
        byStatus: statusRows.map(row => ({ status: row.status, count: row.count })),
        byPriority: priorityRows.map(row => ({ priority: row.priority, count: row.count })),
        feedback: {
            average: baseRow.feedbackAvg || 0,
            count: baseRow.feedbackCount || 0
        },
        claimed: {
            openClaimed: baseRow.claimedOpen || 0,
            topClaimers: claimerRows.map(row => ({ claimedBy: row.claimed_by, count: row.count }))
        },
        avgResolutionMinutes: resolvedRow.avgResolutionMinutes || 0,
        resolvedCount: resolvedRow.resolvedCount || 0
    };
}

async function getRecentTickets(guildId, limit = 20) {
    const result = await safeQuery(pool => pool.query(
        `
        SELECT channel_id AS channelId, owner_id AS ownerId, owner_tag AS ownerTag,
               type, priority, status, claimed_by AS claimedBy, opened_by AS openedBy,
               closed_by AS closedBy, reason, close_reason AS closeReason,
               opened_at AS openedAt, closed_at AS closedAt,
               transcript_channel_id AS transcriptChannelId,
               transcript_message_id AS transcriptMessageId,
               internal_notes AS internalNotes,
               feedback_rating AS feedbackRating,
               feedback_user_id AS feedbackUserId,
               feedback_comment AS feedbackComment,
               feedback_at AS feedbackAt,
               updated_at AS updatedAt
        FROM ticket_records
        WHERE guild_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
        `,
        [guildId, Math.max(1, Math.min(100, Number(limit) || 20))]
    ));
    return (result?.[0] || []).map(row => ({
        ...row,
        noteCount: countNotes(row.internalNotes),
        internalNotes: undefined,
    }));
}

module.exports = {
    appendNote,
    getRecentTickets,
    getTicketStats,
    recordFeedback,
    recordClose,
    recordOpen,
    updateState,
};
