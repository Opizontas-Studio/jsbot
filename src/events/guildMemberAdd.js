import { Events } from 'discord.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { logTime } from '../utils/logger.js';
import { executePunishmentAction } from '../utils/punishmentHelper.js';

export default {
    name: Events.GuildMemberAdd,
    async execute(member) {
        try {
            // 获取未过期处罚
            const punishments = await PunishmentModel.getUserPunishments(member.user.id, false);
            if (!punishments || punishments.length === 0) {
                return;
            }

            // 获取所有配置的服务器ID
            const allGuildIds = member.client.guildManager.getGuildIds();

            for (const punishment of punishments) {
                // 只对永封类型的处罚进行跳过检查
                if (punishment.type === 'ban' && punishment.syncedServers.includes(member.guild.id)) {
                    continue;
                }

                if (punishment.type === 'ban') {
                    // 对于永封，发送私信后立即执行
                    try {
                        await member.user.send({
                            content: [
                                '⚠️ **永封通知**',
                                `您在服务器 ${member.guild.name} 有未过期的永封处罚：`,
                                `• 原因：${punishment.reason}`,
                                `• 执行时间：<t:${Math.floor(punishment.createdAt / 1000)}:F>`,
                                '由于处罚仍然有效，您已被立即移出服务器。'
                            ].join('\n')
                        });
                    } catch (error) {
                        logTime(`无法向用户 ${member.user.tag} 发送永封通知: ${error.message}`, true);
                    }
                }

                // 直接执行处罚
                const success = await executePunishmentAction(member.guild, punishment);
                
                if (success) {
                    // 更新同步状态
                    const newSyncedServers = [...punishment.syncedServers, member.guild.id];
                    await PunishmentModel.updateSyncStatus(punishment.id, newSyncedServers);
                    
                    logTime(
                        `对加入用户 ${member.user.tag} 同步执行${punishment.type === 'ban' ? '永封' : '禁言'}处罚 ` +
                        `(处罚ID: ${punishment.id})`
                    );

                    // 如果是永封且已同步到所有服务器，则标记为过期
                    if (punishment.type === 'ban' && 
                        allGuildIds.every(guildId => newSyncedServers.includes(guildId))) {
                        await PunishmentModel.updateStatus(punishment.id, 'expired', '已在所有服务器执行永封');
                        logTime(`永封处罚 ${punishment.id} 已在所有服务器执行完毕，标记为过期`);
                    }
                }
            }
        } catch (error) {
            logTime(`处理用户 ${member.user.tag} 加入事件时发生错误: ${error.message}`, true);
            console.error(error);
        }
    },
}; 