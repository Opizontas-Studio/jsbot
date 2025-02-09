import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { revokeRole } from '../services/roleApplication.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';

const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

export default {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('答题处罚')
        .setDescription('移除用户在所有服务器的缓冲区和已验证身份组')
        .addUserOption(option => 
            option
                .setName('目标')
                .setDescription('要处罚的用户')
                .setRequired(true)
        ),

    async execute(interaction, guildConfig) {
        try {
            // 检查管理权限（版主及以上）
            if (!(await checkAndHandlePermission(interaction, guildConfig.ModeratorRoleIds))) {
                return;
            }

            const targetUser = interaction.options.getUser('目标');
            const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));

            // 找到缓冲区和已验证的同步组
            const targetGroups = roleSyncConfig.syncGroups.filter(group => 
                ['缓冲区', '已验证'].includes(group.name)
            );

            if (!targetGroups.length) {
                await interaction.editReply('❌ 未找到缓冲区或已验证的身份组配置');
                return;
            }

            // 获取当前服务器的身份组ID
            const roleIds = targetGroups.map(group => group.roles[interaction.guild.id]);
            
            // 创建回复用的Embed
            const replyEmbed = new EmbedBuilder()
                .setTitle('答题处罚操作')
                .setColor(0xff0000)
                .setTimestamp()
                .addFields(
                    { name: '目标用户', value: targetUser.tag, inline: true },
                    { name: '执行者', value: interaction.user.tag, inline: true }
                );

            // 记录所有成功和失败的服务器
            const allSuccessfulServers = new Set();
            const allFailedServers = new Set();

            // 为每个身份组执行移除操作
            for (const roleId of roleIds) {
                if (!roleId) continue;

                const result = await revokeRole(
                    interaction.client,
                    targetUser.id,
                    roleId,
                    `由管理员 ${interaction.user.tag} 执行答题处罚`
                );

                // 合并结果
                result.successfulServers.forEach(server => allSuccessfulServers.add(server));
                result.failedServers.forEach(server => allFailedServers.add(server.name));
            }

            // 更新回复Embed
            if (allSuccessfulServers.size > 0) {
                replyEmbed
                    .setDescription('✅ 处罚执行成功')
                    .addFields(
                        { name: '成功服务器', value: Array.from(allSuccessfulServers).join(', ') || '无' },
                        { name: '失败服务器', value: Array.from(allFailedServers).join(', ') || '无' }
                    );

                // 发送操作日志
                const logEmbed = new EmbedBuilder()
                    .setTitle('答题处罚操作')
                    .setColor(0xff0000)
                    .setTimestamp()
                    .addFields(
                        { name: '执行者', value: interaction.user.tag, inline: true },
                        { name: '目标用户', value: targetUser.tag, inline: true },
                        { name: '成功服务器', value: Array.from(allSuccessfulServers).join(', ') || '无' },
                        { name: '失败服务器', value: Array.from(allFailedServers).join(', ') || '无' }
                    );

                const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
                if (logChannel) {
                    await logChannel.send({ embeds: [logEmbed] });
                }

                // 发送简单的通知消息到执行频道
                const notifyEmbed = new EmbedBuilder()
                    .setDescription(`<@${targetUser.id}> 被管理员 <@${interaction.user.id}> 执行了重新答题处罚。`)
                    .setColor(0xff0000)
                    .setTimestamp();

                await interaction.channel.send({ 
                    embeds: [notifyEmbed],
                    allowedMentions: { users: [targetUser.id] } // 只@ 被处罚的用户
                });
                logTime(`管理员 ${interaction.user.tag} 对 ${targetUser.tag} 执行了重新答题处罚。`, true);
            } else {
                replyEmbed
                    .setDescription('❌ 处罚执行失败')
                    .setColor(0xff0000);
                logTime(`管理员 ${interaction.user.tag} 对 ${targetUser.tag} 执行重新答题处罚失败`, true);
            }

            await interaction.editReply({ embeds: [replyEmbed] });
        } catch (error) {
            await handleCommandError(interaction, error, '答题处罚');
        }
    },
}; 