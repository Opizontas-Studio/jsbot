import { SlashCommandBuilder } from 'discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { revokeRole } from '../services/roleApplication.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

export default {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('管理身份组')
        .setDescription('添加或移除用户的身份组')
        .addStringOption(option =>
            option
                .setName('操作')
                .setDescription('要执行的操作')
                .setRequired(true)
                .addChoices(
                    { name: '添加', value: 'add' },
                    { name: '移除', value: 'remove' },
                ),
        )
        .addUserOption(option => 
            option
                .setName('用户')
                .setDescription('目标用户')
                .setRequired(true),
        )
        .addRoleOption(option =>
            option
                .setName('身份组')
                .setDescription('要操作的身份组')
                .setRequired(true),
        ),

    async execute(interaction, guildConfig) {
        try {
            // 检查管理权限
            if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
                return;
            }

            const operation = interaction.options.getString('操作');
            const targetUser = interaction.options.getUser('用户');
            const role = interaction.options.getRole('身份组');

            // 读取身份组同步配置
            const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));

            // 查找同步组
            let targetSyncGroup = null;
            for (const syncGroup of roleSyncConfig.syncGroups) {
                if (syncGroup.roles[interaction.guild.id] === role.id) {
                    targetSyncGroup = syncGroup;
                    break;
                }
            }

            if (operation === 'remove') {
                // 移除身份组
                const result = await revokeRole(
                    interaction.client,
                    targetUser.id,
                    role.id,
                    `由管理员 ${interaction.user.tag} 移除`,
                );

                // 发送操作日志
                const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
                if (logChannel) {
                    await logChannel.send({
                        content: [
                            `📝 **身份组移除操作报告**`,
                            `- 执行者：${interaction.user.tag} (${interaction.user.id})`,
                            `- 目标用户：${targetUser.tag} (${targetUser.id})`,
                            `- 身份组：${role.name} (${role.id})`,
                            `- 成功服务器：${result.successfulServers.join(', ')}`,
                            result.failedServers.length > 0 ? `- 失败服务器：${result.failedServers.map(s => s.name).join(', ')}` : '',
                        ].join('\n'),
                    });
                }

                await interaction.editReply({
                    content: result.success
                        ? `✅ 已成功移除身份组\n成功服务器：${result.successfulServers.join(', ')}`
                        : '❌ 移除身份组失败',
                });
            } else {
                // 添加身份组
                const successfulServers = [];
                const failedServers = [];

                await globalRequestQueue.add(async () => {
                    // 遍历所有需要同步的服务器
                    for (const [guildId, syncRoleId] of Object.entries(targetSyncGroup?.roles || { [interaction.guild.id]: role.id })) {
                        try {
                            const guild = await interaction.client.guilds.fetch(guildId);
                            const member = await guild.members.fetch(targetUser.id);
                            const roleToAdd = await guild.roles.fetch(syncRoleId);

                            if (!roleToAdd) {
                                failedServers.push({ id: guildId, name: guild.name });
                                continue;
                            }

                            await member.roles.add(roleToAdd, `由管理员 ${interaction.user.tag} 添加`);
                            successfulServers.push(guild.name);
                            logTime(`已在服务器 ${guild.name} 为用户 ${member.user.tag} 添加身份组 ${roleToAdd.name}`);
                        } catch (error) {
                            logTime(`在服务器 ${guildId} 添加身份组失败: ${error.message}`, true);
                            failedServers.push({ id: guildId, name: guildId });
                        }
                    }
                }, 3);

                // 发送操作日志
                const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
                if (logChannel) {
                    await logChannel.send({
                        content: [
                            `📝 **身份组添加操作报告**`,
                            `- 执行者：${interaction.user.tag} (${interaction.user.id})`,
                            `- 目标用户：${targetUser.tag} (${targetUser.id})`,
                            `- 身份组：${role.name} (${role.id})`,
                            `- 成功服务器：${successfulServers.join(', ')}`,
                            failedServers.length > 0 ? `- 失败服务器：${failedServers.map(s => s.name).join(', ')}` : '',
                        ].join('\n'),
                    });
                }

                await interaction.editReply({
                    content: successfulServers.length > 0
                        ? `✅ 已成功添加身份组\n成功服务器：${successfulServers.join(', ')}`
                        : '❌ 添加身份组失败',
                });
            }
        } catch (error) {
            await handleCommandError(interaction, error, '管理身份组');
        }
    },
}; 