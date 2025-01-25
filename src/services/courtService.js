import { dbManager } from '../db/dbManager.js';
import { ProcessModel } from '../db/models/processModel.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { logTime } from '../utils/logger.js';
import { revokePunishmentInGuilds } from '../utils/punishmentHelper.js';

class CourtService {
    /**
     * 创建辩诉帖子
     * @param {Object} process - 流程记录
     * @param {Object} guildConfig - 服务器配置
     * @param {Object} client - Discord客户端
     * @returns {Promise<Object>} 创建的辩诉帖子
     */
    static async createDebateThread(process, guildConfig, client) {
        const debateForum = await client.channels.fetch(guildConfig.courtSystem.debateForumId);

        // 获取申请人和目标用户
        const [executor, target] = await Promise.all([
            client.users.fetch(process.details.executorId || process.executorId).catch(() => null),
            client.users.fetch(process.targetId).catch(() => null),
        ]);

        const debateThread = await debateForum.threads.create({
            name: `对 ${target?.username || '未知用户'} 的${
                process.details.embed?.title?.replace('申请', '辩诉') || '辩诉帖'
            }`,
            message: {
                embeds: [
                    {
                        ...(process.details.embed || {}),
                        title: `对 ${target?.tag || '未知用户'} 的${
                            process.details.embed?.title?.replace('申请', '辩诉') || '辩诉帖'
                        }`,
                        fields: [...(process.details.embed?.fields?.filter(f => f) || [])],
                    },
                ],
            },
            appliedTags: guildConfig.courtSystem.debateTagId ? [guildConfig.courtSystem.debateTagId] : [],
        });

        // 记录辩诉帖创建日志
        logTime(
            `已创建辩诉帖：${
                process.type === 'appeal'
                    ? `${target?.tag || '未知用户'} 对 ${executor?.tag || '未知管理员'} 的处罚上诉`
                    : `${executor?.tag || '未知管理员'} 对 ${target?.tag || '未知用户'} 的处罚申请`
            }`,
        );

        // 发送初始消息
        if (executor && target) {
            const notifyContent =
                process.type === 'appeal'
                    ? [
                          '上诉辩诉帖已创建，请双方当事人注意查看。',
                          `- 上诉人：<@${target.id}>`,
                          `- 原处罚执行人：<@${executor.id}>`,
                      ].join('\n')
                    : [
                          '处罚申请辩诉帖已创建，请双方当事人注意查看。',
                          `- 申请人：<@${executor.id}>`,
                          `- 被告：<@${target.id}>`,
                      ].join('\n');

            await debateThread.send({
                content: notifyContent,
            });
        }

        return debateThread;
    }

    /**
     * 更新议事消息的UI
     * @param {Object} message - Discord消息对象
     * @param {Object} process - 流程记录
     * @param {Object} options - 更新选项
     * @param {Object} [options.debateThread] - 辩诉帖子对象（可选）
     * @param {boolean} [options.isExpired] - 是否已过期
     * @param {boolean} [options.removeComponents] - 是否移除交互组件
     * @returns {Promise<void>}
     */
    static async updateCourtMessage(message, process, options = {}) {
        const { debateThread, isExpired, removeComponents = false } = options;
        const embed = message.embeds[0];
        const updatedFields = [...embed.fields];

        // 更新支持人数字段
        const supporters = process.supporters;
        const supportCount = supporters.length;
        const supportCountField = updatedFields.find(field => field.name === '支持人数');

        if (supportCountField) {
            const fieldIndex = updatedFields.findIndex(field => field.name === '支持人数');
            updatedFields[fieldIndex] = {
                name: '支持人数',
                value: `${supportCount} 位议员`,
                inline: true,
            };
        } else {
            updatedFields.push({
                name: '支持人数',
                value: `${supportCount} 位议员`,
                inline: true,
            });
        }

        const updatedEmbed = {
            ...embed.data,
            fields: updatedFields,
        };

        // 更新消息描述
        if (isExpired) {
            updatedEmbed.description = `${embed.description}\n\n❌ 议事已过期，未达到所需支持人数`;
        } else if (debateThread) {
            updatedEmbed.description = `${embed.description}\n\n✅ 已达到所需支持人数，辩诉帖已创建：${debateThread.url}`;
        }

        // 更新消息
        await message.edit({
            embeds: [updatedEmbed],
            components: removeComponents || debateThread || isExpired ? [] : message.components,
        });
    }

    /**
     * 获取或创建议事流程
     * @param {Object} message - Discord消息对象
     * @param {string} targetId - 目标用户ID
     * @param {string} type - 处罚类型 ('mute')
     * @param {Object} guildConfig - 服务器配置
     * @returns {Promise<{process: Object|null, error: string|null}>} 流程对象和可能的错误信息
     */
    static async getOrCreateProcess(message, targetId, type, guildConfig) {
        try {
            // 如果是ban类型，直接返回错误
            if (type === 'ban') {
                return { process: null, error: '永封处罚不支持上诉' };
            }

            let process = await ProcessModel.getProcessByMessageId(message.id);

            if (!process) {
                // 检查是否已存在活跃流程
                const userProcesses = await ProcessModel.getUserProcesses(targetId, false);
                const activeProcess = userProcesses.find(
                    p => p.type === `court_${type}` && ['pending', 'in_progress'].includes(p.status),
                );

                if (activeProcess) {
                    return { error: '已存在相关的议事流程' };
                }

                // 从按钮的customId中获取执行者ID
                const supportButton = message.components[0]?.components[0];
                if (!supportButton) {
                    return { process: null, error: '无法找到支持按钮信息' };
                }

                const [, , , executorId] = supportButton.customId.split('_');
                if (!executorId) {
                    return { process: null, error: '无法找到申请人信息' };
                }

                process = await ProcessModel.createCourtProcess({
                    type: `court_${type}`,
                    targetId,
                    executorId: executorId,
                    messageId: message.id,
                    expireAt: Date.now() + guildConfig.courtSystem.summitDuration,
                    details: {
                        embed: message.embeds[0],
                    },
                });

                // 设置初始状态为in_progress
                await ProcessModel.updateStatus(process.id, 'in_progress');
            }

            return { process, error: null };
        } catch (error) {
            logTime(`获取或创建议事流程失败: ${error.message}`, true);
            return { process: null, error: '处理流程时出错，请稍后重试' };
        }
    }

    /**
     * 处理流程到期
     * @param {Object} process - 流程记录
     * @param {Object} client - Discord客户端
     * @returns {Promise<void>}
     */
    static async handleProcessExpiry(process, client) {
        try {
            // Early return 检查
            if (!process.type.startsWith('court_') && !process.type.startsWith('appeal') && process.type !== 'vote') {
                return;
            }

            // 获取最新的流程数据
            const currentProcess = await ProcessModel.getProcessById(process.id);
            if (!currentProcess) {
                logTime(`无法获取流程数据: ${process.id}`, true);
                return;
            }

            // 解析流程详情
            const details = ProcessModel.tryParseJSON(currentProcess.details);
            if (!details?.embed) {
                logTime(`无法获取流程详情: ${process.id}`, true);
                return;
            }

            // 获取主服务器配置
            const mainGuildConfig = client.guildManager
                .getGuildIds()
                .map(id => client.guildManager.getGuildConfig(id))
                .find(config => config?.serverType === 'Main server');

            if (!mainGuildConfig?.courtSystem?.enabled) {
                logTime('主服务器未启用议事系统', true);
                return;
            }

            // 获取并更新原始消息
            const courtChannel = await client.channels.fetch(mainGuildConfig.courtSystem.courtChannelId);
            if (!courtChannel) {
                logTime(`无法获取议事频道: ${mainGuildConfig.courtSystem.courtChannelId}`, true);
                return;
            }

            const message = await courtChannel.messages.fetch(currentProcess.messageId).catch(() => null);

            // 更新原消息
            if (message) {
                const originalEmbed = message.embeds[0];
                await message.edit({
                    embeds: [
                        {
                            ...originalEmbed.data,
                            description: `${originalEmbed.description}\n\n❌ 议事已过期，未达到所需支持人数`,
                        },
                    ],
                    components: [],
                });
                logTime(`更新过期消息成功: ${currentProcess.id}`);
            }

            // 如果是vote类型，更新原帖子状态
            if (currentProcess.type === 'vote' && details.threadId) {
                await client.channels
                    .fetch(details.threadId)
                    .then(thread => thread?.messages.fetch(currentProcess.statusMessageId))
                    .then(statusMessage =>
                        statusMessage?.edit({
                            embeds: [
                                {
                                    color: 0xff0000,
                                    title: '📢 议事投票已过期',
                                    description: [
                                        '此帖的议事投票已过期。',
                                        '',
                                        '**议事详情：**',
                                        `- 提交人：<@${currentProcess.executorId}>`,
                                        `- 议事消息：[点击查看](${message?.url || thread?.url})`,
                                        '',
                                        '当前状态：未达到所需支持人数，议事已结束',
                                    ].join('\n'),
                                    timestamp: new Date(),
                                    footer: {
                                        text: '如需重新议事，请管理员重新提交',
                                    },
                                },
                            ],
                        }),
                    )
                    .then(() => logTime(`已更新议事状态消息: ${currentProcess.id}`))
                    .catch(() => logTime(`更新议事状态消息失败: ${currentProcess.id}`, true));
            }

            // 更新流程状态
            await ProcessModel.updateStatus(currentProcess.id, 'completed', {
                result: 'cancelled',
                reason: '议事流程已过期，未达到所需支持人数',
            });
        } catch (error) {
            logTime(`处理议事流程到期失败: ${error.message}`, true);
            throw error; // 向上抛出错误，让调用者处理
        }
    }

    /**
     * 添加支持者并处理后续流程
     * @param {string} messageId - 议事消息ID
     * @param {string} userId - 支持者ID
     * @returns {Promise<{process: Object, supportCount: number, replyContent: string}>} 更新后的流程记录和支持人数
     */
    static async addSupporter(messageId, userId) {
        try {
            const process = await ProcessModel.getProcessByMessageId(messageId);
            if (!process) {
                throw new Error('议事流程不存在');
            }

            // 检查是否已经支持过
            const hasSupported = process.supporters.includes(userId);

            // 更新支持者列表（添加或移除）
            const updatedProcess = await dbManager.updateArrayField('processes', 'supporters', userId, { messageId });

            // 获取更新后的支持者列表
            const supporters = ProcessModel.tryParseJSON(updatedProcess.supporters, '[]', 'addSupporter');
            let replyContent;

            // 根据流程类型设置正确的文本
            const processTypeText =
                {
                    court_mute: '禁言申请',
                    court_ban: '永封申请',
                    court_vote: '议事',
                    court_appeal: '上诉',
                }[process.type] || '议事';

            if (hasSupported) {
                // 移除支持的情况
                replyContent = `✅ 你已移除对此${processTypeText}的支持，当前共有 ${supporters.length} 位议员支持`;
                logTime(`用户 ${userId} 移除了对议事 ${messageId} 的支持`);
            } else {
                // 添加支持的情况
                replyContent = `✅ 你已支持此${processTypeText}，当前共有 ${supporters.length} 位议员支持`;
                logTime(`用户 ${userId} 支持了议事 ${messageId}`);
            }

            // 清除缓存
            ProcessModel._clearRelatedCache(process.targetId, process.executorId, process.id, messageId);

            const finalProcess = await ProcessModel.getProcessByMessageId(messageId);

            return { process: finalProcess, supportCount: supporters.length, replyContent };
        } catch (error) {
            logTime(`添加/移除支持者失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 处理议事完成
     * @param {Object} process - 流程记录
     * @param {Object} guildConfig - 服务器配置
     * @param {Object} client - Discord客户端
     * @returns {Promise<{debateThread: Object|null, error: string|null}>}
     */
    static async handleCourtComplete(process, guildConfig, client) {
        try {
            switch (process.type) {
                case 'court_mute': {
                    // 创建禁言辩诉帖
                    const debateThread = await this.createDebateThread(process, guildConfig, client);

                    // 更新流程状态为completed
                    await ProcessModel.updateStatus(process.id, 'completed', {
                        result: 'approved',
                        reason: '已达到所需支持人数，辩诉帖已创建',
                        debateThreadId: debateThread.id,
                    });

                    // 发送通知
                    try {
                        const [executor, target] = await Promise.all([
                            client.users.fetch(process.executorId).catch(() => null),
                            client.users.fetch(process.targetId).catch(() => null),
                        ]);

                        if (executor && target) {
                            const notifyContent = `✅ 您的处罚申请已获得足够议员支持，辩诉帖已创建：${debateThread.url}`;
                            await executor.send({ content: notifyContent, flags: ['Ephemeral'] });
                            await target.send({ content: notifyContent, flags: ['Ephemeral'] });
                        }
                    } catch (error) {
                        logTime(`发送通知失败: ${error.message}`, true);
                    }

                    return { debateThread, error: null };
                }

                case 'appeal': {
                    // 解析details，确保它是一个对象
                    let details;
                    try {
                        details =
                            typeof process.details === 'string'
                                ? JSON.parse(process.details || '{}')
                                : process.details || {};
                    } catch (error) {
                        logTime(`解析process.details失败: ${error.message}`, true);
                        details = {};
                    }

                    const punishmentId = details?.punishmentId;
                    if (!punishmentId) {
                        return { error: '无法找到相关处罚记录' };
                    }

                    // 获取处罚记录
                    const punishment = await PunishmentModel.getPunishmentById(parseInt(punishmentId));
                    if (!punishment) {
                        return { error: '找不到相关的处罚记录' };
                    }

                    logTime(`处罚记录状态: ID=${punishmentId}, status=${punishment.status}`);

                    // 检查处罚是否已过期
                    const now = Date.now();
                    const isPunishmentExpired =
                        punishment.duration > 0 && punishment.createdAt + punishment.duration <= now;

                    // 获取目标用户
                    const target = await client.users.fetch(process.targetId).catch(() => null);
                    if (!target) {
                        return { error: '无法获取目标用户信息' };
                    }

                    // 如果处罚未过期，在所有服务器中移除处罚
                    if (!isPunishmentExpired) {
                        await revokePunishmentInGuilds(client, punishment, target, '上诉申请通过', { isAppeal: true });
                    }

                    // 在主服务器添加辩诉通行身份组
                    const mainGuild = await client.guilds.fetch(guildConfig.id).catch(() => null);
                    if (mainGuild && guildConfig.courtSystem.appealDebateRoleId) {
                        const targetMember = await mainGuild.members.fetch(target.id).catch(() => null);
                        if (targetMember) {
                            await targetMember.roles
                                .add(guildConfig.courtSystem.appealDebateRoleId, '上诉申请通过')
                                .then(() => logTime(`已添加用户 ${target.tag} 的辩诉通行身份组`))
                                .catch(error => logTime(`添加辩诉通行身份组失败: ${error.message}`, true));
                        }
                    }

                    // 创建辩诉帖
                    const debateThread = await this.createDebateThread(process, guildConfig, client);

                    // 更新流程状态为completed
                    await ProcessModel.updateStatus(process.id, 'completed', {
                        result: 'approved',
                        reason: '已达到所需支持人数，辩诉帖已创建',
                        debateThreadId: debateThread.id,
                    });

                    // 发送通知
                    try {
                        const executor = await client.users.fetch(punishment.executorId).catch(() => null);
                        if (executor && target) {
                            const notifyContent = [
                                '✅ 有关您的上诉申请已获得足够议员支持。',
                                isPunishmentExpired ? '- 另外，处罚已过期' : '- 上诉期间处罚限制已解除',
                                '- 已为您添加辩诉通行身份组',
                                `辩诉帖已创建：${debateThread.url}`,
                            ].join('\n');

                            await executor.send({ content: notifyContent, flags: ['Ephemeral'] });
                            await target.send({ content: notifyContent, flags: ['Ephemeral'] });
                        }
                    } catch (error) {
                        logTime(`发送通知失败: ${error.message}`, true);
                    }

                    return { debateThread, error: null };
                }

                case 'vote': {
                    // 更新流程状态为completed
                    await ProcessModel.updateStatus(process.id, 'completed', {
                        result: 'approved',
                        reason: '已达到所需支持人数，等待投票执行',
                    });

                    // 获取消息并更新
                    const message = await client.channels
                        .fetch(guildConfig.courtSystem.courtChannelId)
                        .then(channel => channel.messages.fetch(process.messageId))
                        .catch(() => null);

                    if (message) {
                        const embed = message.embeds[0];
                        const updatedEmbed = {
                            ...embed.data,
                            description: `${embed.description}\n\n✅ 已达到所需支持人数，等待投票执行`,
                        };

                        await message.edit({
                            embeds: [updatedEmbed],
                            components: [], // 移除支持按钮
                        });
                    }

                    // 更新原帖子中的状态消息
                    try {
                        const { threadId } = process.details;
                        if (threadId && process.statusMessageId) {
                            await client.channels
                                .fetch(threadId)
                                .then(thread => thread?.messages.fetch(process.statusMessageId))
                                .then(statusMessage =>
                                    statusMessage?.edit({
                                        embeds: [
                                            {
                                                color: 0x00ff00,
                                                title: '📢 议事投票已获得支持',
                                                description: [
                                                    '此帖的议事投票已获得足够议员支持。',
                                                    '',
                                                    '**议事详情：**',
                                                    `- 提交人：<@${process.executorId}>`,
                                                    `- 议事消息：[点击查看](${message?.url || thread?.url})`,
                                                    '',
                                                    '当前状态：等待投票执行',
                                                ].join('\n'),
                                                timestamp: new Date(),
                                                footer: {
                                                    text: '投票将由管理员稍后执行',
                                                },
                                            },
                                        ],
                                    }),
                                )
                                .then(() => logTime(`已更新议事状态消息: ${process.id}`))
                                .catch(() => logTime(`更新议事状态消息失败: ${process.id}`, true));
                        }
                    } catch (error) {
                        logTime(`更新原帖子状态消息失败: ${error.message}`, true);
                    }

                    // 发送通知
                    try {
                        const [executor, target] = await Promise.all([
                            client.users.fetch(process.executorId).catch(() => null),
                            client.users.fetch(process.targetId).catch(() => null),
                        ]);

                        if (executor && target) {
                            // 构建议事消息链接
                            let messageUrl = message?.url;
                            if (!messageUrl && process.messageId) {
                                messageUrl = `https://discord.com/channels/${guildConfig.id}/${guildConfig.courtSystem.courtChannelId}/${process.messageId}`;
                            }

                            const notifyContent = [
                                '✅ 议事投票已获得足够议员支持',
                                '',
                                '**议事详情：**',
                                `- 帖子：${process.details.embed.title}`,
                                messageUrl ? `- 议事消息：${messageUrl}` : null,
                                '',
                                '当前状态：等待投票执行',
                            ]
                                .filter(Boolean)
                                .join('\n');

                            await executor.send({ content: notifyContent, flags: ['Ephemeral'] });
                            await target.send({ content: notifyContent, flags: ['Ephemeral'] });
                        }
                    } catch (error) {
                        logTime(`发送通知失败: ${error.message}`, true);
                    }

                    return { error: null };
                }

                default:
                    return { error: '不支持的议事类型' };
            }
        } catch (error) {
            logTime(`处理议事完成失败: ${error.message}`, true);
            return { error: '处理议事完成时出错，请稍后重试' };
        }
    }
}

export default CourtService;
