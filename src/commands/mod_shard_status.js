import { SlashCommandBuilder } from 'discord.js';
import { monitorService } from '../services/monitorService.js';
import { checkModeratorPermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 3,
    data: new SlashCommandBuilder().setName('系统状态').setDescription('查看当前系统运行状态'),

    async execute(interaction, guildConfig) {
        try {
            // 需要版主或管理员权限
            if (!(await checkModeratorPermission(interaction, guildConfig))) {
                return;
            }

            // 直接使用监控服务创建状态消息
            const embed = await monitorService.createStatusEmbed(interaction.client);
            await interaction.editReply({ embeds: [embed] });

            logTime(`用户 ${interaction.user.tag} 查看了系统状态`);
        } catch (error) {
            await handleCommandError(interaction, error, '系统状态');
        }
    },
};
