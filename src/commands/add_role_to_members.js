import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { generateProgressReport, globalBatchProcessor } from '../utils/concurrency.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 硬编码身份组ID
const TARGET_ROLE_ID = '1335363403870502912';
const EXCLUDE_ROLE_ID = '1300129869589643307';

export default {
    cooldown: 30, // 设置较长的冷却时间
    data: new SlashCommandBuilder()
        .setName('批量添加身份组')
        .setDescription('为所有没有指定身份组的成员添加目标身份组')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(interaction, guildConfig) {
        // 权限检查
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        try {
            // 获取目标身份组
            const targetRole = await interaction.guild.roles.fetch(TARGET_ROLE_ID);
            const excludeRole = await interaction.guild.roles.fetch(EXCLUDE_ROLE_ID);

            if (!targetRole || !excludeRole) {
                await interaction.editReply({
                    content: '❌ 无法找到指定的身份组，请检查配置',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 获取所有成员
            await interaction.editReply({
                content: '⏳ 正在获取服务器成员列表...',
                flags: ['Ephemeral'],
            });

            const members = await interaction.guild.members.fetch();

            // 筛选需要处理的成员
            const membersToProcess = members.filter(
                member =>
                    !member.roles.cache.has(EXCLUDE_ROLE_ID) &&
                    !member.roles.cache.has(TARGET_ROLE_ID) &&
                    !member.user.bot,
            );

            if (membersToProcess.size === 0) {
                await interaction.editReply({
                    content: '✅ 没有找到需要处理的成员',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 预估完成时间（每秒处理1个成员）
            const estimatedMinutes = Math.ceil(membersToProcess.size / 60);

            await interaction.editReply({
                content: [
                    `⏳ 开始处理 ${membersToProcess.size} 个成员...`,
                    `⏱️ 预计需要 ${estimatedMinutes} 分钟完成`,
                    '💡 由于Discord API限制，每秒只能处理1个成员',
                ].join('\n'),
                flags: ['Ephemeral'],
            });

            let successCount = 0;
            let failCount = 0;
            let lastProgressUpdate = Date.now();

            // 使用批处理器处理成员
            await globalBatchProcessor.processBatch(
                Array.from(membersToProcess.values()),
                async member => {
                    try {
                        await member.roles.add(targetRole, '批量添加身份组操作');
                        successCount++;
                        return true;
                    } catch (error) {
                        logTime(`为成员 ${member.user.tag} 添加身份组失败: ${error.message}`, true);
                        failCount++;
                        return false;
                    }
                },
                async (progress, processed, total) => {
                    const now = Date.now();
                    if (now - lastProgressUpdate > 5000) {
                        // 降低进度更新频率到5秒一次
                        lastProgressUpdate = now;
                        const remainingMinutes = Math.ceil((total - processed) / 60);
                        await interaction.editReply({
                            content: generateProgressReport(processed, total, {
                                prefix: '正在添加身份组',
                                suffix: [
                                    `\n✅ 成功: ${successCount}`,
                                    `❌ 失败: ${failCount}`,
                                    `⏱️ 预计剩余时间: ${remainingMinutes} 分钟`,
                                ].join('\n'),
                            }),
                            flags: ['Ephemeral'],
                        });
                    }
                },
                'members', // 使用成员操作的速率限制配置
            );

            // 发送最终报告
            await interaction.editReply({
                content: [
                    '✅ 批量添加身份组操作已完成！',
                    `📊 处理成员总数: ${membersToProcess.size}`,
                    `✅ 成功数量: ${successCount}`,
                    `❌ 失败数量: ${failCount}`,
                ].join('\n'),
                flags: ['Ephemeral'],
            });

            // 记录到日志频道
            if (guildConfig.automation?.logThreadId) {
                const logChannel = await interaction.client.channels.fetch(guildConfig.automation.logThreadId);
                await logChannel.send({
                    embeds: [
                        {
                            color: 0x0099ff,
                            title: '批量添加身份组操作报告',
                            description: [
                                `执行者: ${interaction.user.tag}`,
                                `目标身份组: ${targetRole.name}`,
                                `排除身份组: ${excludeRole.name}`,
                                `处理成员总数: ${membersToProcess.size}`,
                                `成功数量: ${successCount}`,
                                `失败数量: ${failCount}`,
                            ].join('\n'),
                            timestamp: new Date(),
                            footer: { text: '论坛自动化系统' },
                        },
                    ],
                });
            }
        } catch (error) {
            await handleCommandError(interaction, error, '批量添加身份组');
        }
    },
};
