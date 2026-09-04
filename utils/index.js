// Kleine geteilte Helfer -- Ausschnitt aus fahrstuhl/utils/index.js (nur was EselModerator
// tatsaechlich braucht, keine Troll-spezifischen Helfer).
const { MessageFlags } = require("discord.js");

function normalizeReplyOptions(options) {
    if (!options || typeof options !== "object") return options;
    const normalized = { ...options };
    if (Array.isArray(normalized.flags)) {
        normalized.flags = normalized.flags.reduce((acc, flag) => acc | flag, 0);
    }
    return normalized;
}

async function safeReply(interaction, options) {
    try {
        const normalizedOptions = normalizeReplyOptions(options);
        if (interaction.deferred || interaction.replied) {
            return await interaction.editReply(normalizedOptions);
        }
        return await interaction.reply(normalizedOptions);
    } catch (err) {
        if (err.code !== 10062 && err.code !== 40060) {
            console.error("Reply Error:", err);
        }
        return null;
    }
}

module.exports = {
    safeReply,
};
