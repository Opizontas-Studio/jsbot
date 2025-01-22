import { logTime } from '../utils/logger.js';
import { dbManager } from '../db/manager.js';
import { ProcessModel } from '../db/models/process.js';

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
	    }
		catch (error) {
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
	                    process.supporters :
	                    JSON.parse(process.supporters || '[]');
	    }
		catch (error) {
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
	    }
		else {
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

	    // 根据状态添加相应的描述
	    if (isExpired) {
	        updatedEmbed.description = `${embed.description}\n\n❌ 议事已过期，未达到所需支持人数`;
	    }
		else if (debateThread) {
	        updatedEmbed.description = `${embed.description}\n\n✅ 已达到所需支持人数，辩诉帖已创建：${debateThread.url}`;
	    }

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
	    }
		catch (error) {
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

	    }
		catch (error) {
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
	        }
			else {
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
	    }
		catch (error) {
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
	    }
		catch (error) {
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
	        const supporters = JSON.parse(updatedProcess.supporters || '[]');
	        let replyContent;
	        let debateThread = null;

	        if (hasSupported) {
	            // 移除支持的情况
	            replyContent = `✅ 你已移除对此${process.type === 'court_mute' ? '禁言' : '永封'}处罚申请的支持，当前共有 ${supporters.length} 位议员支持`;
	        }
			else {
	            // 添加支持的情况
	            replyContent = `✅ 你已支持此${process.type === 'court_mute' ? '禁言' : '永封'}处罚申请，当前共有 ${supporters.length} 位议员支持`;

	            // 检查是否达到所需支持数量
	            if (supporters.length === guildConfig.courtSystem.requiredSupports && !process.debateThreadId) {
	                // 创建辩诉帖子
	                debateThread = await this.createDebateThread(updatedProcess, guildConfig, client);

	                // 更新流程状态为completed，并记录辩诉帖ID
	                await ProcessModel.updateStatus(updatedProcess.id, 'completed', {
	                    result: 'approved',
	                    reason: '已达到所需支持人数，辩诉帖已创建',
	                    debateThreadId: debateThread.id,
	                });

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
	    }
		catch (error) {
	        logTime(`添加/移除支持者失败: ${error.message}`, true);
	        throw error;
	    }
	}
}

export default CourtService;