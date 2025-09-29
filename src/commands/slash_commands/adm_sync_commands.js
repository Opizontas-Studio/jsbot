import { Collection, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAndHandlePermission, handleCommandError, loadCommandFiles, measureTime } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 60,
    ephemeral: true,
    data: new SlashCommandBuilder().setName('同步指令').setDescription('检查并同步当前服务器的Discord指令'),

    async execute(interaction, guildConfig) {
        // 检查用户是否有执行权限
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        try {
            const deployTimer = measureTime();
            const commandsPath = join(dirname(fileURLToPath(import.meta.url)));
            const localCommands = await loadCommandFiles(commandsPath);
            const localCommandData = Array.from(localCommands.values()).map(cmd => cmd.data.toJSON());

            // 创建 REST 实例
            const rest = new REST({ version: '10' }).setToken(interaction.client.token);

            logTime('开始检查命令同步状态...');

            // 获取当前服务器的已部署命令
            const deployedCommands = await rest.get(
                Routes.applicationGuildCommands(interaction.client.application.id, interaction.guildId),
            );

            // 分析需要更新和删除的命令
            const commandsToUpdate = [];
            const commandsToDelete = [];

            // 检查已部署的命令
            for (const deployedCmd of deployedCommands) {
                const localCmd = localCommandData.find(cmd => cmd.name === deployedCmd.name);
                if (!localCmd) {
                    // 如果本地没有这个命令，标记为需要删除
                    commandsToDelete.push(deployedCmd);
                    continue;
                }

                // 比较命令的详细配置是否相同
                if (JSON.stringify(deployedCmd) !== JSON.stringify(localCmd)) {
                    commandsToUpdate.push(localCmd);
                }
            }

            // 检查本地新增的命令
            for (const localCmd of localCommandData) {
                if (!deployedCommands.some(cmd => cmd.name === localCmd.name)) {
                    commandsToUpdate.push(localCmd);
                }
            }

            // 构建状态报告
            const statusReport = [];
            if (commandsToDelete.length > 0) {
                statusReport.push(
                    `需要删除 ${commandsToDelete.length} 个命令: ${commandsToDelete.map(cmd => cmd.name).join(', ')}`,
                );
            }
            if (commandsToUpdate.length > 0) {
                statusReport.push(
                    `需要更新 ${commandsToUpdate.length} 个命令: ${commandsToUpdate.map(cmd => cmd.name).join(', ')}`,
                );
            }

            if (commandsToDelete.length === 0 && commandsToUpdate.length === 0) {
                await interaction.editReply({
                    content: '✅ 所有命令都已是最新状态，无需同步。',
                });
                return;
            }

            // 执行更新
            if (commandsToDelete.length > 0) {
                for (const cmd of commandsToDelete) {
                    await rest.delete(
                        Routes.applicationGuildCommand(interaction.client.application.id, interaction.guildId, cmd.id),
                    );
                    logTime(`已删除命令: ${cmd.name}`);
                }
            }

            if (commandsToUpdate.length > 0) {
                await rest.put(
                    Routes.applicationGuildCommands(interaction.client.application.id, interaction.guildId),
                    { body: localCommandData },
                );
                logTime(`已更新 ${commandsToUpdate.length} 个命令`);
            }

            // 更新客户端的commands集合
            interaction.client.commands = new Collection(localCommands);

            await interaction.editReply({
                content: `✅ 命令同步完成，总用时: ${deployTimer()}秒\n${statusReport.join('\n')}`,
            });
        } catch (error) {
            await handleCommandError(interaction, error, '同步命令');
        }
    },
};
