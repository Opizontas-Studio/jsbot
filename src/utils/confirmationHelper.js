import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { logTime } from './logger.js';

/**
 * 创建并处理确认按钮
 * @param {Object} options - 配置选项
 * @param {BaseInteraction} options.interaction - Discord交互对象
 * @param {Object} options.embed - 确认消息的嵌入配置
 * @param {string} options.customId - 按钮的自定义ID
 * @param {string} options.buttonLabel - 按钮文本
 * @param {Function} options.onConfirm - 确认后的回调函数
 * @param {Function} [options.onTimeout] - 超时后的回调函数
 * @param {Function} [options.onError] - 错误处理回调函数
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
    waitForConfirmation(response, interaction, customId, onConfirm, onTimeout, onError, timeout).catch(error => {
        logTime(`确认按钮等待处理出错: ${error.message}`, true);
    });
}

/**
 * 等待用户确认交互
 * @private
 */
async function waitForConfirmation(response, interaction, customId, onConfirm, onTimeout, onError, timeout) {
    try {
        const confirmation = await response.awaitMessageComponent({
            filter: i => i.user.id === interaction.user.id,
            time: timeout,
        });

        if (confirmation.customId === customId) {
            await onConfirm(confirmation);
        }
    } catch (error) {
        try {
            // 优先处理超时错误
            if (
                error.code === 'InteractionCollectorError' ||
                error.message?.includes('Collector received no interactions before ending with reason: time')
            ) {
                logTime(`按钮确认超时: ${customId}`);
                if (onTimeout) {
                    await onTimeout(interaction); // 调用 onTimeout 回调
                } else {
                    // 默认的超时处理，如果 onTimeout 未提供
                    await interaction
                        .editReply({
                            embeds: [
                                {
                                    color: 0x808080,
                                    title: '❌ 确认已超时',
                                    description: '操作已取消。如需继续请重新执行命令。',
                                },
                            ],
                            components: [],
                        })
                        .catch(err => {
                            logTime(`处理超时响应失败: ${err.message}`, true);
                        });
                }
            } else if (onError) {
                // 如果不是超时错误，并且 onError 存在，则调用 onError
                await onError(error);
            } else {
                // 其他未处理的错误
                logTime(`确认按钮处理错误: ${error.message}`, true);
            }
        } catch (handlerError) {
            // 捕获处理错误时的异常，防止向上抛出
            logTime(`处理确认按钮错误时出现异常: ${handlerError.message}`, true);
        }
    }
}
