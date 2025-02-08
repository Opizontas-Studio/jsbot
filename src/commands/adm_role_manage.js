import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
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

            // 创建回复用的Embed
            const replyEmbed = new EmbedBuilder()
                .setTitle(`身份组${operation === 'add' ? '添加' : '移除'}操作`)
                .setColor(operation === 'add' ? 0x00ff00 : 0xff0000)
                .setTimestamp()
                .addFields(
                    { name: '目标用户', value: `${targetUser.tag}`, inline: true },
                    { name: '身份组', value: `${role.name}`, inline: true },
                    { name: '同步组', value: targetSyncGroup ? targetSyncGroup.name : '无', inline: true }
                );

            if (operation === 'remove') {
                // 检查用户是否有该身份组
                const member = await interaction.guild.members.fetch(targetUser.id);
                if (!member.roles.cache.has(role.id)) {
                    replyEmbed
                        .setColor(0xff9900)
                        .setDescription('❌ 用户没有该身份组，无需移除');
                    
                    await interaction.editReply({ embeds: [replyEmbed] });
                    return;
                }

                // 移除身份组
                const result = await revokeRole(
                    interaction.client,
                    targetUser.id,
                    role.id,
                    `由管理员 ${interaction.user.tag} 移除`,
                );

                if (result.success) {
                    // 更新回复Embed
                    replyEmbed
                        .setDescription('✅ 身份组移除成功')
                        .addFields(
                            { name: '成功服务器', value: result.successfulServers.join(', ') || '无' },
                            { name: '失败服务器', value: result.failedServers.map(s => s.name).join(', ') || '无' }
                        );

                    // 发送操作日志
                    const logEmbed = new EmbedBuilder()
                        .setTitle('身份组移除操作')
                        .setColor(0xff0000)
                        .setTimestamp()
                        .addFields(
                            { name: '执行者', value: `${interaction.user.tag}`, inline: true },
                            { name: '目标用户', value: `${targetUser.tag}`, inline: true },
                            { name: '身份组', value: `${role.name}`, inline: true },
                            { name: '成功服务器', value: result.successfulServers.join(', ') || '无' },
                            { name: '失败服务器', value: result.failedServers.map(s => s.name).join(', ') || '无' }
                        );

                    const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
                    if (logChannel) {
                        await logChannel.send({ embeds: [logEmbed] });
                    }
                } else {
                    replyEmbed
                        .setDescription('❌ 身份组移除失败')
                        .setColor(0xff0000);
                }
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

                            // 检查用户是否已有该身份组
                            if (member.roles.cache.has(roleToAdd.id)) {
                                logTime(`用户 ${member.user.tag} 在服务器 ${guild.name} 已有身份组 ${roleToAdd.name}，跳过`);
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

                if (successfulServers.length > 0) {
                    // 更新回复Embed
                    replyEmbed
                        .setDescription('✅ 身份组添加成功')
                        .addFields(
                            { name: '成功服务器', value: successfulServers.join(', ') || '无' },
                            { name: '失败服务器', value: failedServers.map(s => s.name).join(', ') || '无' }
                        );

                    // 发送操作日志
                    const logEmbed = new EmbedBuilder()
                        .setTitle('身份组添加操作')
                        .setColor(0x00ff00)
                        .setTimestamp()
                        .addFields(
                            { name: '执行者', value: `${interaction.user.tag}`, inline: true },
                            { name: '目标用户', value: `${targetUser.tag}`, inline: true },
                            { name: '身份组', value: `${role.name}`, inline: true },
                            { name: '成功服务器', value: successfulServers.join(', ') || '无' },
                            { name: '失败服务器', value: failedServers.map(s => s.name).join(', ') || '无' }
                        );

                    const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
                    if (logChannel) {
                        await logChannel.send({ embeds: [logEmbed] });
                    }
                } else {
                    replyEmbed
                        .setDescription('❌ 身份组添加失败')
                        .setColor(0xff0000);
                }
            }

            await interaction.editReply({ embeds: [replyEmbed] });
        } catch (error) {
            await handleCommandError(interaction, error, '管理身份组');
        }
    },
}; 