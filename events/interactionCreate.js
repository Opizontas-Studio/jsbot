const { Events, Collection } = require('discord.js');
const { logTime } = require('../utils/helper');

// 创建一个用于存储冷却时间的集合
const cooldowns = new Collection();

// 默认冷却时间（秒）
const DEFAULT_COOLDOWN = 3;

/**
 * 处理Discord斜杠命令交互
 * @param {Interaction} interaction - Discord交互对象
 */
module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (!interaction.isChatInputCommand()) return;

        // 获取服务器特定配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig) {
            await interaction.reply({ 
                content: '此服务器尚未配置，无法使用命令。',
                flags: ['Ephemeral']
            });
            return;
        }

        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) {
            logTime(`未找到命令 ${interaction.commandName}`, true);
            return;
        }

        // 检查命令冷却时间
        if (!cooldowns.has(command.data.name)) {
            cooldowns.set(command.data.name, new Collection());
        }

        const now = Date.now();
        const timestamps = cooldowns.get(command.data.name);
        const cooldownAmount = (command.cooldown ?? DEFAULT_COOLDOWN) * 1000;

        // 检查用户是否在冷却中
        if (timestamps.has(interaction.user.id)) {
            const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

            if (now < expirationTime) {
                const timeLeft = (expirationTime - now) / 1000;
                await interaction.reply({
                    content: `⏳ 请等待 ${timeLeft.toFixed(1)} 秒后再使用 \`${command.data.name}\` 命令。`,
                    flags: ['Ephemeral']
                });
                return;
            }
        }

        // 设置用户的命令使用时间戳
        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        try {
            // 传入服务器配置
            await command.execute(interaction, guildConfig);
        } catch (error) {
            logTime(`执行命令 ${interaction.commandName} 时出错: ${error}`, true);
            const message = '执行此命令时出现错误。';
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: message, flags: ['Ephemeral'] });
            } else {
                await interaction.reply({ content: message, flags: ['Ephemeral'] });
            }
        }
    },
}; 