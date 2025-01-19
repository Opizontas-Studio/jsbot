import { logTime } from '../utils/logger.js';
import { PunishmentModel } from '../db/models/index.js';
import { createPunishmentEmbed, createAppealComponents } from '../utils/punishment_helper.js';
import { PermissionsBitField } from 'discord.js';

class PunishmentService {
    /**
     * 执行处罚
     * @param {Object} client - Discord客户端
     * @param {Object} data - 处罚数据
     * @param {Object} guildConfig - 服务器配置
     * @returns {Promise<Object>} 处罚记录
     */
    static async executePunishment(client, data, guildConfig) {
        const { userId, guildId, type, reason, duration, executorId, keepMessages } = data;

        try {
            // 1. 创建处罚记录
            const punishment = await PunishmentModel.createPunishment({
                userId, guildId, type, reason, duration,
                executorId, keepMessages,
                synced: 0,
                syncedServers: '[]'
            });

            // 2. 获取相关用户和服务器
            const guild = await client.guilds.fetch(guildId);
            const executor = await client.users.fetch(executorId);
            const target = await client.users.fetch(userId);
            const member = await guild.members.fetch(userId);

            // 3. 执行具体处罚
            await this._executeAction(guild, member, punishment, keepMessages);

            // 3. 同步到其他服务器
            const syncedServers = [guildId];
            for (const [serverId, serverConfig] of Object.entries(client.guildManager.guilds)) {
                if (serverId === guildId) continue; // 跳过主服务器

                try {
                    const targetGuild = await client.guilds.fetch(serverId);
                    const targetMember = await targetGuild.members.fetch(userId).catch(() => null);
                    
                    if (targetMember) {
                        await this._executeAction(targetGuild, targetMember, punishment, keepMessages);
                        syncedServers.push(serverId);
                    }
                } catch (error) {
                    logTime(`同步处罚到服务器 ${serverId} 失败: ${error.message}`, true);
                }
            }

            // 4. 更新同步状态
            await PunishmentModel.updateSyncStatus(punishment.id, syncedServers);

            // 5. 发送处罚通知
            await this._sendNotifications(client, guild, punishment, executor, target, guildConfig);

            return punishment;
        } catch (error) {
            logTime(`执行处罚失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 执行具体的处罚操作
     * @private
     */
    static async _executeAction(guild, member, punishment, keepMessages) {
        const reason = `处罚ID: ${punishment.id} - ${punishment.reason}`;

        switch (punishment.type) {
            case 'ban':
                await guild.members.ban(member.id, {
                    deleteMessageSeconds: keepMessages ? 0 : 7 * 24 * 60 * 60, // 7天消息
                    reason
                });
                break;

            case 'mute':
                // 检查是否有超时管理权限
                if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
                    throw new Error('Bot缺少超时管理权限');
                }
                
                await member.timeout(punishment.duration, reason);
                break;

            case 'warn':
                // 警告只记录，不执行实际操作
                break;

            default:
                throw new Error(`未知的处罚类型: ${punishment.type}`);
        }
    }

    /**
     * 发送处罚相关通知
     * @private
     */
    static async _sendNotifications(client, guild, punishment, executor, target, guildConfig) {
        const embed = createPunishmentEmbed(punishment, executor, target);
        const appealComponents = createAppealComponents(punishment);

        // 1. 发送到管理日志频道
        const logChannel = await client.channels.fetch(guildConfig.moderationLogChannelId);
        await logChannel.send({ embeds: [embed] });

        // 2. 发送公示消息（带上诉按钮）
        const notifyChannel = await client.channels.fetch(guildConfig.punishmentNotifyChannelId);
        await notifyChannel.send({
            embeds: [embed],
            components: [appealComponents]
        });

        // 3. 尝试私聊通知用户
        try {
            const dmEmbed = {
                ...embed,
                description: '如果您认为这是一个错误的处罚，可以点击下方按钮提交上诉。'
            };
            const dmChannel = await target.createDM();
            await dmChannel.send({
                embeds: [dmEmbed],
                components: [appealComponents]
            });
        } catch (error) {
            logTime(`无法向用户 ${target.tag} 发送私信: ${error.message}`);
        }
    }

    /**
     * 处理处罚到期
     * @param {Object} client - Discord客户端
     * @param {Object} punishment - 处罚记录
     * @param {Object} guildConfig - 服务器配置
     */
    static async handleExpiry(client, punishment, guildConfig) {
        try {
            const guild = await client.guilds.fetch(punishment.guildId);
            const target = await client.users.fetch(punishment.userId);

            // 1. 解除处罚
            switch (punishment.type) {
                case 'ban':
                    await guild.members.unban(target.id, '处罚已到期');
                    break;
                case 'mute':
                    const member = await guild.members.fetch(target.id);
                    if (member.isCommunicationDisabled()) {
                        await member.timeout(null, '处罚已到期');
                    }
                    break;
                // 警告不需要解除
            }

            // 2. 更新处罚状态
            await PunishmentModel.updateStatus(punishment.id, 'expired', '处罚已到期');

            // 3. 发送通知
            const logChannel = await client.channels.fetch(guildConfig.moderationLogChannelId);
            await logChannel.send({
                embeds: [{
                    color: 0x00FF00,
                    title: '处罚已到期',
                    description: `用户 ${target.tag} 的处罚已自动解除`,
                    fields: [
                        {
                            name: '处罚类型',
                            value: punishment.type,
                            inline: true
                        },
                        {
                            name: '处罚ID',
                            value: String(punishment.id),
                            inline: true
                        }
                    ],
                    timestamp: new Date()
                }]
            });

        } catch (error) {
            logTime(`处理处罚到期失败 [ID: ${punishment.id}]: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 撤销处罚
     * @param {Object} client - Discord客户端
     * @param {number} punishmentId - 处罚ID
     * @param {string} reason - 撤销原因
     * @param {string} executorId - 执行撤销的用户ID
     */
    static async revokePunishment(client, punishmentId, reason, executorId) {
        const punishment = await PunishmentModel.getPunishmentById(punishmentId);
        if (!punishment) throw new Error('处罚记录不存在');

        try {
            const guild = await client.guilds.fetch(punishment.guildId);
            const target = await client.users.fetch(punishment.userId);
            const executor = await client.users.fetch(executorId);

            // 1. 解除处罚
            switch (punishment.type) {
                case 'ban':
                    await guild.members.unban(target.id, reason);
                    break;
                case 'mute':
                    const member = await guild.members.fetch(target.id);
                    if (member.isCommunicationDisabled()) {
                        await member.timeout(null, reason);
                    }
                    break;
            }

            // 2. 更新处罚状态
            await PunishmentModel.updateStatus(punishment.id, 'revoked', reason);

            // 3. 发送通知
            const guildConfig = client.guildManager.getGuildConfig(guild.id);
            const logChannel = await client.channels.fetch(guildConfig.moderationLogChannelId);
            await logChannel.send({
                embeds: [{
                    color: 0x00FF00,
                    title: '处罚已撤销',
                    description: `用户 ${target.tag} 的处罚已被撤销`,
                    fields: [
                        {
                            name: '处罚类型',
                            value: punishment.type,
                            inline: true
                        },
                        {
                            name: '处罚ID',
                            value: String(punishment.id),
                            inline: true
                        },
                        {
                            name: '执行撤销',
                            value: executor.tag,
                            inline: true
                        },
                        {
                            name: '撤销原因',
                            value: reason
                        }
                    ],
                    timestamp: new Date()
                }]
            });

        } catch (error) {
            logTime(`撤销处罚失败 [ID: ${punishmentId}]: ${error.message}`, true);
            throw error;
        }
    }
}

export default PunishmentService; 