import { Events } from 'discord.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import PunishmentService from '../services/punishmentService.js';
import { syncMemberRoles } from '../services/roleApplication.js';
import { logTime } from '../utils/logger.js';

export default {
    name: Events.GuildMemberAdd,
    async execute(member) {
        try {
            // 获取未过期处罚
            const punishments = await PunishmentModel.getUserPunishments(member.user.id, false);
            if (punishments && punishments.length > 0) {
                for (const punishment of punishments) {
                    // 执行禁言和警告
                    const success = await PunishmentService.executePunishmentAction(member.guild, punishment, true);

                    if (success) {
                        // 更新同步状态
                        const newSyncedServers = [...punishment.syncedServers, member.guild.id];
                        await PunishmentModel.updateSyncStatus(punishment.id, newSyncedServers);

                        logTime(`对加入用户 ${member.user.tag} 同步执行处罚 (处罚ID: ${punishment.id})`);
                    }
                }
            }

            // 处理身份组同步
            try {
                await syncMemberRoles(member, true);
            } catch (error) {
                logTime(`处理用户 ${member.user.tag} 的身份组同步时发生错误: ${error.message}`, true);
            }
        } catch (error) {
            logTime(`处理用户 ${member.user.tag} 加入事件时发生错误: ${error.message}`, true);
        }
    },
};
