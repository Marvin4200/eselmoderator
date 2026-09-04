/**
 * Discord Server Backup Utility
 * Full server snapshot: roles, channels, emojis, stickers, bans, invites,
 * webhooks, automod rules, scheduled events, threads, audit log, messages,
 * and bot config — stored in MySQL (discord_backups + discord_backup_sections).
 */

const crypto = require('crypto');
const { PermissionsBitField, Routes } = require('discord.js');
const { getPool } = require('./db');

const MAX_BACKUPS_PER_GUILD = 10;
const MESSAGES_PER_CHANNEL = 1000;

// ─── helpers ────────────────────────────────────────────────────────────────

function safeStr(v) { return String(v ?? ''); }

async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
    if (!error) return false;
    if (error.isRateLimit) return true;
    if (Number(error.status) === 429) return true;
    if (Number(error.code) === 429) return true;
    return /rate\s*limit/i.test(String(error.message || ''));
}

function computeRetryDelayMs(error, attempt) {
    const rawRetryAfter = Number(error?.retryAfter ?? error?.rawError?.retry_after ?? error?.data?.retry_after ?? 0);
    let delayMs = 0;

    if (Number.isFinite(rawRetryAfter) && rawRetryAfter > 0) {
        // Discord retry_after is seconds in most payloads/headers. If a very large
        // number appears, treat it as milliseconds to stay safe.
        delayMs = rawRetryAfter > 1000
            ? Math.ceil(rawRetryAfter)
            : Math.ceil(rawRetryAfter * 1000);
    }

    // For true 429s, honor Discord's window and wait until it is over.
    if (error?.isRateLimit && delayMs > 0) {
        return {
            rawRetryAfter,
            delayMs: Math.max(1000, Math.min(delayMs + 500, 900000)),
        };
    }

    if (!delayMs) {
        delayMs = 1500 * Math.max(1, attempt);
    }

    // Keep retries bounded, but still respect meaningful 429 windows.
    return {
        rawRetryAfter,
        delayMs: Math.max(1000, Math.min(delayMs + 300, 120000)),
    };
}

function parseDiscordRetryAfterSeconds(response, data) {
    const bodyRetryAfter = Number(data?.retry_after);
    const headerRetryAfter = Number(response?.headers?.get('retry-after') || 0);
    const headerResetAfter = Number(response?.headers?.get('x-ratelimit-reset-after') || 0);
    const values = [bodyRetryAfter, headerRetryAfter, headerResetAfter]
        .filter(v => Number.isFinite(v) && v > 0);
    if (!values.length) return 0;
    return Math.max(...values);
}

async function runWithDiscordRateLimitWait(action, addLog = null, label = 'Discord-Aktion', maxCycles = 15) {
    let cycles = 0;
    while (true) {
        try {
            return await action();
        } catch (error) {
            if (!isRateLimitError(error)) throw error;
            cycles += 1;
            const delay = computeRetryDelayMs(error, cycles);
            if (addLog) {
                await addLog('429 Rate Limit bei ' + label + '. retry_after=' + (delay.rawRetryAfter || 0) + 's -> warte ' + delay.delayMs + 'ms');
            }
            await wait(delay.delayMs);
            if (cycles >= maxCycles) {
                throw new Error('Zu viele 429-Wartezyklen bei ' + label);
            }
        }
    }
}

async function createRoleViaREST(guild, payload) {
    // Send role-creates directly over HTTP to avoid discord.js REST queue stalls.
    const botToken = guild.client?.token || process.env.DISCORD_TOKEN || process.env.TOKEN;
    if (!botToken) {
        throw new Error('Bot token unavailable for direct Discord REST call');
    }

    const endpoint = 'https://discord.com/api/v10' + Routes.guildRoles(guild.id);
    const body = {
        name: payload.name,
        color: payload.color,
        hoist: payload.hoist,
        mentionable: payload.mentionable,
        permissions: payload.permissions.toString(),
    };

    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: 'Bot ' + botToken,
                'Content-Type': 'application/json',
                ...(payload.reason ? { 'X-Audit-Log-Reason': encodeURIComponent(String(payload.reason).slice(0, 512)) } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
        });
    } catch (e) {
        throw new Error('HTTP role create failed: ' + (e?.message || 'network error'));
    }

    const rawText = await response.text();
    let data = null;
    try {
        data = rawText ? JSON.parse(rawText) : null;
    } catch {
        data = null;
    }

    if (!response.ok) {
        const err = new Error((data && (data.message || data.error)) || ('Discord HTTP ' + response.status));
        err.rawError = data || null;
        err.status = response.status;
        if (response.status === 429) {
            err.isRateLimit = true;
            err.retryAfter = parseDiscordRetryAfterSeconds(response, data);
        }
        throw err;
    }

    return { id: data?.id, name: data?.name || payload.name };
}

async function createRoleWithRetry(guild, payload, retries = 3, addLog = null) {
    let lastError = null;
    let rlCycles = 0;
    for (let attempt = 1; attempt <= retries; attempt++) {
        if (addLog && attempt > 1) await addLog('Retry ' + attempt + '/' + retries + ' Rolle: ' + payload.name);
        try {
            return await runWithDiscordRateLimitWait(
                () => createRoleViaREST(guild, payload),
                addLog,
                'Rolle "' + payload.name + '"',
                12
            );
        } catch (e) {
            lastError = e;
            if (e?.isRateLimit) {
                rlCycles += 1;
                if (rlCycles >= 12) {
                    throw new Error('Zu viele 429-Wartezyklen für Rolle "' + payload.name + '"');
                }
                attempt -= 1;
                continue;
            }

            if (addLog) await addLog('Attempt ' + attempt + ' fehlgeschlagen: ' + e.message);
            if (attempt < retries) {
                const delay = computeRetryDelayMs(e, attempt);
                const delayMs = delay.delayMs;
                if (addLog) await addLog('Warte ' + delayMs + 'ms vor nächstem Versuch...');
                await wait(delayMs);
            }
        }
    }
    throw lastError;
}

function normalizeRolePermissions(inputPermissions, fallback = 0n) {
    try {
        return BigInt(String(inputPermissions ?? fallback));
    } catch {
        return fallback;
    }
}

async function fetchAllMessages(channel, limit = MESSAGES_PER_CHANNEL) {
    const messages = [];
    let before = null;
    while (messages.length < limit) {
        const batch = await channel.messages.fetch({ limit: Math.min(100, limit - messages.length), ...(before ? { before } : {}) }).catch(() => null);
        if (!batch || batch.size === 0) break;
        for (const m of batch.values()) {
            messages.push({
                id: m.id,
                author: { id: m.author.id, username: m.author.username, bot: m.author.bot },
                content: m.content,
                createdAt: m.createdAt.toISOString(),
                editedAt: m.editedAt?.toISOString() ?? null,
                pinned: m.pinned,
                type: m.type,
                attachments: [...m.attachments.values()].map(a => ({ id: a.id, name: a.name, url: a.url, size: a.size })),
                embeds: m.embeds.length,
                reactions: [...m.reactions.cache.values()].map(r => ({ emoji: r.emoji.toString(), count: r.count })),
                referencedMessageId: m.reference?.messageId ?? null,
            });
        }
        before = batch.last()?.id;
        if (batch.size < 100) break;
        // Small pause to respect rate limits
        await new Promise(r => setTimeout(r, 250));
    }
    return messages;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function insertSection(pool, backupId, section, data) {
    const serialized = JSON.stringify(data);
    const dataHash = crypto.createHash('sha256').update(serialized).digest('hex');
    await pool.execute(
        'INSERT INTO discord_backup_sections (backup_id, section, data, data_hash) VALUES (?, ?, ?, ?)',
        [backupId, section, serialized, dataHash]
    );
}

async function getBackupMetaRow(pool, backupId) {
    const [[row]] = await pool.execute(
        'SELECT id, guild_id, parent_backup_id, backup_mode FROM discord_backups WHERE id = ?',
        [backupId]
    );
    return row || null;
}

async function getBackupChain(pool, backupId, maxDepth = 30) {
    const chain = [];
    let currentId = Number(backupId || 0);
    let depth = 0;
    while (currentId > 0 && depth < maxDepth) {
        const row = await getBackupMetaRow(pool, currentId);
        if (!row) break;
        chain.push(row);
        currentId = Number(row.parent_backup_id || 0);
        depth += 1;
    }
    return chain.reverse();
}

async function getSection(pool, backupId, section) {
    const chain = await getBackupChain(pool, backupId, 40);
    if (!chain.length) return null;
    for (let i = chain.length - 1; i >= 0; i--) {
        const [rows] = await pool.execute(
            'SELECT data FROM discord_backup_sections WHERE backup_id = ? AND section = ? LIMIT 1',
            [chain[i].id, section]
        );
        if (!rows.length) continue;
        try { return JSON.parse(rows[0].data); } catch { return null; }
    }
    return null;
}

async function getResolvedSections(pool, backupId) {
    const chain = await getBackupChain(pool, backupId, 40);
    const merged = {};
    for (const row of chain) {
        const [sections] = await pool.execute(
            'SELECT section, data FROM discord_backup_sections WHERE backup_id = ?',
            [row.id]
        );
        for (const s of sections) {
            try {
                merged[s.section] = JSON.parse(s.data);
            } catch {
                merged[s.section] = null;
            }
        }
    }
    return merged;
}

async function updateJobProgress(pool, table, jobId, phase, current, total) {
    await pool.execute(
        `UPDATE ${table} SET phase = ?, progress_current = ?, progress_total = ? WHERE id = ?`,
        [phase, current, total, jobId]
    ).catch(() => {});
}

async function appendJobLog(pool, table, jobId, line, logLines) {
    logLines.push('[' + new Date().toISOString() + '] ' + line);
    await pool.execute(`UPDATE ${table} SET log = ? WHERE id = ?`, [logLines.join('\n'), jobId]).catch(() => {});
}

async function createBackupJob(guildId) {
    const pool = getPool();
    const [row] = await pool.execute(
        'INSERT INTO discord_backup_jobs (guild_id, status, phase, progress_current, progress_total, log, started_at) VALUES (?,?,?,?,?,?,?)',
        [guildId, 'running', 'Start', 0, 0, '', Date.now()]
    );
    return row.insertId;
}

async function getBackupJob(jobId) {
    const pool = getPool();
    const [[row]] = await pool.execute('SELECT * FROM discord_backup_jobs WHERE id = ?', [jobId]);
    if (!row) return null;
    return {
        id: row.id,
        guildId: row.guild_id,
        status: row.status,
        phase: row.phase || null,
        progressCurrent: row.progress_current || 0,
        progressTotal: row.progress_total || 0,
        log: row.log || '',
        result: typeof row.result === 'string' ? JSON.parse(row.result) : (row.result ?? null),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
    };
}

async function getLatestRunningBackupJob(guildId) {
    const pool = getPool();
    const [[row]] = await pool.execute(
        "SELECT * FROM discord_backup_jobs WHERE guild_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
        [String(guildId)]
    );
    if (!row) return null;
    return {
        id: row.id,
        guildId: row.guild_id,
        status: row.status,
        phase: row.phase || null,
        progressCurrent: row.progress_current || 0,
        progressTotal: row.progress_total || 0,
        log: row.log || '',
        result: typeof row.result === 'string' ? JSON.parse(row.result) : (row.result ?? null),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
    };
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Create a full server backup stored in MySQL.
 * Returns the new backup record.
 */
async function createServerBackup(guild, botConfig = null, createdBy = null, existingJobId = null, runOptions = {}) {
    const pool = getPool();
    const now = Date.now();
    const backupMode = String(runOptions?.mode || 'full').toLowerCase() === 'incremental' ? 'incremental' : 'full';
    const jobId = existingJobId || await createBackupJob(guild.id);
    const logLines = [];
    // Always start with a clean log so stale entries from previous runs are gone
    await pool.execute('UPDATE discord_backup_jobs SET log=?, phase=?, progress_current=0, progress_total=0 WHERE id=?', ['', 'Start', jobId]).catch(() => {});
    const stepsTotal = 16;
    let step = 0;
    const mark = async (phase) => {
        step += 1;
        await updateJobProgress(pool, 'discord_backup_jobs', jobId, phase, step, stepsTotal);
        await appendJobLog(pool, 'discord_backup_jobs', jobId, phase, logLines);
    };

    try {
        await mark('Lese Server-Einstellungen');

    // ── 1. Settings ──────────────────────────────────────────────────────────
    const settings = {
        id: guild.id,
        name: guild.name,
        description: guild.description ?? null,
        icon: guild.iconURL({ size: 256 }) ?? null,
        banner: guild.bannerURL({ size: 1024 }) ?? null,
        splash: guild.splashURL({ size: 1024 }) ?? null,
        verificationLevel: guild.verificationLevel,
        explicitContentFilter: guild.explicitContentFilter,
        defaultMessageNotifications: guild.defaultMessageNotifications,
        premiumTier: guild.premiumTier,
        premiumSubscriptionCount: guild.premiumSubscriptionCount,
        memberCount: guild.memberCount,
        ownerId: guild.ownerId,
        preferredLocale: guild.preferredLocale,
        systemChannelId: guild.systemChannelId ?? null,
        afkChannelId: guild.afkChannelId ?? null,
        afkTimeout: guild.afkTimeout,
        rulesChannelId: guild.rulesChannelId ?? null,
        publicUpdatesChannelId: guild.publicUpdatesChannelId ?? null,
        features: [...(guild.features ?? [])],
        vanityURLCode: guild.vanityURLCode ?? null,
        nsfwLevel: guild.nsfwLevel,
        mfaLevel: guild.mfaLevel,
    };

    // ── 2. Roles ─────────────────────────────────────────────────────────────
    await mark('Sichere Rollen');
    const roles = [...guild.roles.cache.values()]
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => ({
            id: r.id,
            name: r.name,
            color: r.color,
            colorHex: r.hexColor,
            permissions: r.permissions.bitfield.toString(),
            position: r.position,
            hoist: r.hoist,
            mentionable: r.mentionable,
            managed: r.managed,
            icon: r.iconURL() ?? null,
            unicodeEmoji: r.unicodeEmoji ?? null,
        }));

    // ── 3. Channels ───────────────────────────────────────────────────────────
    await mark('Sichere Channels');
    const channels = [...guild.channels.cache.values()]
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
        .map(ch => ({
            id: ch.id,
            name: ch.name,
            type: ch.type,
            position: ch.rawPosition ?? 0,
            parentId: ch.parentId ?? null,
            topic: ch.topic ?? null,
            nsfw: ch.nsfw ?? false,
            bitrate: ch.bitrate ?? null,
            userLimit: ch.userLimit ?? null,
            rateLimitPerUser: ch.rateLimitPerUser ?? null,
            defaultAutoArchiveDuration: ch.defaultAutoArchiveDuration ?? null,
            permissionOverwrites: [...(ch.permissionOverwrites?.cache?.values() ?? [])].map(o => ({
                id: o.id,
                type: o.type,
                allow: o.allow.bitfield.toString(),
                deny: o.deny.bitfield.toString(),
            })),
        }));

    // ── 4. Emojis ─────────────────────────────────────────────────────────────
    await mark('Sichere Emojis');
    const emojis = [...guild.emojis.cache.values()].map(e => ({
        id: e.id,
        name: e.name,
        animated: e.animated,
        url: e.url,
        available: e.available,
        managed: e.managed,
        requireColons: e.requireColons,
    }));

    // ── 5. Stickers ───────────────────────────────────────────────────────────
    await mark('Sichere Sticker');
    let stickers = [];
    try {
        const fetched = await guild.stickers.fetch();
        stickers = [...fetched.values()].map(s => ({
            id: s.id,
            name: s.name,
            description: s.description,
            tags: s.tags,
            type: s.type,
            format: s.format,
            url: s.url,
            available: s.available,
        }));
    } catch (_) {}

    // ── 6. Bans ───────────────────────────────────────────────────────────────
    await mark('Sichere Bans');
    let bans = [];
    try {
        const banList = await guild.bans.fetch();
        bans = [...banList.values()].map(b => ({
            userId: b.user.id,
            username: b.user.username,
            reason: b.reason ?? null,
        }));
    } catch (_) {}

    // ── 7. Invites ────────────────────────────────────────────────────────────
    await mark('Sichere Invites');
    let invites = [];
    try {
        const inviteList = await guild.invites.fetch();
        invites = [...inviteList.values()].map(i => ({
            code: i.code,
            channelId: i.channelId,
            inviterId: i.inviterId,
            uses: i.uses,
            maxUses: i.maxUses,
            maxAge: i.maxAge,
            temporary: i.temporary,
            expiresAt: i.expiresAt?.toISOString() ?? null,
        }));
    } catch (_) {}

    // ── 8. Webhooks ───────────────────────────────────────────────────────────
    await mark('Sichere Webhooks');
    let webhooks = [];
    try {
        const webhookList = await guild.fetchWebhooks();
        webhooks = [...webhookList.values()].map(w => ({
            id: w.id,
            name: w.name,
            channelId: w.channelId,
            type: w.type,
            avatar: w.avatarURL() ?? null,
            applicationId: w.applicationId ?? null,
        }));
    } catch (_) {}

    // ── 9. AutoMod Rules ──────────────────────────────────────────────────────
    await mark('Sichere AutoMod-Regeln');
    let automodRules = [];
    try {
        const rules = await guild.autoModerationRules.fetch();
        automodRules = [...rules.values()].map(r => ({
            id: r.id,
            name: r.name,
            enabled: r.enabled,
            eventType: r.eventType,
            triggerType: r.triggerType,
            triggerMetadata: r.triggerMetadata,
            actions: r.actions,
            exemptRoles: [...r.exemptRoles.keys()],
            exemptChannels: [...r.exemptChannels.keys()],
        }));
    } catch (_) {}

    // ── 10. Scheduled Events ──────────────────────────────────────────────────
    await mark('Sichere Scheduled Events');
    let scheduledEvents = [];
    try {
        const events = await guild.scheduledEvents.fetch();
        scheduledEvents = [...events.values()].map(e => ({
            id: e.id,
            name: e.name,
            description: e.description ?? null,
            channelId: e.channelId ?? null,
            entityType: e.entityType,
            status: e.status,
            scheduledStartAt: e.scheduledStartAt?.toISOString() ?? null,
            scheduledEndAt: e.scheduledEndAt?.toISOString() ?? null,
            userCount: e.userCount ?? null,
            location: e.entityMetadata?.location ?? null,
        }));
    } catch (_) {}

    // ── 11. Active Threads ────────────────────────────────────────────────────
    await mark('Sichere Threads');
    let threads = [];
    try {
        const threadsFetched = await guild.channels.fetchActiveThreads();
        threads = [...threadsFetched.threads.values()].map(t => ({
            id: t.id,
            name: t.name,
            parentId: t.parentId,
            archived: t.archived,
            locked: t.locked,
            type: t.type,
            memberCount: t.memberCount,
            messageCount: t.messageCount,
            archiveTimestamp: t.archiveTimestamp?.toISOString() ?? null,
        }));
    } catch (_) {}

    // ── 12. Audit Log (last 100) ──────────────────────────────────────────────
    await mark('Sichere Audit-Log');
    let auditLog = [];
    try {
        const log = await guild.fetchAuditLogs({ limit: 100 });
        auditLog = [...log.entries.values()].map(e => ({
            id: e.id,
            action: e.action,
            executorId: e.executorId,
            targetId: e.targetId ?? null,
            reason: e.reason ?? null,
            createdAt: e.createdAt.toISOString(),
            changes: e.changes ?? [],
        }));
    } catch (_) {}

    // ── 13. Messages (1000 per text channel) ──────────────────────────────────
    await mark('Sichere Nachrichten');
    const messagesByChannel = {};
    const textChannels = [...guild.channels.cache.values()].filter(
        ch => ch.isTextBased() && !ch.isThread() && ch.viewable
    );
    for (const ch of textChannels) {
        try {
            messagesByChannel[ch.id] = await fetchAllMessages(ch, MESSAGES_PER_CHANNEL);
        } catch (_) {
            messagesByChannel[ch.id] = [];
        }
    }
    const totalMessages = Object.values(messagesByChannel).reduce((s, a) => s + a.length, 0);

    // ── Build stats ───────────────────────────────────────────────────────────
    await mark('Berechne Statistiken');
    const stats = {
        roles: roles.length,
        channels: channels.length,
        emojis: emojis.length,
        stickers: stickers.length,
        bans: bans.length,
        invites: invites.length,
        webhooks: webhooks.length,
        automodRules: automodRules.length,
        scheduledEvents: scheduledEvents.length,
        threads: threads.length,
        auditLogEntries: auditLog.length,
        messages: totalMessages,
    };

    const sectionPayload = {
        settings,
        roles,
        channels,
        emojis,
        stickers,
        bans,
        invites,
        webhooks,
        automodRules,
        scheduledEvents,
        threads,
        auditLog,
        messages: messagesByChannel,
        botConfig,
    };
    const sectionNames = Object.keys(sectionPayload);

    // ── Write to DB ───────────────────────────────────────────────────────────
    await mark('Speichere Backup-Metadaten');
    let parentBackupId = null;
    if (backupMode === 'incremental') {
        const [[latest]] = await pool.execute(
            'SELECT id FROM discord_backups WHERE guild_id = ? ORDER BY created_at DESC LIMIT 1',
            [guild.id]
        );
        parentBackupId = latest ? Number(latest.id) : null;
    }

    const [result] = await pool.execute(
        'INSERT INTO discord_backups (guild_id, name, created_by, created_at, stats, backup_mode, parent_backup_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [guild.id, guild.name, createdBy, now, JSON.stringify(stats), backupMode, parentBackupId]
    );
    const backupId = result.insertId;

    // Write sections in parallel batches
    await mark('Speichere Backup-Sektionen');
    let changedSections = sectionNames;
    if (backupMode === 'incremental' && parentBackupId) {
        const detected = [];
        for (const section of sectionNames) {
            const currentData = sectionPayload[section];
            const prevData = await getSection(pool, parentBackupId, section);
            const currentHash = crypto.createHash('sha256').update(JSON.stringify(currentData)).digest('hex');
            const prevHash = crypto.createHash('sha256').update(JSON.stringify(prevData)).digest('hex');
            if (currentHash !== prevHash) detected.push(section);
        }
        changedSections = detected;
    }
    await Promise.all(changedSections.map(section => insertSection(pool, backupId, section, sectionPayload[section])));
    await appendJobLog(pool, 'discord_backup_jobs', jobId, 'Modus=' + backupMode + ' · Geänderte Sektionen=' + changedSections.length + '/' + sectionNames.length, logLines);

    // ── Rotate: keep only configured number of backups ────────────────────────
    await mark('Bereinige alte Backups');
    const maxBackups = Math.max(1, Number(runOptions?.maxBackups) || MAX_BACKUPS_PER_GUILD);
    const [all] = await pool.execute(
        'SELECT id, parent_backup_id FROM discord_backups WHERE guild_id = ? ORDER BY created_at ASC',
        [guild.id]
    );
    if (all.length > maxBackups) {
        // getSection() resolves an incremental backup's unchanged sections by
        // walking parent_backup_id back through the chain (see getBackupChain
        // above). Naively deleting the N oldest rows can delete a full/base
        // backup that a surviving incremental backup still depends on —
        // getBackupChain() then silently stops early (`if (!row) break`) and
        // the restore permanently loses every section that hadn't changed
        // since that missing ancestor. Instead: keep the newest maxBackups
        // rows, then walk each kept row's ancestor chain and protect every
        // backup still referenced along the way, however old it is. Only
        // truly-unreferenced backups are deleted. A chain a scheduler keeps
        // extending incrementally forever won't shrink until a fresh full
        // backup resets it — that's a storage tradeoff, not a data-loss bug.
        const byId = new Map(all.map(r => [Number(r.id), r]));
        const kept = all.slice(all.length - maxBackups);
        const protectedIds = new Set(kept.map(r => Number(r.id)));
        for (const row of kept) {
            let cur = byId.get(Number(row.id));
            let depth = 0;
            while (cur && cur.parent_backup_id && depth < 40) {
                const parentId = Number(cur.parent_backup_id);
                protectedIds.add(parentId);
                cur = byId.get(parentId);
                depth += 1;
            }
        }
        const toDelete = all.filter(r => !protectedIds.has(Number(r.id))).map(r => r.id);
        for (const oldId of toDelete) {
            await pool.execute('DELETE FROM discord_backup_sections WHERE backup_id = ?', [oldId]);
            await pool.execute('DELETE FROM discord_backups WHERE id = ?', [oldId]);
        }
    }

    await updateJobProgress(pool, 'discord_backup_jobs', jobId, 'Fertig', stepsTotal, stepsTotal);
    await appendJobLog(pool, 'discord_backup_jobs', jobId, 'Backup fertig', logLines);
    await pool.execute(
        'UPDATE discord_backup_jobs SET status = ?, result = ?, finished_at = ? WHERE id = ?',
        ['done', JSON.stringify({ backupId, guildId: guild.id, guildName: guild.name, stats, createdAt: now, backupMode, parentBackupId, changedSections }), Date.now(), jobId]
    );

    return { backupId, guildId: guild.id, guildName: guild.name, stats, createdAt: now, jobId, backupMode, parentBackupId, changedSections };
    } catch (e) {
        await appendJobLog(pool, 'discord_backup_jobs', jobId, 'FEHLER: ' + e.message, logLines);
        await pool.execute(
            'UPDATE discord_backup_jobs SET status = ?, phase = ?, result = ?, finished_at = ? WHERE id = ?',
            ['failed', 'Fehlgeschlagen', JSON.stringify({ error: e.message }), Date.now(), jobId]
        ).catch(() => {});
        throw e;
    }
}

/**
 * List all backups for a guild, newest first.
 */
async function listGuildBackups(guildId) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT id, guild_id, name, created_by, created_at, stats, backup_mode, parent_backup_id FROM discord_backups WHERE guild_id = ? ORDER BY created_at DESC',
        [String(guildId)]
    );
    return rows.map(r => ({
        id: r.id,
        guildId: r.guild_id,
        name: r.name,
        createdBy: r.created_by,
        createdAt: r.created_at,
        backupMode: r.backup_mode || 'full',
        parentBackupId: r.parent_backup_id || null,
        stats: typeof r.stats === 'string' ? JSON.parse(r.stats) : (r.stats ?? {}),
    }));
}

/**
 * Get a full backup (all sections) by ID. Returns null if not found or wrong guild.
 */
async function getBackupById(backupId, guildId) {
    const pool = getPool();
    const [[meta]] = await pool.execute(
        'SELECT * FROM discord_backups WHERE id = ? AND guild_id = ?',
        [backupId, String(guildId)]
    );
    if (!meta) return null;

    const sections = await getResolvedSections(pool, backupId);

    const result = {
        meta: {
            id: meta.id,
            guildId: meta.guild_id,
            name: meta.name,
            createdBy: meta.created_by,
            createdAt: meta.created_at,
            backupMode: meta.backup_mode || 'full',
            parentBackupId: meta.parent_backup_id || null,
            stats: typeof meta.stats === 'string' ? JSON.parse(meta.stats) : (meta.stats ?? {}),
        },
    };
    for (const [section, data] of Object.entries(sections)) {
        result[section] = data;
    }
    return result;
}

async function getBackupMetaById(backupId) {
    const pool = getPool();
    const [[meta]] = await pool.execute('SELECT id, guild_id, name, created_by, created_at, backup_mode, parent_backup_id FROM discord_backups WHERE id = ?', [backupId]);
    if (!meta) return null;
    return {
        id: meta.id,
        guildId: String(meta.guild_id),
        name: meta.name,
        createdBy: meta.created_by,
        createdAt: meta.created_at,
        backupMode: meta.backup_mode || 'full',
        parentBackupId: meta.parent_backup_id || null,
    };
}

async function getRestorePreview(targetGuild, backupId, options = {}) {
    const pool = getPool();
    const sourceGuildId = String(options.sourceGuildId || '').trim() || null;
    const [metaRows] = sourceGuildId
        ? await pool.execute('SELECT id, guild_id, name FROM discord_backups WHERE id = ? AND guild_id = ?', [backupId, sourceGuildId])
        : await pool.execute('SELECT id, guild_id, name FROM discord_backups WHERE id = ?', [backupId]);
    const meta = metaRows[0] || null;
    if (!meta) throw new Error('Backup not found');

    const doSettings = options.settings === true || options.settings === 'true';
    const doRoles = options.roles !== false && options.roles !== 'false';
    const doChannels = options.channels !== false && options.channels !== 'false';
    const doEmojis = options.emojis === true || options.emojis === 'true';
    const doMessages = options.messages !== false && options.messages !== 'false';
    const doWipe = options.wipeExisting === true || options.wipeExisting === 'true';

    const [roles, channels, emojis, messagesByChannel] = await Promise.all([
        getSection(pool, backupId, 'roles'),
        getSection(pool, backupId, 'channels'),
        getSection(pool, backupId, 'emojis'),
        getSection(pool, backupId, 'messages'),
    ]);

    const backupRoles = Array.isArray(roles) ? roles : [];
    const backupChannels = Array.isArray(channels) ? channels : [];
    const backupEmojis = Array.isArray(emojis) ? emojis : [];
    const backupMessages = messagesByChannel && typeof messagesByChannel === 'object' ? messagesByChannel : {};

    const totalMessages = Object.values(backupMessages).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
    const managedRoles = backupRoles.filter(r => r?.managed).length;
    const creatableRoles = backupRoles.length - managedRoles;

    const me = targetGuild.members.me;
    const botTopPos = me?.roles?.highest?.position ?? 0;
    const canManageRoles = !!me?.permissions?.has(PermissionsBitField.Flags.ManageRoles);
    const canManageChannels = !!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels);
    const canManageEmojis = !!me?.permissions?.has(PermissionsBitField.Flags.ManageGuildExpressions);

    const existingChannels = [...targetGuild.channels.cache.values()].filter(ch => !ch.isThread?.()).length;
    const existingEmojis = targetGuild.emojis.cache.size;
    const existingRoles = [...targetGuild.roles.cache.values()].filter(r => r.id !== targetGuild.id).length;
    const deletableRoles = [...targetGuild.roles.cache.values()].filter(r => r.id !== targetGuild.id && !r.managed && r.position < botTopPos).length;

    const warnings = [];
    if (doRoles && !canManageRoles) warnings.push('Bot hat kein Manage Roles im Zielserver.');
    if (doChannels && !canManageChannels) warnings.push('Bot hat kein Manage Channels im Zielserver.');
    if (doEmojis && !canManageEmojis) warnings.push('Bot hat kein Manage Expressions im Zielserver.');
    if (doRoles && managedRoles > 0) warnings.push(managedRoles + ' managed Rollen aus dem Backup werden übersprungen.');
    if (doWipe && doRoles && deletableRoles < existingRoles) warnings.push('Nicht alle vorhandenen Rollen sind löschbar (Bot-Hierarchie).');

    return {
        backup: {
            id: Number(meta.id),
            guildId: String(meta.guild_id),
            name: meta.name,
        },
        target: {
            guildId: String(targetGuild.id),
            name: targetGuild.name,
            existing: {
                roles: existingRoles,
                channels: existingChannels,
                emojis: existingEmojis,
            },
        },
        options: { doSettings, doRoles, doChannels, doEmojis, doMessages, doWipe },
        plan: {
            settings: doSettings ? 1 : 0,
            rolesTotal: doRoles ? backupRoles.length : 0,
            rolesCreatable: doRoles ? creatableRoles : 0,
            channelsTotal: doChannels ? backupChannels.length : 0,
            emojisTotal: doEmojis ? backupEmojis.length : 0,
            messagesTotal: doMessages ? totalMessages : 0,
            wipe: doWipe
                ? {
                    channels: existingChannels,
                    emojis: existingEmojis,
                    roles: deletableRoles,
                }
                : null,
        },
        warnings,
    };
}

async function getBackupSchedule(guildId) {
    const pool = getPool();
    const [[row]] = await pool.execute('SELECT * FROM discord_backup_schedules WHERE guild_id = ?', [String(guildId)]);
    if (!row) {
        return {
            guildId: String(guildId),
            enabled: false,
            intervalHours: 24,
            retentionCount: MAX_BACKUPS_PER_GUILD,
            backupMode: 'full',
            nextRunAt: null,
            lastRunAt: null,
            lastJobId: null,
            createdBy: null,
            updatedAt: null,
        };
    }
    return {
        guildId: row.guild_id,
        enabled: !!row.enabled,
        intervalHours: Number(row.interval_hours || 24),
        retentionCount: Number(row.retention_count || MAX_BACKUPS_PER_GUILD),
        backupMode: (row.backup_mode === 'incremental') ? 'incremental' : 'full',
        nextRunAt: row.next_run_at || null,
        lastRunAt: row.last_run_at || null,
        lastJobId: row.last_job_id || null,
        createdBy: row.created_by || null,
        updatedAt: row.updated_at || null,
    };
}

async function upsertBackupSchedule(guildId, schedule = {}, updatedBy = null) {
    const pool = getPool();
    const now = Date.now();
    const enabled = schedule.enabled === true || schedule.enabled === 'true';
    const intervalHours = Math.max(1, Math.min(24 * 30, Number(schedule.intervalHours || 24)));
    const retentionCount = Math.max(1, Math.min(200, Number(schedule.retentionCount || MAX_BACKUPS_PER_GUILD)));
    const backupMode = String(schedule.backupMode || 'full').toLowerCase() === 'incremental' ? 'incremental' : 'full';
    const nextRunAt = enabled ? (now + intervalHours * 3600 * 1000) : null;

    await pool.execute(
        `INSERT INTO discord_backup_schedules (guild_id, enabled, interval_hours, retention_count, backup_mode, next_run_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
             enabled = VALUES(enabled),
             interval_hours = VALUES(interval_hours),
             retention_count = VALUES(retention_count),
             backup_mode = VALUES(backup_mode),
             next_run_at = VALUES(next_run_at),
             updated_at = VALUES(updated_at),
             created_by = COALESCE(created_by, VALUES(created_by))`,
        [String(guildId), enabled ? 1 : 0, intervalHours, retentionCount, backupMode, nextRunAt, updatedBy, now]
    );

    return getBackupSchedule(guildId);
}

async function listDueBackupSchedules(now = Date.now(), limit = 20) {
    const pool = getPool();
    const [rows] = await pool.execute(
        'SELECT guild_id, enabled, interval_hours, retention_count, backup_mode, next_run_at FROM discord_backup_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?',
        [now, Math.max(1, Math.min(100, Number(limit) || 20))]
    );
    return rows.map(r => ({
        guildId: String(r.guild_id),
        enabled: !!r.enabled,
        intervalHours: Number(r.interval_hours || 24),
        retentionCount: Number(r.retention_count || MAX_BACKUPS_PER_GUILD),
        backupMode: (r.backup_mode === 'incremental') ? 'incremental' : 'full',
        nextRunAt: Number(r.next_run_at || 0),
    }));
}

async function markBackupScheduleRun(guildId, jobId, ok, intervalHours) {
    const pool = getPool();
    const now = Date.now();
    const fallbackHours = Math.max(1, Number(intervalHours || 24));
    const next = now + fallbackHours * 3600 * 1000;
    await pool.execute(
        'UPDATE discord_backup_schedules SET last_run_at = ?, last_job_id = ?, next_run_at = ?, updated_at = ? WHERE guild_id = ?',
        [now, jobId || null, next, now, String(guildId)]
    );
    return !!ok;
}

async function processScheduledBackups(client, getGuildConfig, logger = null) {
    const due = await listDueBackupSchedules(Date.now(), 10);
    if (!due.length) return { processed: 0, started: 0, failed: 0 };

    let started = 0;
    let failed = 0;

    for (const s of due) {
        const guild = client.guilds.cache.get(String(s.guildId));
        if (!guild) {
            failed += 1;
            await markBackupScheduleRun(s.guildId, null, false, s.intervalHours);
            continue;
        }

        try {
            const botConfig = typeof getGuildConfig === 'function' ? getGuildConfig(guild.id) : null;
            const jobId = await createBackupJob(guild.id);
            started += 1;
            createServerBackup(guild, botConfig, 'scheduler', jobId, { maxBackups: s.retentionCount, mode: s.backupMode }).then(() => {
                markBackupScheduleRun(guild.id, jobId, true, s.intervalHours).catch(() => {});
            }).catch((err) => {
                failed += 1;
                markBackupScheduleRun(guild.id, jobId, false, s.intervalHours).catch(() => {});
                if (logger?.error) logger.error('[ServerBackup] Scheduled backup failed for guild ' + guild.id + ':', err);
            });
        } catch (err) {
            failed += 1;
            await markBackupScheduleRun(s.guildId, null, false, s.intervalHours);
            if (logger?.error) logger.error('[ServerBackup] Scheduled backup start failed for guild ' + s.guildId + ':', err);
        }
    }

    return { processed: due.length, started, failed };
}

async function verifyRestoreOutcome(targetGuild, backupId, options = {}) {
    const pool = getPool();
    const sourceGuildId = String(options.sourceGuildId || '').trim() || null;
    const backup = await (sourceGuildId ? getBackupById(backupId, sourceGuildId) : (async () => {
        const m = await getBackupMetaById(backupId);
        if (!m) return null;
        return getBackupById(backupId, m.guildId);
    })());
    if (!backup) throw new Error('Backup not found');

    const backupRoles = Array.isArray(backup.roles) ? backup.roles.filter(r => !r?.managed) : [];
    const backupChannels = Array.isArray(backup.channels) ? backup.channels : [];
    const backupEmojis = Array.isArray(backup.emojis) ? backup.emojis : [];
    const backupMessages = backup.messages && typeof backup.messages === 'object'
        ? Object.values(backup.messages).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0)
        : 0;

    const targetRoles = [...targetGuild.roles.cache.values()].filter(r => r.id !== targetGuild.id && !r.managed).length;
    const targetChannels = [...targetGuild.channels.cache.values()].filter(ch => !ch.isThread?.()).length;
    const targetEmojis = targetGuild.emojis.cache.size;

    const roleCoverage = backupRoles.length > 0 ? Math.min(100, Math.round((targetRoles / backupRoles.length) * 100)) : 100;
    const channelCoverage = backupChannels.length > 0 ? Math.min(100, Math.round((targetChannels / backupChannels.length) * 100)) : 100;
    const emojiCoverage = backupEmojis.length > 0 ? Math.min(100, Math.round((targetEmojis / backupEmojis.length) * 100)) : 100;
    const overallScore = Math.round((roleCoverage + channelCoverage + emojiCoverage) / 3);

    return {
        backupId: Number(backupId),
        targetGuildId: String(targetGuild.id),
        counts: {
            backup: { roles: backupRoles.length, channels: backupChannels.length, emojis: backupEmojis.length, messages: backupMessages },
            target: { roles: targetRoles, channels: targetChannels, emojis: targetEmojis },
        },
        coverage: {
            roles: roleCoverage,
            channels: channelCoverage,
            emojis: emojiCoverage,
            overall: overallScore,
        },
        verdict: overallScore >= 90 ? 'good' : (overallScore >= 70 ? 'partial' : 'poor'),
    };
}

/**
 * Delete a backup by ID (verifies guildId ownership).
 */
async function deleteBackup(backupId, guildId) {
    const pool = getPool();
    const [[meta]] = await pool.execute(
        'SELECT id FROM discord_backups WHERE id = ? AND guild_id = ?',
        [backupId, String(guildId)]
    );
    if (!meta) return false;
    await pool.execute('DELETE FROM discord_backup_sections WHERE backup_id = ?', [backupId]);
    await pool.execute('DELETE FROM discord_backups WHERE id = ?', [backupId]);
    return true;
}

async function createRestoreJob(backupId, targetGuildId) {
    const pool = getPool();
    const [row] = await pool.execute(
        'INSERT INTO discord_restore_jobs (backup_id, target_guild_id, status, phase, progress_current, progress_total, log, started_at) VALUES (?,?,?,?,?,?,?,?)',
        [backupId, targetGuildId, 'running', 'Start', 0, 0, '', Date.now()]
    );
    return row.insertId;
}

/**
 * Restore a backup onto a target guild.
 * options: { settings, roles, channels, emojis } — all default true except settings/emojis.
 * Runs async (fire-and-forget safe). Returns result stats.
 */
async function restoreServerBackup(targetGuild, backupId, options = {}, existingJobId = null) {
    // Normalize options - accept boolean or string values (PHP JSON sends true/false booleans)
    const doSettings = options.settings === true || options.settings === 'true';
    const doRoles    = options.roles    !== false && options.roles    !== 'false';
    const doChannels = options.channels !== false && options.channels !== 'false';
    const doEmojis   = options.emojis   === true  || options.emojis   === 'true';
    const doMessages = options.messages !== false && options.messages !== 'false';
    const doWipe     = options.wipeExisting === true || options.wipeExisting === 'true';
    const doAutoVerify = options.autoVerify !== false && options.autoVerify !== 'false';
    const messageMode = ['embed', 'webhook', 'plain'].includes(String(options.messageMode || '').toLowerCase())
        ? String(options.messageMode).toLowerCase()
        : 'embed';

    const pool = getPool();
    const sourceGuildId = String(options.sourceGuildId || '').trim() || null;
    const [metaRows] = sourceGuildId
        ? await pool.execute('SELECT id, guild_id FROM discord_backups WHERE id = ? AND guild_id = ?', [backupId, sourceGuildId])
        : await pool.execute('SELECT id, guild_id FROM discord_backups WHERE id = ?', [backupId]);
    const meta = metaRows[0] || null;
    if (!meta) throw new Error('Backup not found');
    const backupGuildId = String(meta.guild_id);

    const jobId = existingJobId || await createRestoreJob(backupId, targetGuild.id);

    const logLines = [];
    // Always start with a clean log so stale entries from previous runs are gone
    await pool.execute('UPDATE discord_restore_jobs SET log=?, phase=?, progress_current=0, progress_total=0 WHERE id=?', ['', 'Start', jobId]).catch(() => {});
    const addLog = async (line) => {
        logLines.push('[' + new Date().toISOString() + '] ' + line);
        await pool.execute('UPDATE discord_restore_jobs SET log = ? WHERE id = ?', [logLines.join('\n'), jobId]).catch(() => {});
    };

    const formatDuration = (ms) => {
        const safe = Math.max(0, Math.floor(Number(ms) || 0));
        const s = Math.floor(safe / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
        if (m > 0) return m + 'm ' + sec + 's';
        return sec + 's';
    };

    const createPhaseTracker = (label, total) => {
        const safeTotal = Math.max(0, Number(total) || 0);
        let processed = 0;
        let ok = 0;
        let skipped = 0;
        let failed = 0;
        let lastLogAt = 0;
        const startedAt = Date.now();

        const maybeLog = async (force = false) => {
            const now = Date.now();
            if (!force && now - lastLogAt < 1200 && processed < safeTotal) return;
            lastLogAt = now;
            const pct = safeTotal > 0 ? Math.round((processed / safeTotal) * 100) : 100;
            const elapsedMs = now - startedAt;
            const avgPerItem = processed > 0 ? (elapsedMs / processed) : 0;
            const etaMs = (safeTotal > processed && avgPerItem > 0) ? Math.round((safeTotal - processed) * avgPerItem) : 0;
            await addLog(
                'FORTSCHRITT ' + label + ': ' + processed + '/' + safeTotal + ' (' + pct + '%) | OK=' + ok +
                ' SKIP=' + skipped + ' FEHLER=' + failed + ' | elapsed=' + formatDuration(elapsedMs) +
                ' | ETA=' + formatDuration(etaMs)
            );
        };

        return {
            ok: async (count = 1) => {
                processed += count;
                ok += count;
                await maybeLog(false);
            },
            skip: async (count = 1) => {
                processed += count;
                skipped += count;
                await maybeLog(false);
            },
            fail: async (count = 1) => {
                processed += count;
                failed += count;
                await maybeLog(false);
            },
            flush: async () => {
                await maybeLog(true);
            },
            summary: () => {
                const pct = safeTotal > 0 ? Math.round((ok / safeTotal) * 100) : 100;
                return label + ' Erfolgsquote: ' + ok + '/' + safeTotal + ' (' + pct + '%), SKIP=' + skipped + ', FEHLER=' + failed;
            },
        };
    };

    const results = { roles: 0, channels: 0, emojis: 0, messages: 0, settings: false, wiped: false, errors: [] };
    const reason = 'Restored from backup #' + backupId;
    const stepsTotal = 2
        + (doWipe ? 1 : 0)
        + (doSettings ? 1 : 0)
        + (doRoles ? 1 : 0)
        + (doChannels ? 1 : 0)
        + (doMessages ? 1 : 0)
        + (doEmojis ? 1 : 0);
    let step = 0;
    const mark = async (phase) => {
        step += 1;
        await updateJobProgress(pool, 'discord_restore_jobs', jobId, phase, step, stepsTotal);
        await addLog(phase);
    };

    try {
        await mark('Restore gestartet: Backup #' + backupId + ' auf "' + targetGuild.name + '" (' + targetGuild.id + ')');
        await mark('Optionen geladen');
        await addLog('Rollen=' + doRoles + ' Channels=' + doChannels + ' Emojis=' + doEmojis + ' Messages=' + doMessages + ' Settings=' + doSettings + ' Wipe=' + doWipe + ' MessageMode=' + messageMode);

        const channelIdMap = {};
        const roleIdMap = { [backupGuildId]: targetGuild.id };

        if (doWipe) {
            await mark('Cleanup des Zielservers');
            try {
                const me = targetGuild.members.me;
                const botTopPos = me?.roles?.highest?.position ?? 0;

                // 1) Delete channels (non-category first, then categories)
                const allChannels = [...targetGuild.channels.cache.values()].filter(ch => !ch.isThread?.());
                const nonCategories = allChannels.filter(ch => ch.type !== 4);
                const categories = allChannels.filter(ch => ch.type === 4);
                let deletedChannels = 0;

                for (const ch of [...nonCategories, ...categories]) {
                    try {
                        await ch.delete('Cleanup before restore');
                        deletedChannels++;
                        await addLog('GELÖSCHT Channel: #' + (ch.name || ch.id) + ' (' + ch.id + ')');
                    } catch (e) {
                        results.errors.push('wipe channel "' + (ch.name || ch.id) + '": ' + e.message);
                        await addLog('FEHLER Löschen Channel #' + (ch.name || ch.id) + ': ' + e.message);
                    }
                }

                // 2) Delete custom emojis
                let deletedEmojis = 0;
                for (const emoji of targetGuild.emojis.cache.values()) {
                    try {
                        await emoji.delete('Cleanup before restore');
                        deletedEmojis++;
                        await addLog('GELÖSCHT Emoji: ' + (emoji.name || emoji.id) + ' (' + emoji.id + ')');
                    } catch (e) {
                        results.errors.push('wipe emoji "' + (emoji.name || emoji.id) + '": ' + e.message);
                        await addLog('FEHLER Löschen Emoji ' + (emoji.name || emoji.id) + ': ' + e.message);
                    }
                }

                // 3) Delete roles except @everyone, managed, and roles above bot
                let deletedRoles = 0;
                const deletableRoles = [...targetGuild.roles.cache.values()]
                    .filter(r => r.id !== targetGuild.id && !r.managed && r.position < botTopPos)
                    .sort((a, b) => a.position - b.position);
                for (const role of deletableRoles) {
                    try {
                        await runWithDiscordRateLimitWait(() => role.delete('Cleanup before restore'), addLog, 'Rollen-Cleanup "' + (role.name || role.id) + '"');
                        deletedRoles++;
                        await addLog('GELÖSCHT Rolle: ' + (role.name || role.id) + ' (' + role.id + ')');
                    } catch (e) {
                        results.errors.push('wipe role "' + (role.name || role.id) + '": ' + e.message);
                        await addLog('FEHLER Löschen Rolle ' + (role.name || role.id) + ': ' + e.message);
                    }
                }

                results.wiped = true;
                await addLog('OK Cleanup fertig: Channels=' + deletedChannels + ', Emojis=' + deletedEmojis + ', Rollen=' + deletedRoles);
                // Give Discord's API time to settle after mass-deletions before creating new objects
                await addLog('Warte 2s nach Cleanup...');
                await wait(2000);
            } catch (e) {
                results.errors.push('wipe: ' + e.message);
                await addLog('FEHLER Cleanup: ' + e.message);
            }
        }

        if (doSettings) {
            await mark('Settings-Restore');
            const s = await getSection(pool, backupId, 'settings');
            if (s) {
                try {
                    await targetGuild.edit({
                        verificationLevel: s.verificationLevel,
                        explicitContentFilter: s.explicitContentFilter,
                        defaultMessageNotifications: s.defaultMessageNotifications,
                        preferredLocale: s.preferredLocale,
                    });
                    results.settings = true;
                    await addLog('OK Settings wiederhergestellt');
                } catch (e) {
                    results.errors.push('settings: ' + e.message);
                    await addLog('FEHLER Settings: ' + e.message);
                }
            }
        }

        if (doRoles) {
            await mark('Rollen-Restore');
            const roles = await getSection(pool, backupId, 'roles');
            if (roles) {
                const botPermissions = targetGuild.members.me?.permissions?.bitfield ?? null;
                const sorted = [...roles].sort((a, b) => a.position - b.position);
                const roleTracker = createPhaseTracker('Rollen', sorted.length);
                await addLog('Rollen im Backup: ' + sorted.length);
                for (const role of sorted) {
                    if (!role || typeof role !== 'object') {
                        results.errors.push('role entry invalid: ' + JSON.stringify(role));
                        await addLog('SKIP Ungueltiger Rollen-Eintrag');
                        await roleTracker.skip(1);
                        continue;
                    }
                    if (role.managed) {
                        await addLog('SKIP Managed Rolle: ' + role.name + ' (' + role.id + ')');
                        await roleTracker.skip(1);
                        continue;
                    }
                    try {
                        // Gentle pacing prevents hitting Discord role route limits repeatedly.
                        await wait(900);
                        const rawPermissions = normalizeRolePermissions(role.permissions, 0n);
                        const safePermissions = botPermissions !== null
                            ? (rawPermissions & botPermissions)
                            : rawPermissions;

                        await addLog('Versuche Rolle: ' + role.name + ' (perm=' + safePermissions + ')');
                        const createdRole = await createRoleWithRetry(targetGuild, {
                            name: String(role.name || 'Restored Role').slice(0, 100),
                            color: Number(role.color || 0),
                            hoist: !!role.hoist,
                            mentionable: !!role.mentionable,
                            permissions: safePermissions,
                            reason,
                        }, 3, addLog);
                        roleIdMap[role.id] = createdRole.id;
                        results.roles++;
                        await addLog('ERSTELLT Rolle: ' + createdRole.name + ' (' + createdRole.id + ')');
                        await roleTracker.ok(1);
                        // Reduce burst failures and global rate-limit collisions on larger role sets.
                        await wait(350);
                    } catch (e) {
                        results.errors.push('role "' + role.name + '": ' + e.message);
                        await addLog('FEHLER Rolle "' + role.name + '": ' + e.message);
                        await roleTracker.fail(1);
                    }
                }
                await roleTracker.flush();
                await addLog(roleTracker.summary());
                await addLog('OK ' + results.roles + ' Rollen erstellt');
            } else {
                await addLog('WARN Keine Rollendaten im Backup');
            }
        }

        if (doChannels) {
            await mark('Channel-Restore');
            const channels = await getSection(pool, backupId, 'channels');
            if (channels) {
                const categoryIdMap = {};
                const channelTracker = createPhaseTracker('Channels', channels.length);

                const toOverwriteType = (value) => {
                    if (value === 0 || value === 'role') return 0;
                    if (value === 1 || value === 'member') return 1;
                    return value;
                };

                const mapOverwrites = async (sourceOverwrites, channelName) => {
                    const mapped = [];
                    for (const ow of (sourceOverwrites || [])) {
                        const type = toOverwriteType(ow.type);
                        let mappedId = null;
                        if (type === 0) {
                            mappedId = roleIdMap[ow.id] || null;
                        } else if (type === 1) {
                            const memberExists = await targetGuild.members.fetch(ow.id).then(() => true).catch(() => false);
                            mappedId = memberExists ? ow.id : null;
                        }
                        if (!mappedId) {
                            await addLog('SKIP Overwrite in "' + channelName + '": kein Mapping für ' + ow.id);
                            continue;
                        }
                        mapped.push({
                            id: mappedId,
                            type,
                            allow: BigInt(String(ow.allow || '0')),
                            deny: BigInt(String(ow.deny || '0')),
                        });
                    }
                    return mapped;
                };

                for (const ch of channels.filter(c => c.type === 4)) {
                    try {
                        const permissionOverwrites = await mapOverwrites(ch.permissionOverwrites, ch.name);
                        const cat = await runWithDiscordRateLimitWait(
                            () => targetGuild.channels.create({ name: ch.name, type: 4, reason, ...(permissionOverwrites.length ? { permissionOverwrites } : {}) }),
                            addLog,
                            'Kategorie "' + ch.name + '" erstellen'
                        );
                        categoryIdMap[ch.id] = cat.id;
                        channelIdMap[ch.id] = cat.id;
                        results.channels++;
                        await addLog('ERSTELLT Kategorie: ' + cat.name + ' (' + cat.id + ')');
                        await channelTracker.ok(1);
                    } catch (e) {
                        results.errors.push('category "' + ch.name + '": ' + e.message);
                        await addLog('FEHLER Kategorie "' + ch.name + '": ' + e.message);
                        await channelTracker.fail(1);
                    }
                }
                for (const ch of channels.filter(c => c.type !== 4)) {
                    try {
                        const opts = {
                            name: ch.name,
                            type: ch.type,
                            reason,
                            ...(ch.topic ? { topic: ch.topic } : {}),
                            ...(ch.nsfw ? { nsfw: ch.nsfw } : {}),
                            ...(ch.bitrate ? { bitrate: ch.bitrate } : {}),
                            ...(ch.userLimit ? { userLimit: ch.userLimit } : {}),
                            ...(ch.rateLimitPerUser ? { rateLimitPerUser: ch.rateLimitPerUser } : {}),
                            ...(ch.parentId && categoryIdMap[ch.parentId] ? { parent: categoryIdMap[ch.parentId] } : {}),
                        };
                        const permissionOverwrites = await mapOverwrites(ch.permissionOverwrites, ch.name);
                        if (permissionOverwrites.length) opts.permissionOverwrites = permissionOverwrites;
                        const created = await runWithDiscordRateLimitWait(
                            () => targetGuild.channels.create(opts),
                            addLog,
                            'Channel "' + ch.name + '" erstellen'
                        );
                        channelIdMap[ch.id] = created.id;
                        results.channels++;
                        await addLog('ERSTELLT Channel: #' + created.name + ' (' + created.id + ')');
                        await channelTracker.ok(1);
                    } catch (e) {
                        results.errors.push('channel "' + ch.name + '": ' + e.message);
                        await addLog('FEHLER Channel "' + ch.name + '": ' + e.message);
                        await channelTracker.fail(1);
                    }
                }
                await channelTracker.flush();
                await addLog(channelTracker.summary());
                await addLog('OK ' + results.channels + ' Channels erstellt');
            } else {
                await addLog('WARN Keine Channeldaten im Backup');
            }
        }

        if (doMessages) {
            await mark('Message-Restore (' + messageMode + ')');
            const messagesByChannel = await getSection(pool, backupId, 'messages');
            const channelsSection = await getSection(pool, backupId, 'channels');
            if (messagesByChannel && typeof messagesByChannel === 'object') {
                const totalMessagesPlanned = Object.values(messagesByChannel).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
                const messageTracker = createPhaseTracker('Nachrichten', totalMessagesPlanned);
                // If channels were not recreated in this run, try matching by channel name/type.
                if (!doChannels && Array.isArray(channelsSection)) {
                    const existing = [...targetGuild.channels.cache.values()];
                    for (const ch of channelsSection) {
                        const match = existing.find(ec => String(ec.type) === String(ch.type) && ec.name === ch.name);
                        if (match) channelIdMap[ch.id] = match.id;
                    }
                }

                for (const [oldChannelId, msgs] of Object.entries(messagesByChannel)) {
                    if (!Array.isArray(msgs) || msgs.length === 0) continue;
                    const newChannelId = channelIdMap[oldChannelId];
                    let targetChannel = newChannelId ? targetGuild.channels.cache.get(newChannelId) : null;
                    if (!targetChannel && newChannelId) {
                        targetChannel = await targetGuild.channels.fetch(newChannelId).catch(() => null);
                    }
                    if (!targetChannel || !targetChannel.isTextBased()) {
                        await addLog('WARN Kein Zielchannel für Nachrichten von ' + oldChannelId + ' gefunden');
                        await messageTracker.skip(Array.isArray(msgs) ? msgs.length : 0);
                        continue;
                    }

                    await addLog('Restore Nachrichten -> #' + targetChannel.name + ' (' + msgs.length + ')');
                    const ordered = [...msgs].reverse(); // oldest first
                    let sentInChannel = 0;
                    let webhook = null;
                    if (messageMode === 'webhook') {
                        try {
                            webhook = await runWithDiscordRateLimitWait(
                                () => targetChannel.createWebhook({ name: 'Backup Restore' }),
                                addLog,
                                'Webhook in #' + targetChannel.name + ' erstellen'
                            );
                        } catch (e) {
                            await addLog('WARN Webhook in #' + targetChannel.name + ' nicht möglich, fallback auf Embed: ' + e.message);
                        }
                    }
                    for (const m of ordered) {
                        try {
                            const author = m?.author?.username ? m.author.username : 'Unknown';
                            const baseContent = String(m?.content || '').trim();
                            const attachmentNote = Array.isArray(m?.attachments) && m.attachments.length
                                ? ' [attachments: ' + m.attachments.map(a => a.name || 'file').join(', ') + ']'
                                : '';
                            let text = (baseContent || '[no text]') + attachmentNote;
                            if (text.length > 3800) text = text.slice(0, 3797) + '...';

                            if (messageMode === 'plain') {
                                let plain = '**' + author + ':** ' + text;
                                if (plain.length > 1900) plain = plain.slice(0, 1897) + '...';
                                await runWithDiscordRateLimitWait(
                                    () => targetChannel.send({ content: plain, allowedMentions: { parse: [] } }),
                                    addLog,
                                    'Nachricht in #' + targetChannel.name + ' senden'
                                );
                            } else {
                                const embed = {
                                    author: { name: author },
                                    description: text || '[no text]',
                                    color: 0x5865F2,
                                    timestamp: m?.createdAt || undefined,
                                    footer: { text: 'Restored message' },
                                };
                                if (webhook) {
                                    await runWithDiscordRateLimitWait(
                                        () => webhook.send({ username: author, embeds: [embed], allowedMentions: { parse: [] } }),
                                        addLog,
                                        'Webhook-Nachricht in #' + targetChannel.name + ' senden'
                                    );
                                } else {
                                    await runWithDiscordRateLimitWait(
                                        () => targetChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }),
                                        addLog,
                                        'Embed-Nachricht in #' + targetChannel.name + ' senden'
                                    );
                                }
                            }
                            results.messages++;
                            sentInChannel++;
                            await messageTracker.ok(1);
                        } catch (e) {
                            results.errors.push('message channel ' + oldChannelId + ': ' + e.message);
                            await addLog('FEHLER Nachricht in #' + targetChannel.name + ': ' + e.message);
                            await messageTracker.fail(1);
                        }
                    }
                    if (webhook) {
                        await runWithDiscordRateLimitWait(
                            () => webhook.delete('Cleanup restore webhook'),
                            addLog,
                            'Restore-Webhook in #' + targetChannel.name + ' löschen'
                        ).catch(() => {});
                    }
                    await addLog('OK #' + targetChannel.name + ': ' + sentInChannel + '/' + ordered.length + ' Nachrichten gesendet');
                }
                await messageTracker.flush();
                await addLog(messageTracker.summary());
                await addLog('OK ' + results.messages + ' Nachrichten wiederhergestellt');
            } else {
                await addLog('WARN Keine Nachrichtendaten im Backup');
            }
        }

        if (doEmojis) {
            await mark('Emoji-Restore');
            const emojis = await getSection(pool, backupId, 'emojis');
            if (emojis) {
                const emojiTracker = createPhaseTracker('Emojis', emojis.length);
                for (const emoji of emojis) {
                    try {
                        const createdEmoji = await runWithDiscordRateLimitWait(
                            () => targetGuild.emojis.create({ attachment: emoji.url, name: emoji.name, reason }),
                            addLog,
                            'Emoji "' + emoji.name + '" erstellen'
                        );
                        results.emojis++;
                        await addLog('ERSTELLT Emoji: ' + createdEmoji.name + ' (' + createdEmoji.id + ')');
                        await emojiTracker.ok(1);
                    } catch (e) {
                        results.errors.push('emoji "' + emoji.name + '": ' + e.message);
                        await addLog('FEHLER Emoji "' + emoji.name + '": ' + e.message);
                        await emojiTracker.fail(1);
                    }
                }
                await emojiTracker.flush();
                await addLog(emojiTracker.summary());
                await addLog('OK ' + results.emojis + ' Emojis erstellt');
            }
        }

        let verifyReport = null;
        if (doAutoVerify) {
            await mark('Verify-Restore');
            try {
                verifyReport = await verifyRestoreOutcome(targetGuild, backupId, { sourceGuildId: backupGuildId });
                await addLog(
                    'VERIFY Overall=' + verifyReport.coverage.overall + '% | Rollen=' + verifyReport.coverage.roles +
                    '% Channels=' + verifyReport.coverage.channels + '% Emojis=' + verifyReport.coverage.emojis +
                    '% | verdict=' + verifyReport.verdict
                );
            } catch (e) {
                results.errors.push('verify: ' + e.message);
                await addLog('WARN Verify fehlgeschlagen: ' + e.message);
            }
        }

        await addLog('FERTIG Rollen:' + results.roles + ' Channels:' + results.channels + ' Emojis:' + results.emojis + ' Messages:' + results.messages + ' Fehler:' + results.errors.length);
        await pool.execute(
            'UPDATE discord_restore_jobs SET status=?, result=?, finished_at=?, log=? WHERE id=?',
            ['done', JSON.stringify({ ...results, verifyReport }), Date.now(), logLines.join('\n'), jobId]
        );
        await updateJobProgress(pool, 'discord_restore_jobs', jobId, 'Fertig', stepsTotal, stepsTotal);
    } catch (e) {
        await addLog('KRITISCH: ' + e.message);
        await pool.execute(
            'UPDATE discord_restore_jobs SET status=?, result=?, finished_at=?, log=? WHERE id=?',
            ['failed', JSON.stringify({ ...results, fatalError: e.message }), Date.now(), logLines.join('\n'), jobId]
        );
        throw e;
    }

    return { jobId, results };
}

async function getRestoreJob(jobId) {
    const pool = getPool();
    const [[row]] = await pool.execute('SELECT * FROM discord_restore_jobs WHERE id = ?', [jobId]);
    if (!row) return null;
    return {
        id: row.id,
        backupId: row.backup_id,
        targetGuildId: row.target_guild_id,
        status: row.status,
        phase: row.phase || null,
        progressCurrent: row.progress_current || 0,
        progressTotal: row.progress_total || 0,
        log: row.log || '',
        result: typeof row.result === 'string' ? JSON.parse(row.result) : (row.result ?? null),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
    };
}

async function getLatestRunningRestoreJob(targetGuildId) {
    const pool = getPool();
    const [[row]] = await pool.execute(
        "SELECT * FROM discord_restore_jobs WHERE target_guild_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
        [String(targetGuildId)]
    );
    if (!row) return null;
    return {
        id: row.id,
        backupId: row.backup_id,
        targetGuildId: row.target_guild_id,
        status: row.status,
        phase: row.phase || null,
        progressCurrent: row.progress_current || 0,
        progressTotal: row.progress_total || 0,
        log: row.log || '',
        result: typeof row.result === 'string' ? JSON.parse(row.result) : (row.result ?? null),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
    };
}

module.exports = { createServerBackup, listGuildBackups, getBackupById, getBackupMetaById, getRestorePreview, getBackupSchedule, upsertBackupSchedule, listDueBackupSchedules, markBackupScheduleRun, processScheduledBackups, verifyRestoreOutcome, deleteBackup, createBackupJob, getBackupJob, getLatestRunningBackupJob, createRestoreJob, restoreServerBackup, getRestoreJob, getLatestRunningRestoreJob };
