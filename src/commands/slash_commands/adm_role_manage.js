import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { manageRolesByGroups } from '../../services/role/roleApplication.js';
import { handleCommandError } from '../../utils/helper.js';

const roleSyncConfigPath = join(process.cwd(), 'data', 'roleSyncConfig.json');

// 使用已有的紧急处理身份组ID
const EMERGENCY_ROLE_IDS = ['1289224017789583453', '1337441650137366705', '1336734406609473720'];

export default {
    cooldown: 3,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('管理身份组')
        .setDescription('添加或移除用户的身份组')
        .addStringOption(option =>
            option
                .setName('操作')
                .setDescription('要执行的操作')
                .setRequired(true)
                .addChoices({ name: '添加', value: 'add' }, { name: '移除', value: 'remove' }),
        )
        .addUserOption(option => option.setName('用户').setDescription('目标用户').setRequired(true))
        .addRoleOption(option => option.setName('身份组').setDescription('要操作的身份组').setRequired(true)),

    async execute(interaction, guildConfig) {
        try {
            // 检查权限：管理员或紧急处理身份组
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const hasAdminRole = member.roles.cache.some(role => guildConfig.AdministratorRoleIds.includes(role.id));
            const hasEmergencyRole = member.roles.cache.some(role => EMERGENCY_ROLE_IDS.includes(role.id));

            if (!hasAdminRole && !hasEmergencyRole) {
                await interaction.editReply({
                    content: '❌ 你没有权限执行此命令',
                    flags: ['Ephemeral'],
                });
                return;
            }

            const operation = interaction.options.getString('操作');
            const targetUser = interaction.options.getUser('用户');
            const role = interaction.options.getRole('身份组');

            // 创建回复用的Embed
            const replyEmbed = new EmbedBuilder()
                .setTitle(`身份组${operation === 'add' ? '添加' : '移除'}操作`)
                .setColor(operation === 'add' ? 0x00ff00 : 0xff0000)
                .setTimestamp()
                .addFields(
                    { name: '目标用户', value: `${targetUser.tag}`, inline: true },
                    { name: '身份组', value: `${role.name}`, inline: true },
                );

            if (operation === 'remove') {
                // 检查用户是否有该身份组
                const targetMember = await interaction.guild.members.fetch(targetUser.id);

                // 检查目标用户是否有管理员身份组，只有当执行者是管理员（非紧急处理）时才限制
                const targetHasAdminRole = targetMember.roles.cache.some(role =>
                    guildConfig.AdministratorRoleIds.includes(role.id),
                );

                if (targetHasAdminRole && hasAdminRole && !hasEmergencyRole) {
                    replyEmbed
                        .setColor(0xff0000)
                        .setDescription('❌ 管理员无法移除其他管理员的身份组，请使用紧急处理权限');

                    await interaction.editReply({ embeds: [replyEmbed] });
                    return;
                }

                if (!targetMember.roles.cache.has(role.id)) {
                    replyEmbed.setColor(0xff9900).setDescription('❌ 用户没有该身份组，无需移除');

                    await interaction.editReply({ embeds: [replyEmbed] });
                    return;
                }

                // 构造临时同步组
                const tempSyncGroup = {
                    name: role.name,
                    roles: {
                        [interaction.guild.id]: role.id,
                    },
                };

                // 读取身份组同步配置，查找是否有对应的同步组
                const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));
                for (const syncGroup of roleSyncConfig.syncGroups) {
                    if (Object.values(syncGroup.roles).includes(role.id)) {
                        tempSyncGroup.roles = syncGroup.roles;
                        break;
                    }
                }

                // 移除身份组
                const result = await manageRolesByGroups(
                    interaction.client,
                    targetUser.id,
                    [tempSyncGroup],
                    `由管理员 ${interaction.user.tag} 移除`,
                    true // 设置为移除操作
                );

                if (result.success) {
                    // 更新回复Embed
                    replyEmbed
                        .setDescription('✅ 身份组移除成功')
                        .addFields(
                            { name: '成功服务器', value: result.successfulServers.join(', ') || '无' },
                            { name: '失败服务器', value: result.failedServers.map(s => s.name).join(', ') || '无' },
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
                            { name: '失败服务器', value: result.failedServers.map(s => s.name).join(', ') || '无' },
                        );

                    const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
                    if (logChannel) {
                        await logChannel.send({ embeds: [logEmbed] });
                    }
                } else {
                    replyEmbed.setDescription('❌ 身份组移除失败').setColor(0xff0000);
                }
            } else {
                // 添加身份组
                // 读取身份组同步配置，查找是否有对应的同步组
                const roleSyncConfig = JSON.parse(readFileSync(roleSyncConfigPath, 'utf8'));
                let foundSyncGroup = roleSyncConfig.syncGroups.find(group =>
                    Object.values(group.roles).includes(role.id),
                );

                // 构造临时同步组
                const tempSyncGroup = {
                    name: role.name,
                    roles: {
                        [interaction.guild.id]: role.id,
                    },
                };

                // 如果找到了对应的同步组，使用该同步组的配置
                if (foundSyncGroup) {
                    tempSyncGroup.roles = foundSyncGroup.roles;
                }

                // 使用manageRolesByGroups函数批量添加身份组
                const result = await manageRolesByGroups(
                    interaction.client,
                    targetUser.id,
                    [tempSyncGroup],
                    `由管理员 ${interaction.user.tag} 添加`,
                    false // 设置为添加操作
                );

                if (result.success) {
                    // 更新回复Embed
                    replyEmbed
                        .setDescription('✅ 身份组添加成功')
                        .addFields(
                            { name: '成功服务器', value: result.successfulServers.join(', ') || '无' },
                            { name: '失败服务器', value: result.failedServers.map(s => s.name).join(', ') || '无' },
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
                            { name: '成功服务器', value: result.successfulServers.join(', ') || '无' },
                            { name: '失败服务器', value: result.failedServers.map(s => s.name).join(', ') || '无' },
                        );

                    const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
                    if (logChannel) {
                        await logChannel.send({ embeds: [logEmbed] });
                    }
                } else {
                    replyEmbed.setDescription('❌ 身份组添加失败').setColor(0xff0000);
                }
            }

            await interaction.editReply({ embeds: [replyEmbed] });
        } catch (error) {
            await handleCommandError(interaction, error, '管理身份组');
        }
    },
};
