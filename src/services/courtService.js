import { readFileSync } from 'fs';
import { join } from 'path';
import { dbManager } from '../db/dbManager.js';
import { ProcessModel } from '../db/models/processModel.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { checkCooldown } from '../handlers/buttons.js';
import { globalTaskScheduler } from '../handlers/scheduler.js';
import { revokeRolesByGroups } from '../services/roleApplication.js';
import { logTime } from '../utils/logger.js';
import { revokePunishmentInGuilds } from '../utils/punishmentHelper.js';
import { VoteService } from './voteService.js';

// 配置文件路径
const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

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
                    const punishmentType = process.type === 'court_ban' ? '永封处罚' : '禁言处罚';
                    const hasRoleRevoke = process.details?.revokeRoleId;

                    threadTitle = `对 ${target?.username || '未知用户'} 的${punishmentType}${
                        hasRoleRevoke && process.type === 'court_mute' ? '及弹劾' : ''
                    }申请`;

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
                    title: '📊 辩诉投票',
                    description: [
                        `投票截止：<t:${Math.floor((Date.now() + guildConfig.courtSystem.voteDuration) / 1000)}:R>`,
                        '',
                        '🔴 **红方诉求：**',
                        process.type === 'appeal'
                            ? `解除对 <@${target?.id}> 的处罚`
                            : `对 <@${target?.id}> 执行${process.type === 'court_ban' ? '永封' : '禁言'}`,
                        '',
                        '🔵 **蓝方诉求：**',
                        process.type === 'appeal' ? '维持原判' : '驳回处罚申请',
                        '',
                        '🔴▬▬▬▬▬|▬▬▬▬▬🔵',
                        '',
                        `票数将在 <t:${Math.floor(
                            (Date.now() + guildConfig.courtSystem.votePublicDelay) / 1000,
                        )}:R> 公开`,
                    ].join('\n'),
                    footer: {
                        text: `发起人：${executor?.tag || '未知用户'}`,
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
                            custom_id: `vote_red_pending`,
                        },
                        {
                            type: 2,
                            style: 1,
                            label: '支持蓝方',
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

        // 投票创建日志
        logTime(
            `创建投票 [ID: ${vote.id}] - 类型: ${process.type}, 目标: ${target?.tag || '未知用户'}, 发起人: ${
                executor?.tag || '未知用户'
            }`,
        );
        logTime(
            `投票详情 [ID: ${vote.id}] - 红方: ${
                process.type === 'appeal'
                    ? `解除对 <@${target?.id}> 的处罚`
                    : `对 <@${target?.id}> 执行${process.type === 'court_ban' ? '永封' : '禁言'}`
            }, 蓝方: ${process.type === 'appeal' ? '维持原判' : '驳回处罚申请'}`,
        );
        logTime(
            `投票时间 [ID: ${vote.id}] - 公开: ${guildConfig.courtSystem.votePublicDelay / 1000}秒后, 结束: ${
                guildConfig.courtSystem.voteDuration / 1000
            }秒后`,
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
        await globalTaskScheduler.getVoteScheduler().scheduleVote(vote, client);

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
            if (!process.type.startsWith('court_') && !process.type.startsWith('appeal') && process.type !== 'debate') {
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
     * 为双方调整辩诉身份组
     * @private
     * @param {Object} client - Discord客户端
     * @param {Object} guildConfig - 服务器配置
     * @param {string} executorId - 执行者ID
     * @param {string} targetId - 目标用户ID
     * @param {string} reason - 添加身份组的原因
     * @returns {Promise<void>}
     */
    static async _addDebateRolesToBothParties(client, guildConfig, executorId, targetId, reason) {
        const mainGuild = await client.guilds.fetch(guildConfig.id).catch(() => null);
        if (!mainGuild || !guildConfig.roleApplication?.appealDebateRoleId) {
            return;
        }

        // 获取双方成员对象
        const [executorMember, targetMember] = await Promise.all([
            mainGuild.members.fetch(executorId).catch(() => null),
            mainGuild.members.fetch(targetId).catch(() => null),
        ]);

        // 为双方添加辩诉通行身份组
        const addRolePromises = [executorMember, targetMember]
            .filter(member => member) // 过滤掉不存在的成员
            .map(member =>
                member.roles
                    .add(guildConfig.roleApplication?.appealDebateRoleId, reason)
                    .then(() => logTime(`已添加用户 ${member.user.tag} 的辩诉通行身份组`))
                    .catch(error => logTime(`添加辩诉通行身份组失败 (${member.user.tag}): ${error.message}`, true)),
            );

        await Promise.all(addRolePromises);
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
                case 'court_ban': {
                    // 创建辩诉帖
                    const debateThread = await this.createDebateThread(process, guildConfig, client);

                    // 添加辩诉通行身份组
                    await this._addDebateRolesToBothParties(
                        client,
                        guildConfig,
                        process.executorId,
                        process.targetId,
                        '处罚申请辩诉通行',
                    );

                    // 读取身份组同步配置
                    const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));

                    // 找到已验证身份组的同步组
                    const verifiedGroup = roleSyncConfig.syncGroups.find(group => group.name === '已验证');
                    if (verifiedGroup) {
                        // 移除目标用户的已验证身份组
                        await revokeRolesByGroups(
                            client,
                            process.targetId,
                            [verifiedGroup],
                            '处罚申请辩诉期间暂时移除已验证身份组',
                        );
                    }

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
                            const notifyContent = [
                                '✅ 有关您的处罚申请已获得足够议员支持，辩诉帖已创建：',
                                `[点击查看辩诉帖](${debateThread.url})`,
                                '注意：辩诉期间目标用户的已验证身份组将被暂时移除，请事后自行答题验证',
                            ].join('\n');

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
                        await revokePunishmentInGuilds(client, punishment, target, '上诉申请通过', { isAppeal: true });
                    }

                    // 添加辩诉通行身份组
                    await this._addDebateRolesToBothParties(
                        client,
                        guildConfig,
                        punishment.executorId,
                        process.targetId,
                        '上诉申请通过',
                    );

                    // 读取身份组同步配置
                    const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));

                    // 找到已验证身份组的同步组
                    const verifiedGroup = roleSyncConfig.syncGroups.find(group => group.name === '已验证');
                    if (verifiedGroup) {
                        // 移除目标用户的已验证身份组
                        await revokeRolesByGroups(
                            client,
                            process.targetId,
                            [verifiedGroup],
                            '上诉辩诉期间暂时移除已验证身份组',
                        );
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
                                '- 已为您添加辩诉通行身份组，且上诉人的已验证身份组将被暂时移除，请事后自行答题验证',
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
                                        description: `您的提案"${title}"已获得足够支持，已创建帖子以供进一步讨论。`,
                                        fields: [
                                            {
                                                name: '帖子链接',
                                                value: `[点击查看](${thread.url})`,
                                            },
                                        ],
                                        timestamp: new Date(),
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
     * @param {string} type - 议事类型 ('mute' | 'ban' | 'appeal' | 'debate')
     * @returns {Promise<void>}
     */
    static async handleSupport(interaction, type) {
        try {
            // 检查冷却时间
            const cooldownLeft = checkCooldown('court_support', interaction.user.id);
            if (cooldownLeft) {
                return await interaction.editReply({
                    content: `❌ 请等待 ${cooldownLeft} 秒后再次投票`,
                });
            }

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
}

export default CourtService;
