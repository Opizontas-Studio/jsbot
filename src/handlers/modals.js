import { ChannelType } from 'discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { ProcessModel } from '../db/models/processModel.js';
import { manageRolesByGroups, updateOpinionRecord } from '../services/roleApplication.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { handleInteractionError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { globalTaskScheduler } from './scheduler.js';

const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

/**
 * 处理意见投稿提交
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 * @param {string} type - 投稿类型（固定为opinion）
 * @param {string} titlePrefix - 标题前缀
 * @param {number} color - 嵌入消息颜色
 */
const handleSubmission = async (interaction, type, titlePrefix, color) => {
    try {
        // 获取服务器配置
        const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
        if (!guildConfig?.opinionMailThreadId) {
            await interaction.editReply({
                content: '❌ 此服务器未配置意见信箱频道',
            });
            return;
        }

        // 获取用户输入
        const title = interaction.fields.getTextInputValue(`${type}_title`);
        const content = interaction.fields.getTextInputValue(`${type}_content`);

        // 创建嵌入消息
        const messageEmbed = {
            color: color,
            title: `${titlePrefix}${title}`,
            description: content,
            author: {
                name: interaction.user.tag,
                icon_url: interaction.user.displayAvatarURL(),
            },
            timestamp: new Date(),
            footer: {
                text: '等待管理员审定'
            }
        };

        // 创建判定按钮
        const buttons = [
            {
                type: 2,
                style: 3, // Success (绿色)
                label: '合理',
                custom_id: `approve_submission_${interaction.user.id}_${type}`,
                emoji: { name: '✅' }
            },
            {
                type: 2,
                style: 4, // Danger (红色)
                label: '不合理',
                custom_id: `reject_submission_${interaction.user.id}_${type}`,
                emoji: { name: '🚪' }
            }
        ];

        const actionRow = {
            type: 1,
            components: buttons
        };

        // 获取目标频道并发送消息
        try {
            const targetChannel = await interaction.client.channels.fetch(guildConfig.opinionMailThreadId);
            if (!targetChannel) {
                throw new Error('无法获取目标频道');
            }

            await targetChannel.send({
                embeds: [messageEmbed],
                components: [actionRow]
            });

            // 回复用户确认消息
            await interaction.editReply({
                content: `✅ 社区意见已成功提交！`,
            });

            logTime(`用户 ${interaction.user.tag} 提交了社区意见: "${title}"`);
        } catch (error) {
            throw new Error(`发送投稿时出错: ${error.message}`);
        }
    } catch (error) {
        logTime(`处理社区意见失败: ${error.message}`, true);
        await interaction.editReply({
            content: `❌ 提交意见时出错，请稍后重试`,
        });
    }
};

/**
 * 投稿审核处理
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 * @param {boolean} isApproved - 是否批准（true为批准，false为拒绝）
 */
const handleSubmissionReview = async (interaction, isApproved) => {
    try {
        // 先 defer 回复
        await interaction.deferReply({ flags: ['Ephemeral'] });

        // 从modalId中解析用户ID、投稿类型和消息ID
        const modalIdParts = interaction.customId.split('_');
        const userId = modalIdParts[3];
        const submissionType = modalIdParts[4];
        const messageId = modalIdParts[5];

        // 获取管理员输入的回复内容
        const adminReply = interaction.fields.getTextInputValue('admin_reply');

        // 通过消息ID获取原始消息
        const originalMessage = await interaction.channel.messages.fetch(messageId);
        if (!originalMessage) {
            await interaction.editReply({
                content: '❌ 无法获取原始投稿消息',
            });
            return;
        }

        // 从embed中提取投稿信息
        const originalEmbed = originalMessage.embeds[0];
        let submissionData = null;
        let submissionTitle = '未知标题';

        if (originalEmbed) {
            // 提取标题（去掉前缀）
            let title = originalEmbed.title || '未记录标题';
            if (title.startsWith('💬 社区意见：')) {
                title = title.replace('💬 社区意见：', '').trim();
            }
            submissionTitle = title;

            // 只有批准时才需要完整的投稿数据
            if (isApproved) {
                const content = originalEmbed.description || '未记录内容';
                submissionData = {
                    title: title,
                    content: content
                };
            }
        }

        // 根据处理结果更新消息的embed
        const updatedEmbed = {
            ...originalEmbed.toJSON(),
            author: isApproved ? undefined : originalEmbed.author, // 批准时移除作者信息，拒绝时保留
            footer: {
                text: isApproved ? '审定有效' : '审定无效'
            }
        };

        // 移除按钮并更新消息
        await originalMessage.edit({
            embeds: [updatedEmbed],
            components: []
        });

        // 如果是批准，需要更新意见记录
        if (isApproved) {
            const result = await updateOpinionRecord(userId, submissionType, true, submissionData);
            if (!result.success) {
                await interaction.editReply({
                    content: `❌ ${result.message}`,
                });
                return;
            }
        }

        // 先向目标用户发送私聊通知
        let dmStatus = '';
        let targetUser = null;
        try {
            targetUser = await interaction.client.users.fetch(userId);
            if (targetUser) {
                const dmEmbed = {
                    color: isApproved ? 0x00ff00 : 0xff0000,
                    title: isApproved ? '✅ 投稿审定通过' : '❌ 投稿暂时无法执行',
                    description: [
                        isApproved ? `感谢您投稿的社区意见` : `感谢您投稿的社区意见`,
                        `**标题：${submissionTitle}**`,
                        '',
                        '**管理组回复：**',
                        adminReply
                    ].join('\n'),
                    timestamp: new Date(),
                };

                await targetUser.send({ embeds: [dmEmbed] });
                dmStatus = '✅ 私聊通知已成功发送';
                logTime(`已向用户 ${targetUser.tag} 发送投稿${isApproved ? '审定通过' : '拒绝'}通知`);
            } else {
                dmStatus = '❌ 无法获取用户信息，私聊通知发送失败';
            }
        } catch (dmError) {
            dmStatus = `❌ 私聊通知发送失败: ${dmError.message}`;
            logTime(`向用户 ${userId} 发送投稿${isApproved ? '审定' : '拒绝'}通知失败: ${dmError.message}`, true);
        }

        // 发送审核日志消息，包含私聊发送状态
        try {
            if (!targetUser) {
                targetUser = await interaction.client.users.fetch(userId);
            }
            const auditLogContent = [
                `管理员 ${interaction.user.tag} ${isApproved ? '审定通过了' : '拒绝了'}用户 ${targetUser?.tag || `<@${userId}>`} 的社区意见，通知发送状态为：${dmStatus}`,
                '',
                `**回复为：**`,
                `${adminReply}`,
            ].join('\n');

            await originalMessage.reply({
                content: auditLogContent,
                allowedMentions: { users: [] }
            });
        } catch (auditError) {
            logTime(`发送审核日志失败: ${auditError.message}`, true);
        }

        // 回复管理员确认消息
        await interaction.editReply({
            content: `✅ 已将该社区意见标记为${isApproved ? '合理' : '不合理'}并发送了自定义回复`,
        });

        logTime(`管理员 ${interaction.user.tag} ${isApproved ? '批准' : '拒绝'}了用户 ${userId} 的社区意见: "${submissionTitle}"，通知发送状态为：${dmStatus}`);
    } catch (error) {
        await handleInteractionError(interaction, error, `${isApproved ? 'approve' : 'reject'}_submission_modal`);
    }
};

/**
 * 模态框处理器映射
 * 每个处理器函数接收一个 ModalSubmitInteraction 参数
 */
export const modalHandlers = {
    // 身份组申请模态框处理器
    creator_role_modal: async interaction => {
        try {
            const threadLink = interaction.fields.getTextInputValue('thread_link');
            const matches = threadLink.match(/channels\/(\d+)\/(?:\d+\/threads\/)?(\d+)/);

            if (!matches) {
                await interaction.editReply('❌ 无效的帖子链接格式');
                return;
            }

            const [, linkGuildId, threadId] = matches;
            const currentGuildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);

            if (!currentGuildConfig?.roleApplication?.creatorRoleId) {
                await interaction.editReply('❌ 服务器配置错误');
                return;
            }

            // 检查链接所属服务器是否在配置中
            const linkGuildConfig = interaction.client.guildManager.getGuildConfig(linkGuildId);
            if (!linkGuildConfig) {
                await interaction.editReply('❌ 提供的帖子不在允许的服务器中');
                return;
            }

            await globalRequestQueue.add(async () => {
                const thread = await interaction.client.channels.fetch(threadId);

                if (!thread || !thread.isThread() || thread.parent?.type !== ChannelType.GuildForum) {
                    await interaction.editReply('❌ 提供的链接不是论坛帖子');
                    return;
                }

                // 获取首条消息
                const firstMessage = await thread.messages.fetch({ limit: 1, after: '0' });
                const threadStarter = firstMessage.first();

                if (!threadStarter || threadStarter.author.id !== interaction.user.id) {
                    await interaction.editReply('❌ 您不是该帖子的作者');
                    return;
                }

                // 获取反应数最多的表情
                let maxReactions = 0;
                threadStarter.reactions.cache.forEach(reaction => {
                    const count = reaction.count;
                    if (count > maxReactions) {
                        maxReactions = count;
                    }
                });

                // 准备审核日志
                const moderationChannel = await interaction.client.channels.fetch(
                    currentGuildConfig.roleApplication.logThreadId,
                );
                const auditEmbed = {
                    color: maxReactions >= 5 ? 0x00ff00 : 0xff0000,
                    title: maxReactions >= 5 ? '✅ 创作者身份组申请通过' : '❌ 创作者身份组申请未通过',
                    fields: [
                        {
                            name: '申请者',
                            value: `<@${interaction.user.id}>`,
                            inline: true,
                        },
                        {
                            name: '作品链接',
                            value: threadLink,
                            inline: true,
                        },
                        {
                            name: '最高反应数',
                            value: `${maxReactions}`,
                            inline: true,
                        },
                        {
                            name: '作品所在服务器',
                            value: thread.guild.name,
                            inline: true,
                        },
                    ],
                    timestamp: new Date(),
                    footer: {
                        text: '自动审核系统',
                    },
                };

                if (maxReactions >= 5) {
                    try {
                        // 读取身份组同步配置
                        const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));
                        const creatorSyncGroup = roleSyncConfig.syncGroups.find(group => group.name === '创作者');

                        if (creatorSyncGroup) {
                            // 使用manageRolesByGroups函数批量添加身份组
                            const result = await manageRolesByGroups(
                                interaction.client,
                                interaction.user.id,
                                [creatorSyncGroup],
                                '创作者身份组申请通过',
                                false // 设置为添加操作
                            );

                            // 只向用户显示成功的结果
                            if (result.successfulServers.length > 0) {
                                await interaction.editReply(
                                    `✅ 审核通过！已为您添加创作者身份组${
                                        result.successfulServers.length > 1
                                            ? `（已同步至：${result.successfulServers.join('、')}）`
                                            : ''
                                    }`,
                                );
                            } else {
                                await interaction.editReply('❌ 添加身份组时出现错误，请联系管理员。');
                            }

                            // 发送审核日志
                            if (moderationChannel) {
                                await moderationChannel.send({ embeds: [auditEmbed] });
                            }
                            // 记录完整日志到后台
                            logTime(
                                `[自动审核] 用户 ${
                                    interaction.user.tag
                                } 获得了创作者身份组, 同步至: ${result.successfulServers.join('、')}`,
                            );
                        } else {
                            // 如果没有找到同步配置，只在当前服务器添加
                            const member = await interaction.guild.members.fetch(interaction.user.id);
                            await member.roles.add(currentGuildConfig.roleApplication.creatorRoleId);
                            await interaction.editReply('✅ 审核通过，已为您添加创作者身份组。');
                        }
                    } catch (error) {
                        logTime(`同步添加创作者身份组时出错: ${error.message}`, true);
                        await interaction.editReply('❌ 添加身份组时出现错误，请联系管理员。');
                        return;
                    }
                } else {
                    await interaction.editReply('❌ 审核未通过，请获取足够正面反应后再申请。');
                }
            }, 3); // 用户指令优先级
        } catch (error) {
            logTime(`处理创作者身份组申请时出错: ${error}`, true);
            await interaction.editReply('❌ 处理申请时出现错误，请稍后重试。');
        }
    },
    // 议事模态框处理器
    submit_debate_modal: async interaction => {
        try {
            // 检查议事系统是否启用
            const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
            if (!guildConfig?.courtSystem?.enabled) {
                await interaction.editReply({
                    content: '❌ 此服务器未启用议事系统',
                });
                return;
            }

            // 获取用户输入
            const title = interaction.fields.getTextInputValue('debate_title');
            const reason = interaction.fields.getTextInputValue('debate_reason');
            const motion = interaction.fields.getTextInputValue('debate_motion');
            const implementation = interaction.fields.getTextInputValue('debate_implementation');
            let voteTime = interaction.fields.getTextInputValue('debate_vote_time');

            // 如果voteTime不以"天"结尾，添加"天"字
            if (!voteTime.endsWith('天')) {
                voteTime = voteTime + '天';
            }

            // 获取议事区频道
            const courtChannel = await interaction.guild.channels.fetch(guildConfig.courtSystem.courtChannelId);
            if (!courtChannel) {
                await interaction.editReply({
                    content: '❌ 无法获取议事频道',
                });
                return;
            }

            // 计算过期时间
            const expireTime = new Date(Date.now() + guildConfig.courtSystem.summitDuration);

            // 先创建议事流程（不含messageId）
            const process = await ProcessModel.createCourtProcess({
                type: 'debate',
                targetId: interaction.user.id,
                executorId: interaction.user.id,
                // 暂不设置messageId
                expireAt: expireTime.getTime(),
                details: {
                    title: title,
                    reason: reason,
                    motion: motion,
                    implementation: implementation,
                    voteTime: voteTime,
                },
            });

            // 发送包含完整信息的议事消息
            const message = await courtChannel.send({
                embeds: [
                    {
                        color: 0x5865f2,
                        title: title,
                        description: `提案人：<@${interaction.user.id}>\n\n议事截止：<t:${Math.floor(
                            expireTime.getTime() / 1000,
                        )}:R>`,
                        fields: [
                            {
                                name: '📝 原因',
                                value: reason,
                            },
                            {
                                name: '📋 动议',
                                value: motion,
                            },
                            {
                                name: '🔧 执行方案',
                                value: implementation,
                            },
                            {
                                name: '🕰️ 投票时间',
                                value: voteTime,
                            },
                        ],
                        timestamp: new Date(),
                        footer: {
                            text: `需 ${guildConfig.courtSystem.requiredSupports} 个支持，再次点击可撤销支持 | 流程ID: ${process.id}`,
                        },
                    },
                ],
                components: [
                    {
                        type: 1,
                        components: [
                            {
                                type: 2,
                                style: 3,
                                label: '支持',
                                custom_id: `support_debate_${interaction.user.id}_${interaction.user.id}`,
                                emoji: { name: '👍' },
                            },
                            {
                                type: 2,
                                style: 4,
                                label: '撤回提案',
                                custom_id: `revoke_process_${interaction.user.id}_debate`,
                                emoji: { name: '↩️' },
                            },
                        ],
                    },
                ],
            });

            // 一次性更新流程记录
            await ProcessModel.updateStatus(process.id, 'pending', {
                messageId: message.id,
                details: {
                    ...process.details,
                    embed: message.embeds[0].toJSON(),
                },
            });

            // 调度流程到期处理
            await globalTaskScheduler.getProcessScheduler().scheduleProcess(process, interaction.client);

            // 发送确认消息
            await interaction.editReply({
                content: `✅ 已提交议事申请\n👉 [点击查看议事消息](${message.url})`,
            });

            logTime(`用户 ${interaction.user.tag} 提交了议事 "${title}"`);
        } catch (error) {
            logTime(`提交议事申请失败: ${error.message}`, true);
            await interaction.editReply({
                content: '❌ 提交议事申请时出错，请稍后重试',
            });
        }
    },

    // 社区意见投稿模态框处理器
    opinion_submission_modal: async interaction => {
        await handleSubmission(interaction, 'opinion', '💬 社区意见：', 0x2ecc71); // 绿色
    },

    // 批准投稿模态框处理器
    approve_submission_modal: async interaction => {
        await handleSubmissionReview(interaction, true);
    },

    // 拒绝投稿模态框处理器
    reject_submission_modal: async interaction => {
        await handleSubmissionReview(interaction, false);
    },
};

/**
 * 统一的模态框交互处理函数
 * @param {ModalSubmitInteraction} interaction - Discord模态框提交交互对象
 */
export async function handleModal(interaction) {
    // 获取基础模态框ID
    const modalId = interaction.customId;
    let handler = modalHandlers[modalId];

    // 如果没有找到精确匹配，尝试前缀匹配（用于动态ID的模态框）
    if (!handler) {
        // 检查是否是批准或拒绝投稿的模态框
        if (modalId.startsWith('approve_submission_modal_')) {
            handler = modalHandlers.approve_submission_modal;
        } else if (modalId.startsWith('reject_submission_modal_')) {
            handler = modalHandlers.reject_submission_modal;
        }
    }

    if (!handler) {
        logTime(`未找到模态框处理器: ${interaction.customId}`, true);
        return;
    }

    try {
        await handler(interaction);
    } catch (error) {
        await handleInteractionError(interaction, error, 'modal');
    }
}
