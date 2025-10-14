import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { EmbedFactory } from '../factories/embedFactory.js';
import { ErrorHandler } from './errorHandler.js';
import { logTime } from './logger.js';

/**
 * 判断错误是否为交互超时错误
 * @private
 */
function isTimeoutError(error) {
    return (
        error.code === 'InteractionCollectorError' ||
        error.message?.includes('Collector received no interactions before ending with reason: time')
    );
}

/**
 * 处理确认按钮超时
 * @private
 */
async function handleConfirmationTimeout(interaction, operationName, customHandler) {
    // 如果提供了自定义超时处理器，优先使用
    if (customHandler) {
        return await customHandler(interaction);
    }

    // 使用默认超时处理
    const embed = operationName
        ? EmbedFactory.createOperationTimeoutEmbed(operationName)
        : {
              color: 0x808080,
              title: '❌ 确认已超时',
              description: '操作已取消。如需继续请重新执行命令。',
          };

    await ErrorHandler.handleSilent(
        async () => {
            await interaction.editReply({
                embeds: [embed],
                components: [],
            });
        },
        '处理确认超时响应',
    );
}

/**
 * 处理确认按钮过程中的错误
 * @private
 */
async function handleConfirmationError(error, interaction, customHandler) {
    // 如果提供了自定义错误处理器，使用它
    if (customHandler) {
        return await customHandler(error, interaction);
    }

    // 使用默认错误处理
    await ErrorHandler.handleSilent(
        async () => {
            await interaction.editReply({
                content: `❌ 操作失败: ${error.message}`,
                components: [],
                embeds: [],
            });
        },
        '处理确认按钮错误',
    );
}

/**
 * 等待用户确认交互
 * @private
 */
async function waitForConfirmation(response, interaction, customId, onConfirm, handlers, timeout) {
    const { onTimeout, onError, operationName } = handlers;

    try {
        const confirmation = await response.awaitMessageComponent({
            filter: i => i.user.id === interaction.user.id,
            time: timeout,
        });

        if (confirmation.customId === customId) {
            await onConfirm(confirmation);
        }
    } catch (error) {
        // 处理超时错误
        if (isTimeoutError(error)) {
            logTime(`按钮确认超时: ${customId}`);
            await handleConfirmationTimeout(interaction, operationName, onTimeout);
            return;
        }

        // 处理其他错误
        logTime(`确认按钮处理错误: ${error.message}`, true);
        await handleConfirmationError(error, interaction, onError);
    }
}

/**
 * 创建并处理确认按钮
 * @param {Object} options - 配置选项
 * @param {BaseInteraction} options.interaction - Discord交互对象
 * @param {Object} options.embed - 确认消息的嵌入配置
 * @param {string} options.customId - 按钮的自定义ID
 * @param {string} options.buttonLabel - 按钮文本
 * @param {Function} options.onConfirm - 确认后的回调函数
 * @param {Function} [options.onTimeout] - 超时后的回调函数（如果不提供，将使用默认处理）
 * @param {Function} [options.onError] - 错误处理回调函数（如果不提供，将使用默认处理）
 * @param {string} [options.operationName] - 操作名称，用于默认超时消息
 * @param {number} [options.timeout=120000] - 超时时间（毫秒）
 * @returns {Promise<void>}
 */
export async function handleConfirmationButton({
    interaction,
    embed,
    customId,
    buttonLabel,
    onConfirm,
    onTimeout,
    onError,
    operationName,
    timeout = 120000,
}) {
    // 创建确认按钮
    const confirmButton = new ButtonBuilder().setCustomId(customId).setLabel(buttonLabel).setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(confirmButton);

    // 添加默认的页脚文本
    if (!embed.footer) {
        embed.footer = { text: '此确认按钮将在2分钟后失效' };
    }

    // 发送确认消息
    const response = await interaction.editReply({
        embeds: [embed],
        components: [row],
    });

    // 在后台处理按钮交互，不阻塞主流程
    const handlers = { onTimeout, onError, operationName };
    waitForConfirmation(response, interaction, customId, onConfirm, handlers, timeout).catch(error => {
        logTime(`确认按钮等待处理出错: ${error.message}`, true);
    });
}
