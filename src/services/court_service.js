import { dbManager } from '../db/manager.js';
import { ProcessModel } from '../db/models/process.js';
import { PunishmentModel } from '../db/models/punishment.js';
import { logTime } from '../utils/logger.js';
import { revokePunishmentInGuilds } from '../utils/punishment_helper.js';

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
	    const details = JSON.parse(process.details || '{}');

	    // 获取申请人和目标用户
	    const [executor, target] = await Promise.all([
	        client.users.fetch(details.executorId).catch(() => null),
	        client.users.fetch(process.targetId).catch(() => null),
	    ]);

	    const debateThread = await debateForum.threads.create({
	        name: `对 ${target?.username || '未知用户'} 的${details.embed?.title?.replace('申请', '辩诉') || '辩诉帖'}`,
	        message: {
	            embeds: [{
	                ...(details.embed || {}),
	                title: `对 ${target?.tag || '未知用户'} 的${details.embed?.title?.replace('申请', '辩诉') || '辩诉帖'}`,
	                fields: [
	                    ...(details.embed?.fields?.filter(f => f) || []),
	                ],
	            }],
	        },
	        appliedTags: guildConfig.courtSystem.debateTagId ? [guildConfig.courtSystem.debateTagId] : [],
	    });

	    // 记录辩诉帖创建日志
	    logTime(`已创建辩诉帖：${process.type === 'appeal' ?
	        `${target?.tag || '未知用户'} 对 ${executor?.tag || '未知管理员'} 的处罚上诉` :
	        `${executor?.tag || '未知管理员'} 对 ${target?.tag || '未知用户'} 的处罚申请`}`);

	    // 发送通知消息
	    if (executor && target) {
	        const notifyContent = process.type === 'appeal' ?
	            [
	                '上诉辩诉帖已创建，请双方当事人注意查看。',
	                `- 上诉人：<@${target.id}>`,
	                `- 原处罚执行人：<@${executor.id}>`,
	            ].join('\n') :
	            [
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
	 * 更新议事消息
	 * @param {Object} message - Discord消息对象
	 * @param {Object} process - 流程记录
	 * @param {Object} options - 更新选项
	 * @param {Object} [options.debateThread] - 辩诉帖子对象（可选）
	 * @param {boolean} [options.isExpired] - 是否已过期
	 * @param {boolean} [options.removeComponents] - 是否移除交互组件
	 * @returns {Promise<{supportCount: number, debateThreadUrl: string|null}>}
	 */
    static async updateCourtMessage(message, process, options = {}) {
        const { debateThread, isExpired, removeComponents = false } = options;
        const embed = message.embeds[0];
        const updatedFields = [...embed.fields];
        const supportCountField = updatedFields.find(field => field.name === '支持人数');

        let supporters = [];
        try {
            supporters = Array.isArray(process.supporters) ?
                supporters = process.supporters :
                JSON.parse(process.supporters || '[]');
        } catch (error) {
            logTime(`解析supporters失败: ${error.message}`, true);
        }

        const supportCount = supporters.length;

        // 更新支持人数字段
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

        // 发送私信通知并更新消息描述
        try {
            const executor = await message.client.users.fetch(process.executorId);
            const target = await message.client.users.fetch(process.targetId);

            if (isExpired) {
                // 过期状态
                updatedEmbed.description = `${embed.description}\n\n❌ 议事已过期，未达到所需支持人数`;
                // 过期通知
                const expiredContent = process.type === 'appeal' ?
                    '❌ 您提交的上诉申请已过期，很遗憾未能获得足够议员支持。' :
                    '❌ 您提交的处罚申请已过期，很遗憾未能获得足够议员支持。';
                // 根据流程类型通知相应用户
                await (process.type === 'appeal' ? target : executor).send({
                    content: expiredContent,
                    flags: ['Ephemeral'],
                });
            } else if (debateThread) {
                // 辩诉帖创建状态
                updatedEmbed.description = `${embed.description}\n\n✅ 已达到所需支持人数，辩诉帖已创建：${debateThread.url}`;

                // 获取处罚记录并处理
                if (process.type === 'appeal') {
                    const punishmentId = process.details?.punishmentId;
                    if (punishmentId) {
                        const punishment = await PunishmentModel.getPunishmentById(punishmentId);
                        if (punishment) {
                            // 检查处罚是否已过期
                            const now = Date.now();
                            const isPunishmentExpired = punishment.duration > 0 && (punishment.createdAt + punishment.duration <= now);

                            // 获取主服务器配置
                            const mainGuildConfig = message.client.guildManager.getGuildConfig(message.guildId);
                            if (!mainGuildConfig?.courtSystem?.appealDebateRoleId) {
                                logTime('未配置辩诉通行身份组ID', true);
                                return;
                            }

                            // 如果处罚未过期，在所有服务器中移除处罚
                            if (!isPunishmentExpired) {
                                await revokePunishmentInGuilds(
                                    message.client,
                                    punishment,
                                    target,
                                    '上诉申请通过',
                                    { isAppeal: true },
                                );
                            }

                            // 在主服务器添加辩诉通行身份组
                            const mainGuild = await message.client.guilds.fetch(mainGuildConfig.id).catch(() => null);
                            if (mainGuild) {
                                const targetMember = await mainGuild.members.fetch(target.id).catch(() => null);
                                if (targetMember) {
                                    await targetMember.roles.add(mainGuildConfig.courtSystem.appealDebateRoleId, '上诉申请通过')
                                        .then(() => logTime(`已添加用户 ${target.tag} 的辩诉通行身份组`))
                                        .catch(error => logTime(`添加辩诉通行身份组失败: ${error.message}`, true));
                                }
                            }

                            // 辩诉帖创建通知
                            const notifyContent = '✅ 有关您的上诉申请已获得足够议员支持。\n' +
								(isPunishmentExpired ? '- 另外，处罚已过期\n' : '- 上诉期间处罚限制已解除\n') +
								'- 已为您添加辩诉通行身份组\n' +
								`辩诉帖已创建：${debateThread.url}`;

                            // 通知双方
                            await executor.send({
                                content: notifyContent,
                                flags: ['Ephemeral'],
                            });
                            await target.send({
                                content: notifyContent,
                                flags: ['Ephemeral'],
                            });
                        }
                    }
                } else {
                    // 处理上庭申请
                    const notifyContent = `✅ 您的处罚申请已获得足够议员支持，辩诉帖已创建：${debateThread.url}`;

                    // 通知双方
                    await executor.send({
                        content: notifyContent,
                        flags: ['Ephemeral'],
                    });
                    await target.send({
                        content: notifyContent,
                        flags: ['Ephemeral'],
                    });
                }
            }
        } catch (error) {
            logTime(`发送私信通知失败: ${error.message}`, true);
        }

        // 更新消息
        await message.edit({
            embeds: [updatedEmbed],
            components: (removeComponents || debateThread || isExpired) ? [] : message.components,
        });

        return {
            supportCount,
            debateThreadUrl: debateThread?.url || null,
        };
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
                const activeProcess = userProcesses.find(p =>
                    p.type === `court_${type}` &&
                    ['pending', 'in_progress'].includes(p.status),
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
                    expireAt: Date.now() + guildConfig.courtSystem.appealDuration,
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
	        // 从guildManager中获取主服务器配置
	        const guildIds = client.guildManager.getGuildIds();
	        const mainGuildConfig = guildIds
	            .map(id => client.guildManager.getGuildConfig(id))
	            .find(config => config?.serverType === 'Main server');

	        if (!mainGuildConfig?.courtSystem?.enabled) {
	            logTime('主服务器未启用议事系统', true);
	            return;
	        }

	        // 获取议事频道
	        const courtChannel = await client.channels.fetch(mainGuildConfig.courtSystem.courtChannelId);
	        if (!courtChannel) {
	            logTime(`无法获取议事频道: ${mainGuildConfig.courtSystem.courtChannelId}`, true);
	            return;
	        }

	        // 获取最新的流程数据
	        const currentProcess = await ProcessModel.getProcessById(process.id);
	        if (!currentProcess) {
	            logTime(`无法获取流程数据: ${process.id}`, true);
	            return;
	        }

	        // 获取并更新原始消息
	        const message = await courtChannel.messages.fetch(process.messageId);
	        if (message) {
	            await this.updateCourtMessage(message, currentProcess, {
	                isExpired: true,
	                removeComponents: true,
	            });
	        }

	        // 只有在成功处理完所有步骤后，才更新流程状态
	        await ProcessModel.updateStatus(process.id, 'completed', {
	            result: 'cancelled',
	            reason: '议事流程已过期，未达到所需支持人数',
	        });

	    } catch (error) {
	        logTime(`处理议事流程到期失败: ${error.message}`, true);
	    }
    }

    /**
	 * 添加支持者并处理后续流程
	 * @param {string} messageId - 议事消息ID
	 * @param {string} userId - 支持者ID
	 * @param {Object} guildConfig - 服务器配置
	 * @param {Object} client - Discord客户端
	 * @returns {Promise<{process: Object, debateThread: Object|null}>} 更新后的流程记录和可能创建的辩诉帖子
	 */
    static async addSupporter(messageId, userId, guildConfig, client) {
	    try {
	        const process = await ProcessModel.getProcessByMessageId(messageId);
	        if (!process) throw new Error('议事流程不存在');

	        // 检查是否已经支持过
	        let currentSupporters;
	        try {
	            currentSupporters = Array.isArray(process.supporters) ?
	                process.supporters :
	                JSON.parse(process.supporters || '[]');
	        } catch (error) {
	            logTime(`解析supporters失败: ${error.message}`, true);
	            currentSupporters = [];
	        }
	        const hasSupported = currentSupporters.includes(userId);

	        // 更新支持者列表（添加或移除）
	        const updatedProcess = await dbManager.updateArrayField(
	            'processes',
	            'supporters',
	            userId,
	            { messageId },
	        );

	        // 获取更新后的支持者列表
	        const supporters = Array.isArray(updatedProcess.supporters) ?
	            updatedProcess.supporters :
	            JSON.parse(updatedProcess.supporters || '[]');
	        let replyContent;
	        let debateThread = null;

	        if (hasSupported) {
	            // 移除支持的情况
	            replyContent = `✅ 你已移除对此${process.type === 'court_mute' ? '禁言' : '永封'}处罚申请的支持，当前共有 ${supporters.length} 位议员支持`;
	        } else {
	            // 添加支持的情况
	            replyContent = `✅ 你已支持此${process.type === 'court_mute' ? '禁言' : '永封'}处罚申请，当前共有 ${supporters.length} 位议员支持`;

	            // 检查是否达到所需支持数量
	            if (supporters.length === guildConfig.courtSystem.requiredSupports && !process.debateThreadId) {
	                // 创建辩诉帖子
	                debateThread = await this.createDebateThread(updatedProcess, guildConfig, client);

	                // 更新流程状态为completed
	                await ProcessModel.updateStatus(updatedProcess.id, 'completed', {
	                    result: 'approved',
	                    reason: '已达到所需支持人数，辩诉帖已创建',
	                    debateThreadId: debateThread.id,
	                });

	                replyContent += `\n📢 已达到所需支持人数，辩诉帖子已创建：${debateThread.url}`;
	            }
	        }

	        // 清除缓存
	        ProcessModel._clearRelatedCache(
	            process.targetId,
	            process.executorId,
	            process.id,
	            messageId,
	        );

	        const finalProcess = await ProcessModel.getProcessByMessageId(messageId);

	        // 更新消息
	        const message = await client.channels.fetch(guildConfig.courtSystem.courtChannelId)
	            .then(channel => channel.messages.fetch(messageId));

	        if (message) {
	            await this.updateCourtMessage(message, finalProcess, { debateThread });
	        }

	        return { process: finalProcess, debateThread, replyContent };
	    } catch (error) {
	        logTime(`添加/移除支持者失败: ${error.message}`, true);
	        throw error;
	    }
    }
}

export default CourtService;