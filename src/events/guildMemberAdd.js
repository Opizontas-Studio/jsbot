import { Events } from 'discord.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { syncMemberRoles } from '../services/roleApplication.js';
import { logTime } from '../utils/logger.js';
import { executePunishmentAction } from '../utils/punishmentHelper.js';

export default {
    name: Events.GuildMemberAdd,
    async execute(member) {
        try {
            // 获取未过期处罚
            const punishments = await PunishmentModel.getUserPunishments(member.user.id, false);
            if (punishments && punishments.length > 0) {
                // 获取所有配置的服务器ID
                const allGuildIds = member.client.guildManager.getGuildIds();

                for (const punishment of punishments) {
                    // 永封类型已经在所有服务器执行过
                    if (punishment.type === 'ban') {
                        continue;
                    }

                    // 执行禁言和警告
                    const success = await executePunishmentAction(member.guild, punishment);

                    if (success) {
                        // 更新同步状态
                        const newSyncedServers = [...punishment.syncedServers, member.guild.id];
                        await PunishmentModel.updateSyncStatus(punishment.id, newSyncedServers);

                        logTime(`对加入用户 ${member.user.tag} 同步执行禁言处罚 (处罚ID: ${punishment.id})`);
                    }
                }
            }

            // 处理身份组同步
            try {
                const { syncedRoles } = await syncMemberRoles(member, true);
            } catch (error) {
                logTime(`处理用户 ${member.user.tag} 的身份组同步时发生错误: ${error.message}`, true);
            }
        } catch (error) {
            logTime(`处理用户 ${member.user.tag} 加入事件时发生错误: ${error.message}`, true);
            console.error(error);
        }
    },
};
