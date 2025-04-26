import { SlashCommandBuilder } from 'discord.js';
import { handleConfirmationButton } from '../handlers/buttons.js';
import { delay } from '../utils/concurrency.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 硬编码身份组ID - 主服务器
const MAIN_SERVER_ROLES = {
    TARGET_ROLE_ID: '1335363403870502912', // 已验证
    SOURCE_ROLE_ID: '1338193342889984123', // 缓冲区
};

// 硬编码身份组ID - 子服务器
const SUB_SERVER_ROLES = {
    TARGET_ROLE_ID: '1337007077264064512', // 已验证
    SOURCE_ROLE_ID: '1338097075593678912', // 缓冲区
};

export default {
    cooldown: 30,
    data: new SlashCommandBuilder()
        .setName('批量转移身份组')
        .setDescription('将指定数量的成员从一个身份组转移到另一个身份组')
        .addRoleOption(option => option.setName('源身份组').setDescription('要转移成员的来源身份组').setRequired(true))
        .addRoleOption(option =>
            option.setName('目标身份组').setDescription('要转移成员到的目标身份组').setRequired(true),
        )
        .addIntegerOption(option =>
            option
                .setName('数量')
                .setDescription('要转移的成员数量 (10-300)')
                .setRequired(false)
                .setMinValue(10)
                .setMaxValue(300),
        )
        .addBooleanOption(option =>
            option.setName('移除源身份组').setDescription('是否移除成员的源身份组 (默认: 是)').setRequired(false),
        ),

    async execute(interaction, guildConfig) {
        // 权限检查
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        try {
            // 获取命令参数
            const sourceRole = interaction.options.getRole('源身份组');
            const targetRole = interaction.options.getRole('目标身份组');
            const requestedCount = interaction.options.getInteger('数量') || 200; // 默认200
            const removeSourceRole = interaction.options.getBoolean('移除源身份组') ?? true; // 默认true

            if (!sourceRole || !targetRole) {
                await interaction.editReply({
                    content: '❌ 无法找到指定的身份组，请重试',
                });
                return;
            }

            // 检查是否操作管理员或版主角色
            const adminRoles = guildConfig.AdministratorRoleIds || [];
            const modRoles = guildConfig.ModeratorRoleIds || [];

            // 添加敏感角色保护
            const sensitiveRoles = [];

            // 添加创作者、参议员、答题员角色到受保护列表
            if (guildConfig.roleApplication?.creatorRoleId) {
                sensitiveRoles.push(guildConfig.roleApplication.creatorRoleId);
            }
            if (guildConfig.roleApplication?.senatorRoleId) {
                sensitiveRoles.push(guildConfig.roleApplication.senatorRoleId);
            }
            if (guildConfig.roleApplication?.QAerRoleId) {
                sensitiveRoles.push(guildConfig.roleApplication.QAerRoleId);
            }

            const protectedRoles = [...adminRoles, ...modRoles, ...sensitiveRoles];

            if (protectedRoles.includes(sourceRole.id) || protectedRoles.includes(targetRole.id)) {
                await interaction.editReply({
                    content: '❌ 安全限制：不能操作敏感身份组',
                });
                logTime(`管理员 ${interaction.user.tag} 尝试操作受保护身份组被阻止 - 源: ${sourceRole.name}(${sourceRole.id}), 目标: ${targetRole.name}(${targetRole.id})`, true);
                return;
            }

            await interaction.editReply({
                content: '⏳ 正在获取源身份组成员列表...',
            });

            // 获取源身份组的所有成员
            const members = await interaction.guild.members.fetch();
            const eligibleMembers = members.filter(
                member =>
                    member.roles.cache.has(sourceRole.id) && !member.roles.cache.has(targetRole.id) && !member.user.bot,
            );

            // 按加入服务器时间排序（从早到晚）
            const membersToProcess = Array.from(eligibleMembers.values())
                .sort((a, b) => a.joinedTimestamp - b.joinedTimestamp)
                .slice(0, requestedCount);

            if (membersToProcess.length === 0) {
                await interaction.editReply({
                    content: '✅ 没有找到需要处理的成员',
                });
                return;
            }

            // 计算实际处理数量
            const actualCount = Math.min(membersToProcess.length, requestedCount);

            // 添加确认流程
            await handleConfirmationButton({
                interaction,
                customId: 'confirm_add_role',
                buttonLabel: '确认转移',
                embed: {
                    color: 0xff9900,
                    title: '⚠️ 批量转移身份组确认',
                    description: `你确定要批量转移 ${actualCount} 个成员的身份组吗？`,
                    fields: [
                        {
                            name: '源身份组',
                            value: sourceRole.name,
                            inline: true,
                        },
                        {
                            name: '目标身份组',
                            value: targetRole.name,
                            inline: true,
                        },
                        {
                            name: '数量',
                            value: `${actualCount}`,
                            inline: true,
                        },
                        {
                            name: '移除源身份组',
                            value: removeSourceRole ? '是' : '否',
                            inline: true,
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
                        content: `⏳ 开始处理 ${actualCount} 个成员...`,
                        components: [],
                        embeds: [],
                    });

                    logTime(`开始 ${actualCount} 个成员的身份组转移操作，操作服务器: ${interaction.guild.name}`);

                    let successCount = 0;
                    let failCount = 0;
                    let lastProgressUpdate = Date.now();
                    let processedCount = 0;

                    // 串行处理每个成员
                    for (const member of membersToProcess) {
                        try {
                            const actionMessage = `从 ${sourceRole.name} 转移到 ${targetRole.name}`;

                            // 根据参数决定是否移除源身份组
                            if (removeSourceRole) {
                                await member.roles.remove(sourceRole, actionMessage);
                                await delay(600);
                            }

                            // 添加目标身份组
                            await member.roles.add(targetRole, actionMessage);
                            successCount++;
                        } catch (error) {
                            logTime(`为成员 ${member.user.tag} (${member.id}) 转移身份组失败: ${error.message}`, true);
                            failCount++;
                        }

                        processedCount++;

                        // 更新进度（限制更新频率为1秒一次）
                        const now = Date.now();
                        if (now - lastProgressUpdate > 1000) {
                            lastProgressUpdate = now;
                            await interaction.editReply({
                                content: `⏳ 正在转移身份组... (${processedCount}/${actualCount})\n✅ 成功: ${successCount}\n❌ 失败: ${failCount}`,
                            });
                        }

                        // 等待600ms再处理下一个成员
                        await delay(600);
                    }

                    // 发送最终报告
                    await interaction.editReply({
                        content: [
                            '✅ 批量转移身份组操作已完成！',
                            `📊 处理成员总数: ${actualCount}`,
                            `✅ 成功数量: ${successCount}`,
                            `❌ 失败数量: ${failCount}`,
                        ].join('\n'),
                    });

                    // 记录到日志频道
                    if (guildConfig.automation?.logThreadId) {
                        const logChannel = await interaction.client.channels.fetch(guildConfig.threadLogThreadId);
                        await logChannel.send({
                            embeds: [
                                {
                                    color: 0x0099ff,
                                    title: '批量转移身份组操作报告',
                                    description: [
                                        `执行者: ${interaction.user.tag}`,
                                        `源身份组: ${sourceRole.name}`,
                                        `目标身份组: ${targetRole.name}`,
                                        `请求处理数量: ${requestedCount}`,
                                        `实际处理总数: ${actualCount}`,
                                        `成功数量: ${successCount}`,
                                        `失败数量: ${failCount}`,
                                        `是否移除源身份组: ${removeSourceRole ? '是' : '否'}`,
                                    ].join('\n'),
                                    timestamp: new Date(),
                                    footer: { text: '自动化系统' },
                                },
                            ],
                        });
                    }

                    // 记录操作完成的日志
                    logTime(
                        `批量转移身份组完成 - 服务器: ${interaction.guild.name} (${interaction.guild.id}), ` +
                            `执行者: ${interaction.user.tag}, 总数: ${actualCount}, 成功: ${successCount}, 失败: ${failCount}`,
                    );
                },
                onTimeout: async interaction => {
                    await interaction.editReply({
                        embeds: [
                            {
                                color: 0x808080,
                                title: '❌ 确认已超时',
                                description: '批量转移身份组操作已超时。如需继续请重新执行命令。',
                            },
                        ],
                        components: [],
                    });
                },
                onError: async error => {
                    await handleCommandError(interaction, error, '批量转移身份组');
                },
            });
        } catch (error) {
            logTime(
                `批量转移身份组命令执行失败 - 服务器: ${interaction.guild.name} (${interaction.guild.id}), ` +
                    `错误: ${error.message}`,
                true,
            );
            await interaction.editReply({
                content: `❌ 命令执行出错: ${error.message}`,
            });
        }
    },
};
