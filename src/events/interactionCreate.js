import { Collection, Events } from 'discord.js';
import { handleButton } from '../handlers/buttons.js';
import { handleModal } from '../handlers/modals.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 创建一个用于存储冷却时间的集合
const cooldowns = new Collection();

// 默认冷却时间（秒）
const DEFAULT_COOLDOWN = 5;

/**
 * 处理Discord交互事件
 * @param {Interaction} interaction - Discord交互对象
 */
export default {
    name: Events.InteractionCreate,
    async execute(interaction) {
        // 处理按钮交互
        if (interaction.isButton()) {
            await handleButton(interaction);
            return;
        }

        // 处理模态框提交
        if (interaction.isModalSubmit()) {
            await interaction.deferReply({ flags: ['Ephemeral'] });
            await handleModal(interaction);
            return;
        }

        // 只处理斜杠命令
        if (!interaction.isChatInputCommand()) {
            return;
        }

        // 对于命令，使用延迟响应
        await interaction.deferReply({ flags: ['Ephemeral'] });

        // 获取服务器特定配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig) {
            await interaction.editReply({
                content: '此服务器尚未配置，无法使用命令。',
                flags: ['Ephemeral'],
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
                await interaction.editReply({
                    content: `⏳ 请等待 ${timeLeft.toFixed(1)} 秒后再使用 \`${command.data.name}\` 命令。`,
                    flags: ['Ephemeral'],
                });
                return;
            }
        }

        // 设置用户的命令使用时间戳
        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        try {
            // 根据命令名称前缀设置优先级
            let priority = 1; // 默认优先级
            const commandName = command.data.name;

            if (commandName.startsWith('adm_')) {
                priority = 5; // 管理级任务最高优先级
            } else if (commandName.startsWith('mod_')) {
                priority = 4; // 管理员任务次高优先级
            } else if (commandName.startsWith('user_')) {
                priority = 3; // 用户任务中等优先级
            } else if (commandName.startsWith('long_')) {
                priority = 2; // 耗时后台任务较低优先级
            }

            // 使用全局请求队列处理命令
            await globalRequestQueue.add(async () => {
                await command.execute(interaction, guildConfig);
            }, priority);
        } catch (error) {
            await handleCommandError(interaction, error, command.data.name);
        }
    },
};
