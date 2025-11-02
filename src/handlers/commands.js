import { globalRequestQueue } from '../utils/concurrency.js';
import { globalCooldownManager } from '../utils/cooldownManager.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

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

/**
 * 判断命令是否需要 defer
 * @param {Object} command - 命令对象
 * @param {Interaction} interaction - 交互对象
 * @returns {boolean} 是否需要 defer
 */
function shouldDeferCommand(command, interaction) {
    // 如果命令配置了 shouldDefer 函数，使用它来判断
    if (typeof command.shouldDefer === 'function') {
        return command.shouldDefer(interaction);
    }

    // 如果配置了 shouldDefer 布尔值，直接返回
    if (typeof command.shouldDefer === 'boolean') {
        return command.shouldDefer;
    }

    // 默认需要 defer
    return true;
}

/**
 * 处理斜杠命令和上下文菜单命令交互
 * @param {ChatInputCommandInteraction|ContextMenuCommandInteraction} interaction - 命令交互对象
 */
export async function handleCommand(interaction) {
    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
        logTime(`未找到命令 ${interaction.commandName}`, true);
        return;
    }

    // 判断是否需要 defer
    const needsDefer = shouldDeferCommand(command, interaction);

    if (needsDefer) {
        // 根据命令的ephemeral属性决定是否使用Ephemeral模式
        const useEphemeral = command.ephemeral !== false;

        try {
            if (useEphemeral) {
                await interaction.deferReply({ flags: ['Ephemeral'] });
            } else {
                await interaction.deferReply();
            }
        } catch (error) {
            logTime(`[命令${interaction.commandName}] deferReply失败: ${error.message}`, true);
            return;
        }
    }

    await ErrorHandler.handleInteraction(
        interaction,
        async () => {
            // 处理命令冷却时间
            const cooldownCheck = await globalCooldownManager.checkCooldown(interaction, {
                type: 'command',
                key: command.data.name,
                duration: (command.cooldown ?? 5) * 1000
            });

            if (cooldownCheck.inCooldown) {
                await cooldownCheck.reply();
                return;
            }

            // 获取服务器配置
            const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);

            // 获取命令优先级并执行
            const priority = getPriorityByCommandName(command.data.name);
            await globalRequestQueue.add(() => command.execute(interaction, guildConfig), priority);
        },
        `命令${interaction.commandName}`,
        { ephemeral: command.ephemeral !== false }
    );
}
