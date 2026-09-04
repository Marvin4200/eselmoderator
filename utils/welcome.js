// Welcome/Goodbye-Nachrichten + Autorole -- aus fahrstuhl/index.js extrahiert (Zeilen ~292,
// 457-543, 1850-1897). "AI Welcome" ist trotz des Namens kein echter LLM-Call, sondern eine
// deterministische Vorlagen-Auswahl je Charakter -- 1:1 uebernommen.
const { EmbedBuilder, PermissionsBitField } = require("discord.js");
const { parseBoolean } = require("./valueParsers");

function moduleEnabled(config, key, fallback = false) {
    const modules = config.modules || {};
    return parseBoolean(modules[key], fallback);
}

function welcomeModuleEnabled(config) {
    if (moduleEnabled(config, "welcome", false)) return true;
    const welcome = config.welcome && typeof config.welcome === "object" ? config.welcome : {};
    return !!(
        parseBoolean(welcome.welcomeEnabled) ||
        parseBoolean(welcome.goodbyeEnabled) ||
        parseBoolean(welcome.dmEnabled) ||
        parseBoolean(welcome.autoroleEnabled) ||
        parseBoolean(welcome.aiWelcomeEnabled)
    );
}

function renderWelcomeTemplate(template, member) {
    const text = String(template || "");
    return text
        .replaceAll("{user}", `<@${member.id}>`)
        .replaceAll("{username}", member.user?.username || member.displayName || "Someone")
        .replaceAll("{tag}", member.user?.username || "Someone")
        .replaceAll("{server}", member.guild.name)
        .replaceAll("{server.name}", member.guild.name)
        .replaceAll("{memberCount}", String(member.guild.memberCount || 0))
        .replaceAll("{server.member_count}", String(member.guild.memberCount || 0))
        .replaceAll("{userAvatar}", member.user?.displayAvatarURL({ extension: "png", size: 512 }) || "")
        .replaceAll("{serverIcon}", member.guild.iconURL({ extension: "png", size: 512 }) || "");
}

function discordImageUrl(value) {
    const url = String(value || "").trim();
    return /^https?:\/\//i.test(url) ? url : "";
}

function discordText(value, limit, fallback = "") {
    const text = String(value ?? "").trim();
    const safe = text || fallback;
    return safe.length > limit ? safe.slice(0, limit) : safe;
}

function normalizeEmbedFields(value) {
    try {
        const parsed = Array.isArray(value) ? value : JSON.parse(String(value || "[]"));
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(field => ({
                name: String(field?.name || "").slice(0, 256),
                value: String(field?.value || "").slice(0, 1024),
                inline: !!field?.inline,
            }))
            .filter(field => field.name && field.value)
            .slice(0, 10);
    } catch {
        return [];
    }
}

function addWelcomeFields(embed, fields, member) {
    normalizeEmbedFields(fields).forEach(field => {
        const name = discordText(renderWelcomeTemplate(field.name, member), 256);
        const value = discordText(renderWelcomeTemplate(field.value, member), 1024);
        if (!name || !value) return;
        embed.addFields({ name, value, inline: field.inline });
    });
}

const AI_WELCOME_TEMPLATES = {
    friendly: [
        "Hey {user}, schön dass du auf **{server}** gelandet bist. Mach es dir gemütlich, du bist Member #{memberCount}.",
        "Willkommen {user}! **{server}** freut sich auf dich. Schau dich in Ruhe um und hab eine gute Zeit hier.",
    ],
    gaming: [
        "{user} ist dem Squad beigetreten. Willkommen auf **{server}**, Member #{memberCount}. Bereit für die nächste Runde?",
        "GG, {user} ist da. **{server}** hat gerade Verstärkung bekommen.",
    ],
    professional: [
        "Willkommen {user} auf **{server}**. Du bist Member #{memberCount}. Bitte lies dir kurz die wichtigsten Infos durch.",
        "Hallo {user}, willkommen auf **{server}**. Wir freuen uns, dich hier zu haben.",
    ],
    funny: [
        "{user} ist reingestolpert und **{server}** ist offiziell ein kleines bisschen lauter. Willkommen, Member #{memberCount}.",
        "Achtung, {user} ist da. Bitte alle Konfetti-Kanonen innerlich auslösen. Willkommen auf **{server}**!",
    ],
    anime: [
        "Willkommen {user}! Dein Abenteuer auf **{server}** beginnt jetzt. Member #{memberCount}, zeig uns deinen besten Arc.",
        "{user} betritt die Szene. **{server}** hat gerade einen neuen Hauptcharakter bekommen.",
    ],
    support: [
        "Willkommen {user} auf **{server}**. Wenn du Hilfe brauchst, ist das Team für dich da.",
        "Hey {user}, willkommen. Lies dir die Infos durch und melde dich jederzeit, wenn du Support brauchst.",
    ],
};

function buildAiWelcomeMessage(welcome, member) {
    if (!welcome.aiWelcomeEnabled) return null;
    const character = String(welcome.aiCharacter || "friendly").toLowerCase();
    const pool = AI_WELCOME_TEMPLATES[character] || AI_WELCOME_TEMPLATES.friendly;
    const index = Number(BigInt(member.id || "0") % BigInt(pool.length));
    return renderWelcomeTemplate(pool[index], member);
}

async function sendConfiguredWelcome(member, type, config) {
    if (!welcomeModuleEnabled(config)) return;

    const welcome = config.welcome && typeof config.welcome === "object" ? config.welcome : {};
    const isJoin = type === "join";

    if (isJoin && welcome.autoroleEnabled && welcome.autoroleId && !welcome.verificationEnabled) {
        const role = member.guild.roles.cache.get(String(welcome.autoroleId));
        const me = member.guild.members.me || await member.guild.members.fetchMe().catch(() => null);
        const canAssignRole = role && me && !role.managed
            && role.position < me.roles.highest.position
            && me.permissions.has(PermissionsBitField.Flags.ManageRoles);

        if (canAssignRole) {
            await member.roles.add(role, "EselModerator welcome autorole").catch(error => {
                console.warn(`⚠️ Autorole assign failed in ${member.guild.name}: ${error.message}`);
            });
        } else {
            console.warn(`⚠️ Autorole skipped in ${member.guild.name}: role missing or not assignable`);
        }
    }

    const enabled = isJoin
        ? (parseBoolean(welcome.aiWelcomeEnabled) || parseBoolean(welcome.welcomeEnabled, true))
        : parseBoolean(welcome.goodbyeEnabled);

    const channelId = String(isJoin
        ? (welcome.welcomeChannelId || welcome.channelId || "")
        : (welcome.goodbyeChannelId || welcome.channelId || "")
    ).trim();

    if (!enabled || !channelId) return;

    const channel = member.guild.channels.cache.get(channelId)
        || await member.guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
        console.warn(`⚠️ ${isJoin ? "Welcome" : "Goodbye"} skipped in ${member.guild.name}: channel ${channelId} not found or not text based`);
        return;
    }

    const aiWelcomeText = isJoin ? buildAiWelcomeMessage(welcome, member) : null;
    const template = aiWelcomeText || (isJoin
        ? (welcome.welcomeMessage || "Welcome {user} to {server}! You are member #{memberCount}.")
        : (welcome.goodbyeMessage || "{username} left {server}. We are now {memberCount} members."));

    const cardEnabled = isJoin && parseBoolean(welcome.welcomeCardEnabled);
    const asEmbed = isJoin ? (parseBoolean(welcome.welcomeAsEmbed) || cardEnabled) : parseBoolean(welcome.goodbyeAsEmbed);

    if (!asEmbed) {
        await channel.send({
            content: aiWelcomeText || renderWelcomeTemplate(template, member),
            allowedMentions: isJoin ? { users: [member.id] } : { parse: [] },
        });
        return;
    }

    const embed = new EmbedBuilder();
    if (isJoin) {
        if (cardEnabled) {
            embed.setTitle(discordText(renderWelcomeTemplate(welcome.welcomeCardTitle || "{username} just joined the server", member), 256, "Welcome"));
            embed.setDescription(discordText(aiWelcomeText || renderWelcomeTemplate(welcome.welcomeCardSubtitle || "Member #{memberCount}", member), 4096, `Welcome ${member.user?.username || "there"}!`));
            const avatarUrl = member.user?.displayAvatarURL({ extension: "png", size: 256 });
            if (avatarUrl) embed.setThumbnail(avatarUrl);
            const cardImage = discordImageUrl(renderWelcomeTemplate(welcome.welcomeCardBackgroundImage, member));
            if (cardImage) embed.setImage(cardImage);
        } else {
            if (welcome.welcomeEmbedTitle) embed.setTitle(discordText(renderWelcomeTemplate(welcome.welcomeEmbedTitle, member), 256));
            embed.setDescription(discordText(aiWelcomeText || renderWelcomeTemplate(template, member), 4096, `Welcome ${member.user?.username || "there"}!`));
        }
        if (welcome.welcomeEmbedColor) embed.setColor(welcome.welcomeEmbedColor);
        const welcomeAvatar = discordImageUrl(renderWelcomeTemplate(welcome.welcomeEmbedAvatar, member));
        const welcomeHeader = renderWelcomeTemplate(welcome.welcomeEmbedHeader || "", member).slice(0, 256);
        if (welcomeHeader || welcomeAvatar) embed.setAuthor(welcomeAvatar ? { name: welcomeHeader || member.guild.name, iconURL: welcomeAvatar } : { name: welcomeHeader || member.guild.name });
        const welcomeFooterIcon = discordImageUrl(renderWelcomeTemplate(welcome.welcomeEmbedFooterIcon, member));
        if (welcome.welcomeEmbedFooter) embed.setFooter(welcomeFooterIcon ? { text: renderWelcomeTemplate(welcome.welcomeEmbedFooter, member), iconURL: welcomeFooterIcon } : { text: renderWelcomeTemplate(welcome.welcomeEmbedFooter, member) });
        const welcomeThumbnail = discordImageUrl(renderWelcomeTemplate(welcome.welcomeEmbedThumbnail, member));
        const welcomeImage = discordImageUrl(renderWelcomeTemplate(welcome.welcomeEmbedImage, member));
        if (welcomeThumbnail) embed.setThumbnail(welcomeThumbnail);
        if (welcomeImage) embed.setImage(welcomeImage);
        addWelcomeFields(embed, welcome.welcomeEmbedFields, member);
    } else {
        if (welcome.goodbyeEmbedTitle) embed.setTitle(discordText(renderWelcomeTemplate(welcome.goodbyeEmbedTitle, member), 256));
        embed.setDescription(discordText(renderWelcomeTemplate(template, member), 4096, `${member.user?.username || "Someone"} left ${member.guild.name}.`));
        if (welcome.goodbyeEmbedColor) embed.setColor(welcome.goodbyeEmbedColor);
        const goodbyeAvatar = discordImageUrl(renderWelcomeTemplate(welcome.goodbyeEmbedAvatar, member));
        const goodbyeHeader = renderWelcomeTemplate(welcome.goodbyeEmbedHeader || "", member).slice(0, 256);
        if (goodbyeHeader || goodbyeAvatar) embed.setAuthor(goodbyeAvatar ? { name: goodbyeHeader || member.guild.name, iconURL: goodbyeAvatar } : { name: goodbyeHeader || member.guild.name });
        const goodbyeFooterIcon = discordImageUrl(renderWelcomeTemplate(welcome.goodbyeEmbedFooterIcon, member));
        if (welcome.goodbyeEmbedFooter) embed.setFooter(goodbyeFooterIcon ? { text: renderWelcomeTemplate(welcome.goodbyeEmbedFooter, member), iconURL: goodbyeFooterIcon } : { text: renderWelcomeTemplate(welcome.goodbyeEmbedFooter, member) });
        const goodbyeThumbnail = discordImageUrl(renderWelcomeTemplate(welcome.goodbyeEmbedThumbnail, member));
        const goodbyeImage = discordImageUrl(renderWelcomeTemplate(welcome.goodbyeEmbedImage, member));
        if (goodbyeThumbnail) embed.setThumbnail(goodbyeThumbnail);
        if (goodbyeImage) embed.setImage(goodbyeImage);
        addWelcomeFields(embed, welcome.goodbyeEmbedFields, member);
    }
    embed.setTimestamp();
    await channel.send({
        embeds: [embed],
        allowedMentions: isJoin ? { users: [member.id] } : { parse: [] },
    });
}

module.exports = {
    sendConfiguredWelcome,
};
