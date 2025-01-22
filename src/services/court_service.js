import { dbManager } from '../db/manager.js';
import { ProcessModel } from '../db/models/process.js';
import { PunishmentModel } from '../db/models/punishment.js';
import { logTime } from '../utils/logger.js';

class CourtService {
    /**
	 * 检查用户是否已经支持过
	 * @param {Object} process - 流程记录
	 * @param {string} userId - 用户ID
	 * @returns {boolean} 是否已支持
	 */
    static hasSupported(process, userId) {
	    try {
	        const supporters = Array.isArray(process.supporters) ?
	            process.supporters :
	            JSON.parse(process.supporters || '[]');
	        return supporters.includes(userId);
	    } catch (error) {
	        logTime(`检查支持状态失败: ${error.message}`, true);
	        return false;
	    }
    }

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
	        await debateThread.send({
	            content: [
	                '辩诉帖已创建，请双方当事人注意查看。',
	                `- 申请人：<@${executor.id}>`,
	                `- 处罚对象：<@${target.id}>`,
	            ].join('\n'),
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
                                const allGuilds = Array.from(message.client.guildManager.guilds.values());
                                const successfulServers = [];
                                const failedServers = [];

                                for (const guildData of allGuilds) {
                                    try {
                                        if (!guildData || !guildData.id) {
                                            logTime('跳过无效的服务器配置', true);
                                            continue;
                                        }

                                        const guild = await message.client.guilds.fetch(guildData.id).catch(() => null);
                                        if (!guild) {
                                            logTime(`无法获取服务器 ${guildData.id}`, true);
                                            failedServers.push({
                                                id: guildData.id,
                                                name: guildData.name || guildData.id,
                                            });
                                            continue;
                                        }

                                        const targetMember = await guild.members.fetch(target.id).catch(() => null);
                                        if (!targetMember) {
                                            logTime(`无法在服务器 ${guild.name} 找到目标用户，跳过`, true);
                                            continue;
                                        }

                                        // 根据处罚类型执行不同的解除操作
                                        if (punishment.type === 'ban') {
                                            // 解除封禁
                                            await guild.bans.remove(target.id, '上诉申请通过')
                                                .then(() => {
                                                    logTime(`已在服务器 ${guild.name} 解除用户 ${target.tag} 的封禁`);
                                                    successfulServers.push(guild.name);
                                                })
                                                .catch(error => {
                                                    logTime(`在服务器 ${guild.name} 解除封禁失败: ${error.message}`, true);
                                                    failedServers.push({
                                                        id: guild.id,
                                                        name: guild.name,
                                                    });
                                                });
                                        } else if (punishment.type === 'mute') {
                                            // 解除禁言
                                            await targetMember.timeout(null, '上诉申请通过')
                                                .then(() => {
                                                    logTime(`已在服务器 ${guild.name} 解除用户 ${target.tag} 的禁言`);
                                                    successfulServers.push(guild.name);
                                                })
                                                .catch(error => {
                                                    logTime(`在服务器 ${guild.name} 解除禁言失败: ${error.message}`, true);
                                                    failedServers.push({
                                                        id: guild.id,
                                                        name: guild.name,
                                                    });
                                                });

                                            // 移除警告身份组
                                            if (guildData.WarnedRoleId) {
                                                await targetMember.roles.remove(guildData.WarnedRoleId, '上诉申请通过')
                                                    .then(() => logTime(`已在服务器 ${guild.name} 移除用户 ${target.tag} 的警告身份组`))
                                                    .catch(error => logTime(`在服务器 ${guild.name} 移除警告身份组失败: ${error.message}`, true));
                                            }
                                        }
                                    } catch (error) {
                                        logTime(`在服务器 ${guildData.id} 处理处罚解除失败: ${error.message}`, true);
                                        failedServers.push({
                                            id: guildData.id,
                                            name: guildData.name || guildData.id,
                                        });
                                    }
                                }

                                // 记录执行结果
                                if (successfulServers.length > 0) {
                                    logTime(`处罚解除成功的服务器: ${successfulServers.join(', ')}`);
                                }
                                if (failedServers.length > 0) {
                                    logTime(`处罚解除失败的服务器: ${failedServers.map(s => s.name).join(', ')}`, true);
                                }
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
	 * 从消息中获取申请人信息
	 * @private
	 * @param {Object} message - Discord消息对象
	 * @returns {Object|null} 申请人成员对象
	 */
    static _getExecutorFromMessage(message) {
	    const footer = message.embeds[0]?.footer;
	    const executorName = footer?.text?.replace('申请人：', '');
	    return message.guild.members.cache
	        .find(member => member.displayName === executorName);
    }

    /**
	 * 获取或创建议事流程
	 * @param {Object} message - Discord消息对象
	 * @param {string} targetId - 目标用户ID
	 * @param {string} type - 处罚类型 ('mute' | 'ban')
	 * @param {Object} guildConfig - 服务器配置
	 * @returns {Promise<{process: Object|null, error: string|null}>} 流程对象和可能的错误信息
	 */
    static async getOrCreateProcess(message, targetId, type, guildConfig) {
        try {
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

                const executorMember = this._getExecutorFromMessage(message);
                if (!executorMember) {
                    return { process: null, error: '无法找到申请人信息' };
                }

                process = await ProcessModel.createCourtProcess({
                    type: `court_${type}`,
                    targetId,
                    executorId: executorMember.id,
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
	 * 调度单个流程的到期处理
	 * @param {Object} process - 流程记录
	 * @param {Object} client - Discord客户端
	 * @returns {Promise<void>}
	 */
    static async scheduleProcess(process, client) {
	    try {
	        // 检查是否为议事流程
	        if (!process.type.startsWith('court_')) return;

	        // 检查流程状态，如果已经完成则不需要处理到期
	        if (process.status === 'completed') {
	            logTime(`流程 ${process.id} 已完成，跳过到期处理`);
	            return;
	        }

	        const now = Date.now();
	        const timeUntilExpiry = process.expireAt - now;

	        if (timeUntilExpiry <= 0) {
	            // 已过期，直接处理
	            await this.handleProcessExpiry(process, client);
	        } else {
	            // 设置定时器
	            setTimeout(async () => {
	                // 在执行到期处理前再次检查流程状态
	                const currentProcess = await ProcessModel.getProcessById(process.id);
	                if (currentProcess && currentProcess.status === 'completed') {
	                    logTime(`流程 ${process.id} 已完成，跳过到期处理`);
	                    return;
	                }
	                await this.handleProcessExpiry(process, client);
	            }, timeUntilExpiry);

	            logTime(`已调度流程 ${process.id} 的到期处理，将在 ${Math.ceil(timeUntilExpiry / 1000)} 秒后执行`);
	        }
	    } catch (error) {
	        logTime(`调度流程失败: ${error.message}`, true);
	    }
    }

    /**
	 * 加载并调度所有未过期的流程
	 * @param {Object} client - Discord客户端
	 * @returns {Promise<void>}
	 */
    static async loadAndScheduleProcesses(client) {
	    try {
	        // 获取所有未完成的流程
	        const processes = await ProcessModel.getAllProcesses(false);

	        for (const process of processes) {
	            await this.scheduleProcess(process, client);
	        }

	        logTime(`已加载并调度 ${processes.length} 个流程的到期处理`);
	    } catch (error) {
	        logTime(`加载和调度流程失败: ${error.message}`, true);
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
	        const hasSupported = this.hasSupported(process, userId);

	        // 更新支持者列表（添加或移除）
	        const updatedProcess = await dbManager.updateArrayField(
	            'processes',
	            'supporters',
	            userId,
	            { messageId },
	        );

	        // 根据操作类型（添加/移除）返回不同的消息
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

	                // 获取处罚ID并更新处罚状态
	                const details = typeof process.details === 'object' ?
	                    process.details :
	                    JSON.parse(process.details || '{}');

	                // 确保处罚ID存在且为数字类型
	                const punishmentId = parseInt(details.punishmentId);
	                if (!isNaN(punishmentId)) {
	                    // 先获取处罚记录确认存在
	                    const punishment = await PunishmentModel.getPunishmentById(punishmentId);
	                    if (punishment && punishment.status === 'active') {
	                        await PunishmentModel.updateStatus(
	                            punishmentId,
	                            'appealed',
	                            '上诉申请已通过，进入辩诉阶段',
	                        );
	                        logTime(`处罚 ${punishmentId} 状态已更新为辩诉阶段`);
	                    } else {
	                        logTime(`处罚 ${punishmentId} 不存在或状态不是 active`, true);
	                    }
	                } else {
	                    logTime(`无效的处罚ID: ${details.punishmentId}`, true);
	                }

	                replyContent += `\n📢 已达到所需支持人数，辩诉帖子已创建：${debateThread.url}`;
	            }
	        }

	        // 清除缓存
	        dbManager.clearCache(`process_${process.id}`);
	        dbManager.clearCache(`process_msg_${messageId}`);

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