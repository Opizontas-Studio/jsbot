import { Collection, Events } from 'discord.js';
import { handleButton } from '../handlers/buttons.js';
import { handleModal } from '../handlers/modals.js';
import { globalRequestQueue } from '../utils/concurrency.js';
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
        // 检查交互是否仍然有效
        if (!interaction.isRepliable()) {
            logTime(`检测到无效交互: ${interaction.id}`, true);
            return;
        }

        // 处理按钮交互
        if (interaction.isButton()) {
            // 解析按钮类型
            const buttonType = interaction.customId.split('_')[0];

            // 需要队列控制的按钮类型
            const queuedButtonTypes = ['court', 'vote', 'appeal'];

            if (queuedButtonTypes.includes(buttonType)) {
                // 获取优先级
                const priority = buttonType === 'appeal' ? 4 : 3;

                // 使用队列处理
                return globalRequestQueue.add(() => handleButton(interaction), priority);
            }

            // 其他按钮直接处理
            return handleButton(interaction);
        }

        // 处理模态框提交
        if (interaction.isModalSubmit()) {
            await interaction.deferReply({ flags: ['Ephemeral'] });
            return handleModal(interaction);
        }

        // 只处理斜杠命令
        if (!interaction.isChatInputCommand()) {
            return;
        }

        await interaction.deferReply({ flags: ['Ephemeral'] });

        // 获取服务器特定配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig) {
            return interaction.editReply({
                content: '此服务器尚未配置，无法使用命令。',
                flags: ['Ephemeral'],
            });
        }

        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) {
            logTime(`未找到命令 ${interaction.commandName}`, true);
            return;
        }

        // 处理命令冷却时间
        const cooldownResult = await handleCooldown(interaction, command);
        if (cooldownResult) return cooldownResult;

        // 获取命令优先级
        const priority = getPriorityByCommandName(command.data.name);

        // 执行命令
        await globalRequestQueue.add(() => command.execute(interaction, guildConfig), priority);
    },
};

/**
 * 处理命令冷却时间
 * @param {Interaction} interaction 交互对象
 * @param {Command} command 命令对象
 * @returns {Promise<InteractionEditReplyOptions|null>} 如果在冷却中返回提示消息，否则返回null
 */
async function handleCooldown(interaction, command) {
    if (!cooldowns.has(command.data.name)) {
        cooldowns.set(command.data.name, new Collection());
    }

    const now = Date.now();
    const timestamps = cooldowns.get(command.data.name);
    const cooldownAmount = (command.cooldown ?? DEFAULT_COOLDOWN) * 1000;

    if (timestamps.has(interaction.user.id)) {
        const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

        if (now < expirationTime) {
            const timeLeft = (expirationTime - now) / 1000;
            return interaction.editReply({
                content: `⏳ 请等待 ${timeLeft.toFixed(1)} 秒后再使用 \`${command.data.name}\` 命令。`,
                flags: ['Ephemeral'],
            });
        }
    }

    timestamps.set(interaction.user.id, now);
    setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);
    return null;
}

/**
 * 根据命令名称获取优先级
 * @param {string} commandName 命令名称
 * @returns {number} 优先级 (1-5)
 */
function getPriorityByCommandName(commandName) {
    const priorityMap = {
        adm_: 5, // 管理级任务最高优先级
        mod_: 4, // 管理员任务次高优先级
        user_: 3, // 用户任务中等优先级
        long_: 2, // 耗时后台任务较低优先级
    };

    const prefix = Object.keys(priorityMap).find(prefix => commandName.startsWith(prefix));
    return priorityMap[prefix] ?? 1; // 默认优先级为1
}
