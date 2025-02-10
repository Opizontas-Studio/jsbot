import { SlashCommandBuilder } from 'discord.js';
import { delay } from '../utils/concurrency.js';
import { checkAndHandlePermission } from '../utils/helper.js';
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
        .addIntegerOption(option =>
            option
                .setName('数量')
                .setDescription('要转移的成员数量 (10-1000)')
                .setRequired(true)
                .setMinValue(10)
                .setMaxValue(1000),
        ),

    async execute(interaction, guildConfig) {
        // 权限检查
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        try {
            // 根据服务器类型选择对应的身份组ID
            const roleIds = guildConfig.serverType === 'Main server' ? MAIN_SERVER_ROLES : SUB_SERVER_ROLES;

            const requestedCount = interaction.options.getInteger('数量');
            
            // 获取目标身份组
            const targetRole = await interaction.guild.roles.fetch(roleIds.TARGET_ROLE_ID);
            const sourceRole = await interaction.guild.roles.fetch(roleIds.SOURCE_ROLE_ID);

            if (!targetRole || !sourceRole) {
                await interaction.editReply({
                    content: `❌ 无法找到指定的身份组，请检查配置\n服务器类型: ${guildConfig.serverType}`,
                    flags: ['Ephemeral'],
                });
                return;
            }

            await interaction.editReply({
                content: '⏳ 正在获取源身份组成员列表...',
                flags: ['Ephemeral'],
            });

            // 获取源身份组的所有成员
            const members = await interaction.guild.members.fetch();
            const membersToProcess = members.filter(
                member =>
                    member.roles.cache.has(roleIds.SOURCE_ROLE_ID) &&
                    !member.roles.cache.has(roleIds.TARGET_ROLE_ID) &&
                    !member.user.bot,
            ).first(requestedCount); // 只获取请求数量的成员

            if (membersToProcess.length === 0) {
                await interaction.editReply({
                    content: '✅ 没有找到需要处理的成员',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 计算实际处理数量
            const actualCount = Math.min(membersToProcess.length, requestedCount);
            await interaction.editReply({
                content: `⏳ 开始处理 ${actualCount} 个成员...`,
                flags: ['Ephemeral'],
            });
            logTime(`开始 ${actualCount} 个成员的身份组转移操作，操作服务器: ${interaction.guild.name}`);

            let successCount = 0;
            let failCount = 0;
            let lastProgressUpdate = Date.now();
            let processedCount = 0;

            // 串行处理每个成员
            for (const member of membersToProcess) {
                try {
                    // 先移除源身份组，再添加目标身份组
                    await member.roles.remove(sourceRole, '缓冲区转移到已验证');
                    await delay(700);
                    await member.roles.add(targetRole, '缓冲区转移到已验证');
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
                        flags: ['Ephemeral'],
                    });
                }

                // 等待700ms再处理下一个成员
                await delay(700);
            }

            // 发送最终报告
            await interaction.editReply({
                content: [
                    '✅ 批量转移身份组操作已完成！',
                    `📊 处理成员总数: ${actualCount}`,
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
                            title: '批量转移身份组操作报告',
                            description: [
                                `执行者: ${interaction.user.tag}`,
                                `源身份组: ${sourceRole.name}`,
                                `目标身份组: ${targetRole.name}`,
                                `请求处理数量: ${requestedCount}`,
                                `实际处理总数: ${actualCount}`,
                                `成功数量: ${successCount}`,
                                `失败数量: ${failCount}`,
                            ].join('\n'),
                            timestamp: new Date(),
                            footer: { text: '自动化系统' },
                        },
                    ],
                });
            }

            // 记录操作完成的日志
            logTime(`批量转移身份组完成 - 服务器: ${interaction.guild.name} (${interaction.guild.id}), ` +
                   `执行者: ${interaction.user.tag}, 总数: ${actualCount}, 成功: ${successCount}, 失败: ${failCount}`);
        } catch (error) {
            logTime(`批量转移身份组命令执行失败 - 服务器: ${interaction.guild.name} (${interaction.guild.id}), ` +
                   `错误: ${error.message}`, true);
            await handleCommandError(interaction, error, '批量转移身份组');
        }
    },
};
