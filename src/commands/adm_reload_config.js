import { SlashCommandBuilder } from 'discord.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkAndHandlePermission, handleCommandError, measureTime } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 30,
    data: new SlashCommandBuilder()
        .setName('重载配置')
        .setDescription('热重载config.json配置，无需重启机器人'),

    async execute(interaction, guildConfig) {
        // 检查用户是否有执行权限（仅限管理员）
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        try {
            const reloadTimer = measureTime();

            // 先回复一个初始消息，表明命令已收到
            await interaction.editReply({
                content: '🔄 正在重新加载配置...',
            });

            // 读取最新的配置文件
            const configPath = join(process.cwd(), 'config.json');
            let config;

            try {
                const configData = readFileSync(configPath, 'utf8');
                config = JSON.parse(configData);
            } catch (error) {
                throw new Error(`无法读取或解析配置文件: ${error.message}`);
            }

            // 重新加载GuildManager配置
            const guildManager = interaction.client.guildManager;
            const changes = guildManager.resetConfig(config);

            // 构建简化的变更报告
            let statusMessage = `✅ 配置重载完成，总用时: ${reloadTimer()}秒\n` +
                `📊 当前配置的服务器总数: ${changes.total}个\n`;

            // 服务器更新是最常见的情况
            if (changes.updated.length > 0) {
                statusMessage += `🔄 已更新 ${changes.updated.length} 个服务器的配置`;
            } else {
                statusMessage += `ℹ️ 配置已重载，无变更`;
            }

            // 仅在不常见的情况下显示新增或删除信息
            if (changes.added.length > 0 || changes.removed.length > 0) {
                statusMessage += "\n⚠️ 注意：检测到服务器列表变化";
                if (changes.added.length > 0) {
                    statusMessage += `\n📥 新增服务器: ${changes.added.length}个`;
                }
                if (changes.removed.length > 0) {
                    statusMessage += `\n📤 移除服务器: ${changes.removed.length}个`;
                }
            }

            // 更新回复消息，显示结果
            await interaction.editReply({ content: statusMessage });

            // 记录日志
            logTime(`配置重载完成，服务器总数: ${changes.total}个`);
        } catch (error) {
            await handleCommandError(interaction, error, '重载配置');
        }
    },
};
