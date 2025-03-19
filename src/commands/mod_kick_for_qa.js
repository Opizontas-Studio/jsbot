import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { revokeRolesByGroups } from '../services/roleApplication.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

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
        )
        .addStringOption(option =>
            option
                .setName('理由')
                .setDescription('处罚理由')
                .setRequired(false)
        ),

    async execute(interaction, guildConfig) {
        try {
            // 检查管理权限（版主及以上）
            if (!(await checkAndHandlePermission(interaction, guildConfig.ModeratorRoleIds))) {
                return;
            }

            const targetUser = interaction.options.getUser('目标');
            const reason = interaction.options.getString('理由') ?? '违反问答规范';
            const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));

            // 找到缓冲区和已验证的同步组
            const targetGroups = roleSyncConfig.syncGroups.filter(group => 
                ['缓冲区', '已验证'].includes(group.name)
            );

            if (!targetGroups.length) {
                await interaction.editReply('❌ 未找到缓冲区或已验证的身份组配置');
                return;
            }

            // 使用新的批量处理函数
            const result = await revokeRolesByGroups(
                interaction.client,
                targetUser.id,
                targetGroups,
                `由管理员 ${interaction.user.tag} 执行答题处罚`
            );

            // 创建回复用的Embed
            const replyEmbed = new EmbedBuilder()
                .setTitle('答题处罚操作')
                .setColor(0xff0000)
                .setTimestamp()
                .addFields(
                    { name: '目标用户', value: targetUser.tag, inline: true },
                    { name: '执行者', value: interaction.user.tag, inline: true }
                );

            // 更改判断条件：只要有任何服务器成功，就视为操作成功
            if (result.successfulServers.length > 0) {
                replyEmbed
                    .setDescription('✅ 处罚执行成功')
                    .addFields(
                        { name: '成功服务器', value: result.successfulServers.join(', ') || '无' },
                    );

                // 发送操作日志
                const logEmbed = new EmbedBuilder()
                    .setTitle('答题处罚操作')
                    .setColor(0xff0000)
                    .setTimestamp()
                    .addFields(
                        { name: '执行者', value: interaction.user.tag, inline: true },
                        { name: '目标用户', value: targetUser.tag, inline: true },
                        { name: '处罚理由', value: reason },
                        { name: '成功服务器', value: result.successfulServers.join(', ') || '无' },
                    );

                const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
                if (logChannel) {
                    await logChannel.send({ embeds: [logEmbed] });
                }

                // 发送简单的通知消息到执行频道
                const notifyEmbed = new EmbedBuilder()
                    .setDescription(`<@${targetUser.id}> 被管理员 <@${interaction.user.id}> 执行了重新答题处罚。\n理由：${reason}`)
                    .setColor(0xff0000)
                    .setTimestamp();

                await interaction.channel.send({ 
                    embeds: [notifyEmbed],
                    allowedMentions: { users: [targetUser.id] } // 只@ 被处罚的用户
                });
                logTime(`管理员 ${interaction.user.tag} 对 ${targetUser.tag} 执行了重新答题处罚。理由：${reason}`, true);
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