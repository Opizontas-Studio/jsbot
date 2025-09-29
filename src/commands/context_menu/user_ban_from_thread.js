import { ApplicationCommandType, ChannelType, ContextMenuCommandBuilder } from 'discord.js';
import { delay } from '../../utils/concurrency.js';
import { handleConfirmationButton } from '../../utils/confirmationHelper.js';
import { handleCommandError } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new ContextMenuCommandBuilder()
        .setName('自助贴内拉黑')
        .setType(ApplicationCommandType.Message),

    async execute(interaction, guildConfig) {
        // 检查是否在论坛帖子中使用
        if (!interaction.channel.isThread() || !interaction.channel.parent?.type === ChannelType.GuildForum) {
            await interaction.editReply({
                content: '❌ 此命令只能在论坛帖子中使用',
                flags: ['Ephemeral'],
            });
            return;
        }

        const thread = interaction.channel;
        const targetUser = interaction.targetMessage.author;

        // 检查是否为帖子作者
        if (thread.ownerId !== interaction.user.id) {
            await interaction.editReply({
                content: '❌ 只有帖子作者才能管理此帖子',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查目标用户是否为帖子创建者
        if (targetUser.id === thread.ownerId) {
            await interaction.editReply({
                content: '❌ 不能删除你自己的消息',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查目标用户是否为机器人
        if (targetUser.bot) {
            await interaction.editReply({
                content: '❌ 不能删除机器人的消息',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 获取目标用户的身份组
        const targetMember = await interaction.guild.members.fetch(targetUser.id);

        // 检查目标用户是否拥有版主权限
        const moderatorRoles = guildConfig.ModeratorRoleIds || [];
        const hasModerationRole = targetMember.roles.cache.some(role => moderatorRoles.includes(role.id));

        if (hasModerationRole) {
            await interaction.editReply({
                content: '❌ 不能删除具有管理权限用户的消息',
                flags: ['Ephemeral'],
            });
            return;
        }

        // 确认操作
        await handleConfirmationButton({
            interaction,
            customId: 'confirm_delete_all_msgs_context',
            buttonLabel: '确认拉黑',
            embed: {
                color: 0xff0000,
                title: '⚠️ 拉黑确认',
                description: [
                    `你确定要拉黑用户 **${targetUser.tag}** 并删除其在帖子 "${thread.name}" 中的所有消息吗？`,
                    '',
                    '**⚠️ 警告：**',
                    '- 此操作不可撤销，将删除该用户的所有消息并将其移出子区。',
                    '- 如果帖子消息数量很多，此操作可能需要较长时间，最大扫描上限为1000条。'
                ].join('\n'),
            },
            onConfirm: async confirmation => {
                await confirmation.deferUpdate();
                await interaction.editReply({
                    content: '⏳ 正在扫描消息...',
                    components: [],
                    embeds: [],
                });

                const MAX_MESSAGES_TO_SCAN = 1000;
                let lastId = null;
                let messagesProcessed = 0;
                let deletedCount = 0;
                let hasMoreMessages = true;
                let limitReached = false;

                /**
                 * 更新操作进度
                 * @param {string} status - 当前状态
                 */
                const updateProgress = async (status = '处理中') => {
                    await interaction.editReply({
                        content: `⏳ ${status} ${targetUser.tag} 的消息...已扫描: ${messagesProcessed} 条 (上限 ${MAX_MESSAGES_TO_SCAN}) 已删除: ${deletedCount} 条`,
                        components: [],
                        embeds: [],
                    });
                };

                try {
                    while (hasMoreMessages) {
                        // 更新获取消息批次前的进度
                        await updateProgress('正在获取');

                        // 获取消息批次
                        const options = { limit: 100 };
                        if (lastId) options.before = lastId;
                        const messages = await thread.messages.fetch(options);

                        if (messages.size === 0) {
                            hasMoreMessages = false;
                            continue;
                        }

                        // 更新消息处理记录
                        messagesProcessed += messages.size;
                        lastId = messages.last().id;

                        // 新增：检查是否达到扫描上限
                        if (messagesProcessed >= MAX_MESSAGES_TO_SCAN) {
                            hasMoreMessages = false; // 停止获取更多消息
                            limitReached = true;    // 标记已达到上限
                            logTime(`[自助管理] 帖子 ${thread.name} 中删除用户 ${targetUser.tag} 消息时达到 ${MAX_MESSAGES_TO_SCAN} 条扫描上限。已扫描 ${messagesProcessed} 条。`);
                        }

                        // 更新获取消息后的进度
                        await updateProgress('正在处理');

                        // 添加延迟避免API限制
                        await delay(800);

                        // 筛选并删除目标用户的消息
                        const targetMessages = messages.filter(msg => msg.author.id === targetUser.id);

                        for (const message of targetMessages.values()) {
                            try {
                                await message.delete();
                                deletedCount++;

                                // 每删除10条消息更新一次进度
                                if (deletedCount % 10 === 0) {
                                    await updateProgress('正在删除');
                                }

                                // 添加延迟避免API限制
                                await delay(1000);
                            } catch (error) {
                                logTime(`删除用户消息失败 (${message.id}): ${error.message}`, true);
                            }
                        }
                        //如果因为达到上限而停止，确保最后一次进度更新
                        if (limitReached && !hasMoreMessages) {
                            await updateProgress('已达到扫描上限，正在完成当前批次删除');
                        }
                    }

                    // 尝试移除用户
                    try {
                        await thread.members.remove(targetUser.id);

                        //根据是否达到上限更新最终结果
                        const finalMessage = limitReached
                            ? `✅ 已扫描 ${messagesProcessed} 条消息（达到上限）。已删除用户 ${targetUser.tag} 的 ${deletedCount} 条消息并将其移出子区。`
                            : `✅ 已删除用户 ${targetUser.tag} 的 ${deletedCount} 条消息并将其移出子区`;
                        await interaction.editReply({
                            content: finalMessage,
                            components: [],
                            embeds: [],
                        });

                        logTime(`[自助管理] 楼主 ${interaction.user.tag} 删除了用户 ${targetUser.tag} 在帖子 ${thread.name} 中的 ${deletedCount} 条消息并将其移出子区${limitReached ? ` (扫描达到 ${MAX_MESSAGES_TO_SCAN} 条上限，共扫描 ${messagesProcessed} 条)` : ''}`);
                    } catch (error) {
                        const finalMessage = limitReached
                            ? `⚠️ 已扫描 ${messagesProcessed} 条消息（达到上限）。已删除用户 ${targetUser.tag} 的 ${deletedCount} 条消息，但移出子区失败: ${error.message}`
                            : `⚠️ 已删除用户 ${targetUser.tag} 的 ${deletedCount} 条消息，但移出子区失败: ${error.message}`;
                        await interaction.editReply({
                            content: finalMessage,
                            components: [],
                            embeds: [],
                        });

                        logTime(`[自助管理] 楼主 ${interaction.user.tag} 删除了用户 ${targetUser.tag} 在帖子 ${thread.name} 中的 ${deletedCount} 条消息，但移出子区失败: ${error.message}${limitReached ? ` (扫描达到 ${MAX_MESSAGES_TO_SCAN} 条上限，共扫描 ${messagesProcessed} 条)` : ''}`, true);
                    }
                } catch (error) {
                    await handleCommandError(interaction, error, '删除用户全部消息');
                }
            },
            onTimeout: async interaction => {
                await interaction.editReply({
                    embeds: [
                        {
                            color: 0x808080,
                            title: '❌ 确认已超时',
                            description: '拉黑用户操作已超时。如需继续请重新执行命令。',
                        }
                    ],
                    components: [],
                });
            },
            onError: async error => {
                await handleCommandError(interaction, error, '拉黑用户');
            },
        });
    },
};
