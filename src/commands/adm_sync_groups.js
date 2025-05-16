import { SlashCommandBuilder } from 'discord.js';
import { getRoleSyncConfig } from '../services/roleApplication.js';
import { delay } from '../utils/concurrency.js';
import { handleConfirmationButton } from '../utils/confirmationHelper.js';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

const EMERGENCY_ROLE_IDS = ['1289224017789583453', '1337441650137366705', '1336734406609473720'];

export default {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('同步身份组同步组')
        .setDescription('同步不同服务器间的同步组成员')
        .addStringOption(option =>
            option.setName('同步组')
                .setDescription('要同步的同步组名称')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    // 处理同步组名称的自动完成
    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused().toLowerCase();

        try {
            // 从配置中获取所有同步组
            const roleSyncConfig = getRoleSyncConfig();
            const syncGroups = roleSyncConfig.syncGroups;

            // 过滤匹配的同步组名称
            const filtered = syncGroups
                .filter(group => group.name.toLowerCase().includes(focusedValue))
                .map(group => ({
                    name: group.name,
                    value: group.name
                }));

            // 返回结果（最多25个选项）
            await interaction.respond(filtered.slice(0, 25));
        } catch (error) {
            logTime(`同步组自动完成请求失败: ${error.message}`, true);
            // 错误时返回空列表
            await interaction.respond([]);
        }
    },

    async execute(interaction, guildConfig) {
        try {
            await interaction.deferReply();

            // 检查用户权限（紧急处理级别）
            const hasEmergencyRole = EMERGENCY_ROLE_IDS.some(roleId =>
                interaction.member.roles.cache.has(roleId)
            );

            if (!hasEmergencyRole) {
                await interaction.editReply({
                    content: '❌ 您没有执行此命令的权限，此命令需要紧急处理权限。',
                });
                return;
            }

            // 获取同步组名称
            const syncGroupName = interaction.options.getString('同步组');

            // 获取同步组配置
            const roleSyncConfig = getRoleSyncConfig();
            const syncGroup = roleSyncConfig.syncGroups.find(group => group.name === syncGroupName);

            if (!syncGroup) {
                await interaction.editReply({
                    content: `❌ 找不到名为 "${syncGroupName}" 的同步组，请检查输入。`,
                });
                return;
            }

            await interaction.editReply({
                content: `⏳ 正在分析同步组 "${syncGroupName}" 的成员情况...`,
            });

            // 获取所有相关服务器
            const guildIds = Object.keys(syncGroup.roles);
            if (guildIds.length < 2) {
                await interaction.editReply({
                    content: '❌ 此同步组配置不完整，至少需要两个服务器才能进行同步。',
                });
                return;
            }

            // 获取所有服务器的成员列表和对应的身份组成员
            const guildMembers = new Map(); // 存储每个服务器的所有成员
            const roleMembers = new Map();  // 存储每个服务器中有特定身份组的成员

            for (const guildId of guildIds) {
                try {
                    const guild = await interaction.client.guilds.fetch(guildId);
                    const members = await guild.members.fetch();
                    guildMembers.set(guildId, members);

                    const roleId = syncGroup.roles[guildId];
                    const membersWithRole = members.filter(member =>
                        !member.user.bot && member.roles.cache.has(roleId)
                    );
                    roleMembers.set(guildId, membersWithRole);
                } catch (error) {
                    logTime(`获取服务器 ${guildId} 成员时出错: ${error.message}`, true);
                    await interaction.editReply({
                        content: `❌ 获取服务器成员时出错: ${error.message}`,
                    });
                    return;
                }
            }

            // 分析需要同步的成员
            const syncNeeded = new Map(); // 存储每个服务器需要添加身份组的成员

            // 对于每个服务器，检查其他服务器中有该身份组但在当前服务器没有的成员
            for (const targetGuildId of guildIds) {
                const targetMembers = guildMembers.get(targetGuildId);
                const targetRoleMembers = roleMembers.get(targetGuildId);
                const targetRoleId = syncGroup.roles[targetGuildId];

                // 这个服务器需要添加身份组的成员列表
                const membersToAdd = [];

                // 遍历其他服务器
                for (const sourceGuildId of guildIds) {
                    if (sourceGuildId === targetGuildId) continue;

                    const sourceRoleMembers = roleMembers.get(sourceGuildId);

                    // 检查源服务器中有身份组的成员
                    for (const [memberId, sourceMember] of sourceRoleMembers) {
                        // 检查这个成员是否在目标服务器中
                        const targetMember = targetMembers.get(memberId);

                        // 如果成员在目标服务器中，但没有对应身份组，则需要添加
                        if (targetMember && !targetMember.roles.cache.has(targetRoleId)) {
                            membersToAdd.push({
                                id: memberId,
                                tag: sourceMember.user.tag,
                                sourceGuildId,
                            });
                        }
                    }
                }

                if (membersToAdd.length > 0) {
                    syncNeeded.set(targetGuildId, membersToAdd);
                }
            }

            // 如果没有需要同步的成员
            if (syncNeeded.size === 0) {
                await interaction.editReply({
                    content: `✅ 同步组 "${syncGroupName}" 的所有成员已经同步，无需进行操作。`,
                });
                return;
            }

            // 生成同步摘要
            let summaryText = `📊 同步组 "${syncGroupName}" 同步情况分析完成\n\n`;

            for (const [guildId, membersToAdd] of syncNeeded) {
                const guild = await interaction.client.guilds.fetch(guildId);
                summaryText += `**服务器: ${guild.name}**\n需要添加身份组的成员数量: ${membersToAdd.length}\n\n`;
            }

            const totalMembersCount = Array.from(syncNeeded.values())
                .reduce((total, members) => total + members.length, 0);

            // 创建确认按钮
            await handleConfirmationButton({
                interaction,
                customId: 'confirm_sync_groups',
                buttonLabel: '确认同步',
                embed: {
                    color: 0xff9900,
                    title: '⚠️ 同步身份组确认',
                    description: `您确定要同步 "${syncGroupName}" 同步组的成员吗？`,
                    fields: [
                        {
                            name: '同步组名称',
                            value: syncGroupName,
                            inline: true,
                        },
                        {
                            name: '总需同步成员数',
                            value: `${totalMembersCount}`,
                            inline: true,
                        },
                        {
                            name: '同步详情',
                            value: summaryText,
                        },
                        {
                            name: '执行人',
                            value: `<@${interaction.user.id}>`,
                            inline: true,
                        }
                    ],
                },
                onConfirm: async confirmation => {
                    await confirmation.deferUpdate();
                    await interaction.editReply({
                        content: `⏳ 开始同步 "${syncGroupName}" 同步组的成员...`,
                        components: [],
                        embeds: [],
                    });

                    logTime(`开始同步组 "${syncGroupName}" 的成员同步操作，操作服务器: ${interaction.guild.name}`);

                    let successCount = 0;
                    let failCount = 0;
                    let lastProgressUpdate = Date.now();
                    let processedCount = 0;
                    const totalCount = totalMembersCount;

                    // 同步每个服务器的成员
                    for (const [guildId, membersToAdd] of syncNeeded) {
                        try {
                            const guild = await interaction.client.guilds.fetch(guildId);
                            const roleId = syncGroup.roles[guildId];

                            // 处理每个需要添加身份组的成员
                            for (const memberInfo of membersToAdd) {
                                try {
                                    const member = await guild.members.fetch(memberInfo.id);

                                    // 添加身份组
                                    await member.roles.add(roleId, `同步组同步: ${syncGroupName}`);
                                    successCount++;

                                    logTime(`已为成员 ${member.user.tag} 在服务器 ${guild.name} 添加同步组 "${syncGroupName}" 的身份组`);
                                } catch (error) {
                                    logTime(`为成员 ${memberInfo.tag} (${memberInfo.id}) 在服务器 ${guild.name} 添加身份组失败: ${error.message}`, true);
                                    failCount++;
                                }

                                processedCount++;

                                // 更新进度（限制更新频率为1秒一次）
                                const now = Date.now();
                                if (now - lastProgressUpdate > 1000) {
                                    lastProgressUpdate = now;
                                    await interaction.editReply({
                                        content: `⏳ 正在同步身份组... (${processedCount}/${totalCount})\n✅ 成功: ${successCount}\n❌ 失败: ${failCount}`,
                                    });
                                }

                                // 等待500ms再处理下一个成员，避免请求过快
                                await delay(500);
                            }
                        } catch (error) {
                            logTime(`同步服务器 ${guildId} 的成员时出错: ${error.message}`, true);
                        }
                    }

                    // 发送最终报告
                    await interaction.editReply({
                        content: [
                            `✅ 同步组 "${syncGroupName}" 的同步操作已完成！`,
                            `📊 处理成员总数: ${totalCount}`,
                            `✅ 成功数量: ${successCount}`,
                            `❌ 失败数量: ${failCount}`,
                        ].join('\n'),
                    });

                    // 记录到日志频道
                    if (guildConfig.threadLogThreadId) {
                        try {
                            const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
                            await logChannel.send({
                                embeds: [
                                    {
                                        color: 0x0099ff,
                                        title: '同步组同步操作报告',
                                        description: [
                                            `执行者: ${interaction.user.tag}`,
                                            `同步组: ${syncGroupName}`,
                                            `处理总数: ${totalCount}`,
                                            `成功数量: ${successCount}`,
                                            `失败数量: ${failCount}`,
                                        ].join('\n'),
                                        timestamp: new Date(),
                                        footer: { text: '自动化系统' },
                                    },
                                ],
                            });
                        } catch (error) {
                            logTime(`发送同步操作日志时出错: ${error.message}`, true);
                        }
                    }

                    // 记录操作完成的日志
                    logTime(
                        `同步组 "${syncGroupName}" 同步完成 - 服务器: ${interaction.guild.name} (${interaction.guild.id}), ` +
                        `执行者: ${interaction.user.tag}, 总数: ${totalCount}, 成功: ${successCount}, 失败: ${failCount}`,
                    );
                },
                onTimeout: async interaction => {
                    await interaction.editReply({
                        embeds: [
                            {
                                color: 0x808080,
                                title: '❌ 确认已超时',
                                description: '同步身份组同步组操作已超时。如需继续请重新执行命令。',
                            },
                        ],
                        components: [],
                    });
                },
                onError: async error => {
                    await handleCommandError(interaction, error, '同步身份组同步组');
                },
            });
        } catch (error) {
            logTime(
                `同步身份组同步组命令执行失败 - 服务器: ${interaction.guild.name} (${interaction.guild.id}), ` +
                `错误: ${error.message}`,
                true,
            );
            await interaction.editReply({
                content: `❌ 命令执行出错: ${error.message}`,
            });
        }
    },
};
