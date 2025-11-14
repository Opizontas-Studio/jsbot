import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { EmbedFactory } from '../factories/embedFactory.js';
import { ErrorHandler } from './errorHandler.js';
import { logTime } from './logger.js';

/**
 * 处罚确认数据存储
 * 存储待确认的处罚信息
 */
class PunishmentConfirmationStore {
    constructor() {
        // messageId -> confirmationData
        this.pendingConfirmations = new Map();
        // messageId -> { userId, timestamp } 用于跟踪正在处理的请求
        this.processingLocks = new Map();
        this.EXPIRY_TIME = 30 * 60 * 1000; // 30分钟
        this.LOCK_TIMEOUT = 60 * 1000; // 锁超时时间：60秒（防止死锁）
    }

    /**
     * 添加待确认的处罚
     * @param {string} messageId - 确认消息ID
     * @param {Object} data - 处罚确认数据
     */
    add(messageId, data) {
        this.pendingConfirmations.set(messageId, data);

        // 设置30分钟后自动清理
        setTimeout(() => {
            this.pendingConfirmations.delete(messageId);
            this.processingLocks.delete(messageId); // 同时清理锁
        }, this.EXPIRY_TIME);
    }

    /**
     * 获取待确认的处罚数据（不加锁，仅供查询）
     * @param {string} messageId - 确认消息ID
     * @returns {Object|null}
     */
    get(messageId) {
        const data = this.pendingConfirmations.get(messageId);

        // 双重检查：即使 setTimeout 失败，也通过时间戳验证
        if (data && Date.now() - data.timestamp > this.EXPIRY_TIME) {
            this.pendingConfirmations.delete(messageId);
            this.processingLocks.delete(messageId);
            return null;
        }

        return data || null;
    }

    /**
     * 原子性地获取并锁定待确认的处罚数据（用于处理按钮点击）
     * @param {string} messageId - 确认消息ID
     * @param {string} userId - 处理用户ID
     * @returns {Object|null} 返回数据，如果已被锁定或不存在则返回 null
     */
    getAndLock(messageId, userId) {
        // 检查是否已被锁定
        const lock = this.processingLocks.get(messageId);
        if (lock) {
            // 检查锁是否超时
            if (Date.now() - lock.timestamp < this.LOCK_TIMEOUT) {
                // 锁仍然有效，拒绝此请求
                return null;
            }
            // 锁已超时，可以强制解锁并继续
            logTime(`[处罚确认] 检测到超时的锁，messageId: ${messageId}，强制解锁`, true);
        }

        // 获取数据
        const data = this.get(messageId);
        if (!data) {
            return null;
        }

        // 加锁
        this.processingLocks.set(messageId, {
            userId,
            timestamp: Date.now()
        });

        return data;
    }

    /**
     * 释放锁（处理完成或失败时调用）
     * @param {string} messageId - 确认消息ID
     */
    unlock(messageId) {
        this.processingLocks.delete(messageId);
    }

    /**
     * 检查是否被锁定
     * @param {string} messageId - 确认消息ID
     * @returns {boolean}
     */
    isLocked(messageId) {
        const lock = this.processingLocks.get(messageId);
        if (!lock) return false;

        // 检查锁是否超时
        if (Date.now() - lock.timestamp >= this.LOCK_TIMEOUT) {
            this.processingLocks.delete(messageId);
            return false;
        }

        return true;
    }

    /**
     * 删除待确认的处罚（同时清理锁）
     * @param {string} messageId - 确认消息ID
     */
    delete(messageId) {
        this.pendingConfirmations.delete(messageId);
        this.processingLocks.delete(messageId);
    }

    /**
     * 清理所有过期的确认数据（保险机制）
     * 由 scheduler 定期调用，防止内存泄漏
     * @param {Object} client - Discord客户端（用于更新消息）
     */
    async cleanupExpired(client) {
        const now = Date.now();
        let cleanedCount = 0;
        const expiredEntries = [];

        // 收集过期的条目
        for (const [messageId, data] of this.pendingConfirmations.entries()) {
            if (now - data.timestamp > this.EXPIRY_TIME) {
                expiredEntries.push({ messageId, data });
            }
        }

        // 处理过期的确认消息
        for (const { messageId, data } of expiredEntries) {
            // 尝试更新 Discord 消息，移除按钮
            const updated = await ErrorHandler.handleSilent(
                async () => {
                    const channel = await client.channels.fetch(client.guildManager.getGuildConfig(data.guildId)?.punishmentConfirmationChannelId);
                    if (!channel) return false;

                    const message = await channel.messages.fetch(messageId);
                    if (!message) return false;

                    // 更新 embed
                    const originalEmbed = message.embeds[0]?.toJSON();
                    if (originalEmbed) {
                        originalEmbed.footer = { text: '⏰ 确认已过期（30分钟未处理）' };
                        originalEmbed.color = 0x808080; // 灰色

                        await message.edit({
                            embeds: [originalEmbed],
                            components: [] // 移除按钮
                        });
                        return true;
                    }
                    return false;
                },
                `更新过期确认消息 ${messageId}`,
                false
            );

            // 无论是否成功更新消息，都删除内存数据（使用 delete 方法同时清理锁）
            this.delete(messageId);
            cleanedCount++;

            if (updated) {
                logTime(`[处罚确认] 已标记过期并移除按钮：${data.punishmentType} 处罚，目标: ${data.target.tag}`);
            }
        }

        if (cleanedCount > 0) {
            logTime(`[处罚确认] 清理了 ${cleanedCount} 个过期的确认数据`);
        }

        return cleanedCount;
    }
}

export const punishmentConfirmationStore = new PunishmentConfirmationStore();

/**
 * 发送处罚确认请求到指定频道
 * @param {Object} options - 配置选项
 * @param {Object} options.client - Discord客户端
 * @param {string} options.channelId - 确认频道ID
 * @param {Object} options.interaction - 原始交互对象
 * @param {Object} options.punishmentData - 处罚数据
 * @param {string} options.punishmentType - 处罚类型 (ban/softban/mute/warning)
 * @param {Object} options.target - 目标用户对象
 * @param {string} options.reason - 处罚原因
 * @returns {Promise<void>}
 */
export async function sendPunishmentConfirmation({
    client,
    channelId,
    interaction,
    punishmentData,
    punishmentType,
    target,
    reason,
}) {
    await ErrorHandler.handleService(
        async () => {
            // 获取确认频道
            const confirmationChannel = await client.channels.fetch(channelId);

            // 创建确认 embed
            const embed = EmbedFactory.createPunishmentConfirmationEmbed({
                punishmentType,
                target,
                submitter: interaction.user,
                reason,
                punishmentData
            });

            // 创建确认按钮
            const customIdPrefix = `punishment_confirm_${punishmentType}_${interaction.id}`;
            const approveButton = new ButtonBuilder()
                .setCustomId(`${customIdPrefix}_approve`)
                .setLabel('✅ 通过')
                .setStyle(ButtonStyle.Success);

            const rejectButton = new ButtonBuilder()
                .setCustomId(`${customIdPrefix}_reject`)
                .setLabel('❌ 驳回')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(approveButton, rejectButton);

            // 构建消息内容（永封需要 @here 通知）
            const messageOptions = {
                embeds: [embed],
                components: [row]
            };

            if (punishmentType === 'ban') {
                messageOptions.content = '@here';
            }

            // 发送确认消息
            const confirmMessage = await confirmationChannel.send(messageOptions);

            // 存储待确认的处罚数据
            punishmentConfirmationStore.add(confirmMessage.id, {
                interactionId: interaction.id,
                submitterId: interaction.user.id,
                submitterTag: interaction.user.tag,
                punishmentType,
                punishmentData,
                target: {
                    id: target.id,
                    tag: target.tag
                },
                reason,
                guildId: interaction.guildId,
                originalChannelId: interaction.channelId,
                timestamp: Date.now()
            });

            // 回复提交者
            await interaction.editReply({
                content: `✅ 处罚请求已提交，等待确认。\n确认消息：${confirmMessage.url}`,
                flags: ['Ephemeral']
            });

            logTime(`[处罚确认] 用户 ${interaction.user.tag} 提交了 ${punishmentType} 处罚请求，目标: ${target.tag}`);
        },
        '发送处罚确认请求',
        { throwOnError: true }
    );
}

/**
 * 检查用户是否有权限确认指定类型的处罚
 * @param {Object} options - 配置选项
 * @param {Object} options.member - 成员对象
 * @param {Object} options.guildConfig - 服务器配置
 * @param {string} options.punishmentType - 处罚类型
 * @param {string} options.submitterId - 提交者ID
 * @returns {Object} { allowed: boolean, reason?: string, needsWait?: boolean, waitTime?: number }
 */
export function checkConfirmationPermission({ member, guildConfig, punishmentType, submitterId, submissionTime }) {
    const isSelf = member.id === submitterId;
    const hasAdminRole = member.roles.cache.some(role =>
        guildConfig.AdministratorRoleIds.includes(role.id)
    );
    const hasModRole = member.roles.cache.some(role =>
        guildConfig.ModeratorRoleIds.includes(role.id) ||
        (guildConfig.roleApplication?.QAerRoleId && role.id === guildConfig.roleApplication.QAerRoleId)
    );

    // 检查是否有基本权限（管理员或版主）
    if (!hasAdminRole && !hasModRole) {
        return {
            allowed: false,
            reason: '你没有权限确认处罚。需要具有管理身份组。'
        };
    }

    // 根据处罚类型检查特殊规则
    switch (punishmentType) {
        case 'warning':
        case 'mute':
            // 警告和禁言：有权限的人可以即时确认（包括自己）
            return { allowed: true };

        case 'softban':
            // 软封锁：他人可以即时确认，自己需要等待1分钟
            if (isSelf) {
                const waitTime = 60 * 1000; // 1分钟
                const elapsedTime = Date.now() - submissionTime;

                if (elapsedTime < waitTime) {
                    const remainingSeconds = Math.ceil((waitTime - elapsedTime) / 1000);
                    return {
                        allowed: false,
                        needsWait: true,
                        waitTime: remainingSeconds,
                        reason: `自己提交的软封锁处罚需要等待1分钟后才能确认。剩余 ${remainingSeconds} 秒。`
                    };
                }
            }
            return { allowed: true };

        case 'ban':
            // 永封：必须由他人确认
            if (isSelf) {
                return {
                    allowed: false,
                    reason: '永封处罚必须由他人确认，不能自己确认。'
                };
            }
            return { allowed: true };

        default:
            return {
                allowed: false,
                reason: '未知的处罚类型'
            };
    }
}

