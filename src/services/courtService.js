import { dbManager } from '../db/dbManager.js';
import { ProcessModel } from '../db/models/processModel.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { setupDebateParticipantRoles } from '../services/roleApplication.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';
import PunishmentService from './punishmentService.js';
import { VoteService } from './voteService.js';

class CourtService {
    /**
     * 创建辩诉帖子
     * @param {Object} process - 流程记录
     * @param {Object} guildConfig - 服务器配置
     * @param {Object} client - Discord客户端
     * @returns {Promise<Object>} 创建的辩诉帖子
     */
    static async createDebateThread(process, guildConfig, client) {
        const debateForum = await client.channels.fetch(guildConfig.courtSystem.debateChannelId);

        // 获取申请人和目标用户
        const [executor, target] = await Promise.all([
            client.users.fetch(process.details.executorId || process.executorId).catch(() => null),
            client.users.fetch(process.targetId).catch(() => null),
        ]);

        let threadTitle, notifyContent;

        switch (process.type) {
            case 'appeal': {
                threadTitle = `${target?.username || '未知用户'}对处罚的上诉`;

                notifyContent = [
                    '上诉辩诉已创建，请双方当事人注意查看。',
                    '请记住：发言的目的是陈述事实，不是说服他人。最终结果只根据得票多寡自动判定，与违规与否无直接关系。',
                    '**另外注意：**',
                    '1. 发言间隔1分钟，仅有赛博公仆和当事人才能在此发言。',
                    '2. 一人最多5条消息，允许编辑，发现恶意刷楼请 <@&1337450755791261766> 举报。',
                    '3. 不同辩诉贴之间禁止串门，恶意串门拱火的直接永封。',
                    '4. 上诉人的已验证身份组暂时吊销，双方亦不得继续申请上庭，直至辩诉结束。',
                    `**上诉人：**<@${target?.id}>`,
                    `**原处罚执行人：**<@${executor?.id}>`,
                ].join('\n');
                break;
            }

            default: {
                // 处理以 court_ 开头的类型
                if (process.type.startsWith('court_')) {
                    const punishmentType =
                        process.type === 'court_ban'
                            ? '永封处罚'
                            : process.type === 'court_impeach'
                            ? '弹劾'
                            : '禁言处罚';

                    threadTitle = `对 ${target?.username || '未知用户'} 的${punishmentType}申请`;

                    notifyContent = [
                        '处罚申请已创建，请双方当事人注意查看。',
                        '请记住：发言的目的是陈述事实，不是说服他人。最终结果只根据得票多寡自动判定，与违规与否无直接关系。',
                        '**另外注意：**',
                        '1. 发言间隔1分钟，仅有赛博公仆和当事人才能在此发言。',
                        '2. 一人最多5条消息，允许编辑，发现恶意刷楼请 <@&1337450755791261766> 举报。',
                        '3. 不同辩诉贴之间禁止串门，恶意串门拱火的直接永封。',
                        '4. 被告的已验证身份组暂时吊销，双方亦不得继续申请上庭，直至辩诉结束。',
                        `**申请人：**<@${executor?.id}>`,
                        `**被告：**<@${target?.id}>`,
                    ].join('\n');
                } else {
                    throw new Error('不支持的议事类型');
                }
                break;
            }
        }

        // 创建辩诉帖
        const debateThread = await debateForum.threads.create({
            name: threadTitle,
            message: {
                embeds: [
                    {
                        ...(process.details.embed || {}),
                        title: threadTitle,
                        fields: [...(process.details.embed?.fields?.filter(f => f) || [])],
                    },
                ],
            },
            appliedTags: guildConfig.courtSystem.debateTagId ? [guildConfig.courtSystem.debateTagId] : [],
        });

        // 创建投票消息
        const voteMessage = await debateThread.send({
            embeds: [
                {
                    color: 0x5865f2,
                    title: '📊 议会辩诉投票',
                    description: [
                        `⏳ 投票截止：<t:${Math.floor((Date.now() + guildConfig.courtSystem.voteDuration) / 1000)}:R>`,
                        `━━━━━━━━━━━━━━━━⊰❖⊱━━━━━━━━━━━━━━━━`,
                        '',
                        `🔴 **红方诉求：** ${
                            process.type === 'appeal'
                                ? `解除对 <@${target?.id}> 的处罚`
                                : process.type === 'court_impeach'
                                ? `弹劾管理员 <@${target?.id}>`
                                : `对 <@${target?.id}> 执行${process.type === 'court_ban' ? '永封' : '禁言'}`
                        }`,
                        '',
                        `🔵 **蓝方诉求：** ${process.type === 'appeal' ? '维持原判' : '驳回处罚申请'}`,
                        '',
                        `━━━━━━━━━━━━━━━━⊰❖⊱━━━━━━━━━━━━━━━━━`,
                        '',
                        '🔴 ⬛⬛⬛⬛⬛⬛ ⚖️ ⬛⬛⬛⬛⬛⬛ 🔵',
                        '',
                        `🔒 投票将保持匿名直至投票结束`,
                    ].join('\n'),
                    footer: {
                        text: `点击另一色支持按钮可以换边`,
                    },
                    timestamp: new Date(),
                },
            ],
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 2,
                            style: 4,
                            label: '支持红方',
                            emoji: { name: '🔴' },
                            custom_id: `vote_red_pending`,
                        },
                        {
                            type: 2,
                            style: 1,
                            label: '支持蓝方',
                            emoji: { name: '🔵' },
                            custom_id: `vote_blue_pending`,
                        },
                    ],
                },
            ],
        });

        // 创建投票
        const vote = await VoteService.createVoteForProcess(
            process,
            guildConfig,
            {
                messageId: voteMessage.id,
                threadId: debateThread.id,
            },
            client,
        );

        // 更新投票按钮的custom_id
        await voteMessage.edit({
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 2,
                            style: 4,
                            label: '支持红方',
                            custom_id: `vote_red_${vote.id}`,
                        },
                        {
                            type: 2,
                            style: 1,
                            label: '支持蓝方',
                            custom_id: `vote_blue_${vote.id}`,
                        },
                    ],
                },
            ],
        });

        // 调度投票状态更新
        await globalTaskScheduler.getScheduler('vote').scheduleVote(vote, client);

        // 发送@通知消息
        if (executor && target) {
            await debateThread.send({
                content: notifyContent,
            });
        }

        // 记录辩诉帖创建日志
        logTime(
            `已创建辩诉帖：${
                process.type === 'appeal'
                    ? `${target?.tag || '未知用户'} 对 ${executor?.tag || '未知管理员'} 的处罚上诉`
                    : `${executor?.tag || '未知议员'} 对 ${target?.tag || '未知用户'} 的处罚申请`
            }`,
        );

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
        const updatedEmbed = { ...embed.data };
        const updatedFields = [...embed.fields];

        // 1. 首先处理支持人数字段（无论何种情况都应该保留或更新）
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

        // 2. 根据状态更新消息内容
        if (isExpired) {
            // 过期情况：保留原始字段，只更新描述
            updatedEmbed.fields = updatedFields;
            updatedEmbed.description = `${embed.description}\n\n❌ 议事已过期，未达到支持数`;
        } else if (debateThread) {
            // 成功完成情况
            if (process.type === 'debate') {
                // debate类型特殊处理：简化消息，清空字段
                updatedEmbed.fields = [];
                updatedEmbed.description = `${embed.description}\n\n✅ 已达到支持数，议案讨论帖已创建：${debateThread.url}`;
            } else {
                // 其他类型：保留所有字段
                updatedEmbed.fields = updatedFields;
                updatedEmbed.description = `${embed.description}\n\n✅ 已达到支持数，辩诉帖已创建：${debateThread.url}`;
            }
        } else {
            // 正常进行中的情况：保留所有字段
            updatedEmbed.fields = updatedFields;
        }

        // 3. 更新消息
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
            if (!process.type.startsWith('court_') && process.type !== 'debate') {
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
            const mainGuildConfig = client.guildManager.getMainServerConfig();

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
                    court_impeach: '弹劾申请',
                    debate: '议案议事',
                    appeal: '处罚上诉',
                    vote: '投票',
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
                case 'court_mute':
                case 'court_ban':
                case 'court_impeach': {
                    // 创建辩诉帖
                    const debateThread = await this.createDebateThread(process, guildConfig, client);

                    // 设置辩诉参与者身份组
                    await setupDebateParticipantRoles(
                        client,
                        guildConfig,
                        process.executorId,
                        process.targetId,
                        '处罚申请辩诉通行'
                    );

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
                            // 确定处罚类型文本
                            const punishmentTypeText = {
                                court_mute: '禁言',
                                court_ban: '永封',
                                court_impeach: '弹劾',
                            }[process.type] || '处罚';

                            // 申请人的通知
                            const executorEmbed = {
                                color: 0x5865f2,
                                title: `✅ ${punishmentTypeText}申请已获支持`,
                                description: `您对 ${target.username} 的${punishmentTypeText}申请已获得足够议员支持`,
                                fields: [
                                    {
                                        name: '辩诉帖链接',
                                        value: `[点击查看辩诉帖](${debateThread.url})`,
                                    },
                                    {
                                        name: '注意事项',
                                        value: '1. 辩诉期间被告的已验证身份组将被暂时移除\n2. 每位参与者最多发送5条消息，间隔1分钟',
                                    },
                                ],
                                timestamp: new Date(),
                                footer: {
                                    text: '创作者议会通知',
                                },
                            };

                            // 被告的通知
                            const targetEmbed = {
                                color: 0xff5555,
                                title: `⚠️ 收到${punishmentTypeText}申请`,
                                description: `有人对您发起了${punishmentTypeText}申请，并已获得足够议员支持`,
                                fields: [
                                    {
                                        name: '辩诉帖链接',
                                        value: `[点击查看辩诉帖](${debateThread.url})`,
                                    },
                                    {
                                        name: '注意事项',
                                        value: '1. 辩诉期间您的已验证身份组将被暂时移除\n2. 每位参与者最多发送5条消息，间隔1分钟\n3. 您在24小时内可以在辩诉帖中进行申辩',
                                    },
                                ],
                                timestamp: new Date(),
                                footer: {
                                    text: '创作者议会通知',
                                },
                            };

                            await executor.send({ embeds: [executorEmbed] });
                            await target.send({ embeds: [targetEmbed] });
                        }
                    } catch (error) {
                        logTime(`发送通知失败: ${error.message}`, true);
                    }

                    return { debateThread, error: null };
                }

                case 'appeal': {
                    // 解析details，确保它是一个对象
                    const details = ProcessModel.tryParseJSON(process.details, '{}', 'appeal_details');

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
                        await PunishmentService.revokePunishmentInGuilds(client, punishment, target, '上诉申请通过', { isAppeal: true });
                    }

                    // 设置辩诉参与者身份组
                    await setupDebateParticipantRoles(
                        client,
                        guildConfig,
                        punishment.executorId,
                        process.targetId,
                        '上诉申请通过'
                    );

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
                            // 上诉人的通知
                            const targetEmbed = {
                                color: 0x00ff00,
                                title: '✅ 上诉申请已获支持',
                                description: `您的上诉申请已获得足够议员支持`,
                                fields: [
                                    {
                                        name: '处罚状态',
                                        value: isPunishmentExpired ? '处罚已过期' : '上诉期间处罚限制已解除',
                                    },
                                    {
                                        name: '辩诉帖链接',
                                        value: `[点击查看辩诉帖](${debateThread.url})`,
                                    },
                                    {
                                        name: '注意事项',
                                        value: '1. 您的已验证身份组将被暂时移除，上诉结束恢复\n2. 每位参与者最多发送5条消息，间隔1分钟',
                                    },
                                ],
                                timestamp: new Date(),
                                footer: {
                                    text: '创作者议会通知',
                                },
                            };

                            // 原处罚执行人的通知
                            const executorEmbed = {
                                color: 0xffaa00,
                                title: `⚠️ 处罚上诉通知`,
                                description: `${target.username} 对您执行的处罚提出的上诉已获得足够议员支持`,
                                fields: [
                                    {
                                        name: '处罚状态',
                                        value: isPunishmentExpired ? '原处罚已过期' : '上诉期间处罚限制已临时解除',
                                    },
                                    {
                                        name: '辩诉帖链接',
                                        value: `[点击查看辩诉帖](${debateThread.url})`,
                                    },
                                    {
                                        name: '注意事项',
                                        value: '1. 上诉人的已验证身份组将被暂时移除\n2. 每位参与者最多发送5条消息，间隔1分钟',
                                    },
                                ],
                                timestamp: new Date(),
                                footer: {
                                    text: '创作者议会通知',
                                },
                            };

                            await target.send({ embeds: [targetEmbed] });
                            await executor.send({ embeds: [executorEmbed] });
                        }
                    } catch (error) {
                        logTime(`发送通知失败: ${error.message}`, true);
                    }

                    return { debateThread, error: null };
                }

                case 'debate': {
                    // 如果是 debate 类型，创建论坛帖子
                    try {
                        // 检查论坛频道是否配置
                        if (!guildConfig.courtSystem.motionChannelId) {
                            return { error: '未配置议事论坛频道' };
                        }

                        // 获取论坛频道
                        const forumChannel = await client.channels.fetch(guildConfig.courtSystem.motionChannelId);
                        if (!forumChannel) {
                            return { error: '无法访问议事论坛频道' };
                        }

                        // 从流程详情中获取议事内容
                        const { title, reason, motion, implementation, voteTime } = process.details;

                        // 创建帖子内容
                        const threadContent = [
                            `-# 提议人: <@${process.targetId}>`,
                            '### 📝 提案原因',
                            reason,
                            '### 📝 议案动议',
                            motion,
                            '### 🔧 执行方案',
                            implementation,
                            `### 🕰️ 投票时间：${voteTime}`,
                        ].join('\n');

                        // 创建论坛帖子
                        const thread = await forumChannel.threads.create({
                            name: title,
                            message: {
                                content: threadContent,
                                allowedMentions: { users: [process.targetId] }, // 允许 @ 提议者
                            },
                            appliedTags: guildConfig.courtSystem.motionTagId
                                ? [guildConfig.courtSystem.motionTagId]
                                : [],
                            reason: `创建议案`,
                        });

                        // 发送私信通知给提议者
                        try {
                            const user = await client.users.fetch(process.targetId);
                            await user.send({
                                embeds: [
                                    {
                                        color: 0x00ff00,
                                        title: '✅ 提案成功',
                                        description: `您的提案"${title}"已通过预审核，已创建帖子以供进一步讨论。`,
                                        fields: [
                                            {
                                                name: '帖子链接',
                                                value: `[点击查看](${thread.url})`,
                                            },
                                        ],
                                        timestamp: new Date(),
                                        footer: {
                                            text: '创作者议会通知',
                                        },
                                    },
                                ],
                            });
                        } catch (error) {
                            logTime(`向用户 ${process.targetId} 发送议事成功通知失败: ${error.message}`, true);
                        }

                        // 更新流程状态
                        await ProcessModel.updateStatus(process.id, 'completed', {
                            result: 'approved',
                            reason: '已达到所需支持人数，开启讨论',
                            debateThreadId: thread.id,
                        });

                        return { debateThread: thread, error: null };
                    } catch (error) {
                        logTime(`创建议事论坛帖子失败: ${error.message}`, true);
                        return { error: '创建论坛帖子失败' };
                    }
                }
                default:
                    return { error: '不支持的议事类型' };
            }
        } catch (error) {
            logTime(`处理议事完成失败: ${error.message}`, true);
            return { error: '处理议事完成时出错，请稍后重试' };
        }
    }

    /**
     * 处理议事区支持按钮
     * @param {ButtonInteraction} interaction - Discord按钮交互对象
     * @param {string} type - 议事类型 ('mute' | 'ban' | 'appeal' | 'debate' | 'impeach')
     * @returns {Promise<void>}
     */
    static async handleSupport(interaction, type) {
        try {

            // 检查议事系统是否启用
            const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
            if (!guildConfig?.courtSystem?.enabled) {
                return await interaction.editReply({
                    content: '❌ 此服务器未启用议事系统',
                });
            }

            // 检查是否为议员
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!member.roles.cache.has(guildConfig.roleApplication?.senatorRoleId)) {
                return await interaction.editReply({
                    content: '❌ 只有议员可以参与议事投票',
                });
            }

            // 解析按钮ID获取目标用户ID
            const [, , targetId] = interaction.customId.split('_');

            // 使用事务包装数据库操作
            const result = await dbManager.transaction(async () => {
                // 获取或创建议事流程
                const { process, error } = await this.getOrCreateProcess(
                    interaction.message,
                    targetId,
                    type,
                    guildConfig,
                );

                if (error) {
                    return { error };
                }

                // 使用CourtService添加支持者
                const {
                    process: updatedProcess,
                    supportCount,
                    replyContent,
                } = await this.addSupporter(interaction.message.id, interaction.user.id);

                return { updatedProcess, supportCount, replyContent };
            });

            if (result.error) {
                return await interaction.editReply({
                    content: `❌ ${result.error}`,
                });
            }

            const { updatedProcess, supportCount, replyContent } = result;
            let finalReplyContent = replyContent;

            // 检查是否达到所需支持数量
            if (supportCount === guildConfig.courtSystem.requiredSupports) {
                try {
                    const { debateThread, error: completeError } = await this.handleCourtComplete(
                        updatedProcess,
                        guildConfig,
                        interaction.client,
                    );

                    if (completeError) {
                        return await interaction.editReply({
                            content: `❌ ${completeError}`,
                        });
                    }

                    // 更新消息
                    const message = await interaction.message.fetch();
                    await this.updateCourtMessage(message, updatedProcess, { debateThread });
                } catch (error) {
                    logTime(`处理议事完成失败: ${error.message}`, true);
                    return await interaction.editReply({
                        content: '❌ 处理议事完成时出错，请稍后重试',
                    });
                }
            } else {
                // 更新消息
                const message = await interaction.message.fetch();
                await this.updateCourtMessage(message, updatedProcess);
            }

            // 发送最终确认消息
            return await interaction.editReply({
                content: finalReplyContent,
            });
        } catch (error) {
            // 处理错误
            logTime(`处理议事支持按钮出错: ${error.message}`, true);
            await interaction.editReply({
                content: '❌ 处理支持请求时出错，请稍后重试',
            });
        }
    }

    /**
     * 撤销流程通用方法
     * @param {Object} options - 撤销选项
     * @param {string|number} options.processId - 流程ID
     * @param {string} [options.messageId] - 消息ID
     * @param {Object} options.revokedBy - 撤销操作执行人
     * @param {boolean} [options.isAdmin=false] - 是否为管理员操作
     * @param {string} [options.originalMessageId] - 上诉原始消息ID
     * @param {Object} options.client - Discord客户端
     * @param {Object} [options.user] - 用户对象（用于上诉撤销）
     * @returns {Promise<{success: boolean, message: string}>} 操作结果
     */
    static async revokeProcess(options) {
        const {
            processId,
            messageId,
            revokedBy,
            isAdmin = false,
            originalMessageId,
            client,
            user
        } = options;

        try {
            // 获取流程记录
            const process = messageId
                ? await ProcessModel.getProcessByMessageId(messageId)
                : await ProcessModel.getProcessById(parseInt(processId));

            if (!process) {
                return { success: false, message: '找不到相关流程记录' };
            }

            // 检查流程状态
            if (process.status === 'completed' || process.status === 'cancelled') {
                const message = process.type === 'appeal'
                    ? '该上诉已结束，无法撤销'
                    : '该流程已结束，无法撤销';

                // 如果是上诉，移除上诉按钮
                if (process.type === 'appeal' && originalMessageId && user) {
                    await this.removeAppealButton(user, originalMessageId);
                }

                return { success: false, message };
            }

            // 尝试删除原议事消息
            if (process.messageId) {
                try {
                    // 获取主服务器配置
                    const mainGuildConfig = client.guildManager.getMainServerConfig();

                    if (mainGuildConfig?.courtSystem?.courtChannelId) {
                        const channel = await client.channels.fetch(mainGuildConfig.courtSystem.courtChannelId);
                        const message = await channel.messages.fetch(process.messageId);
                        await message.delete();
                    }
                } catch (error) {
                    logTime(`删除流程消息失败: ${error.message}`, true);
                    // 继续执行，不影响主流程
                }
            }

            // 更新流程状态
            const reason = isAdmin
                ? `由 ${revokedBy.tag} 紧急撤销`
                : process.type === 'appeal'
                    ? `由申请人 ${revokedBy.tag} 撤销上诉`
                    : `由申请人 ${revokedBy.tag} 撤销`;

            await ProcessModel.updateStatus(process.id, 'cancelled', {
                result: 'cancelled',
                reason,
            });

            // 取消计时器
            await globalTaskScheduler.getScheduler('process').cancelProcess(process.id);

            // 处理上诉特殊逻辑
            if (process.type === 'appeal' && originalMessageId && user) {
                await this.removeAppealButton(user, originalMessageId);
            }

            // 记录操作日志
            const logMessage = isAdmin
                ? `议事流程 ${process.id} 已被 ${revokedBy.tag} 紧急撤销`
                : `${process.type} 流程 ${process.id} 已被申请人 ${revokedBy.tag} 撤销`;
            logTime(logMessage);

            // 返回成功消息
            const successMessage = process.type === 'appeal'
                ? '✅ 上诉申请已成功撤销'
                : '✅ 申请已成功撤销，相关消息已删除';

            return { success: true, message: successMessage };
        } catch (error) {
            logTime(`撤销流程失败: ${error.message}`, true);
            return { success: false, message: '撤销流程时出错，请稍后重试' };
        }
    }

    /**
     * 移除上诉按钮辅助函数
     * @param {User} user - Discord用户对象
     * @param {string} messageId - 消息ID
     */
    static async removeAppealButton(user, messageId) {
        if (!messageId) return;

        try {
            const dmChannel = await user.createDM();
            if (dmChannel) {
                const originalMessage = await dmChannel.messages.fetch(messageId).catch(() => null);
                if (originalMessage) {
                    await originalMessage.edit({ components: [] });
                    logTime(`已移除上诉按钮: ${messageId}`);
                }
            }
        } catch (error) {
            logTime(`移除上诉按钮失败: ${error.message}`, true);
        }
    }

    /**
     * 处理议事提交的业务逻辑
     * @param {Object} client - Discord客户端
     * @param {Object} interaction - Discord交互对象
     * @param {string} title - 议事标题
     * @param {string} reason - 提案原因
     * @param {string} motion - 动议内容
     * @param {string} implementation - 执行方案
     * @param {string} voteTime - 投票时间
     * @returns {Promise<Object>} 处理结果
     */
    static async handleDebateSubmission(client, interaction, title, reason, motion, implementation, voteTime) {
        return await ErrorHandler.handleService(
            async () => {
                // 获取服务器配置（启动时已验证议事系统配置）
                const guildConfig = client.guildManager.getGuildConfig(interaction.guildId);

                // 如果voteTime不以"天"结尾，添加"天"字
                if (!voteTime.endsWith('天')) {
                    voteTime = voteTime + '天';
                }

                // 获取议事区频道
                const courtChannel = await interaction.guild.channels.fetch(guildConfig.courtSystem.courtChannelId);
                if (!courtChannel) {
                    throw new Error('无法获取议事频道');
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
                await globalTaskScheduler.getScheduler('process').scheduleProcess(process, interaction.client);

                logTime(`用户 ${interaction.user.tag} 提交了议事 "${title}"`);

                return {
                    success: true,
                    message,
                    title
                };
            },
            "提交议事申请"
        );
    }
}

export default CourtService;
