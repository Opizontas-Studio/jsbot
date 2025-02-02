import { logTime } from '../utils/logger.js';

// 硬编码身份组ID
const TARGET_ROLE_ID = '1335363403870502912';
const EXCLUDE_ROLE_ID = '1300129869589643307';

// 添加一个延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 导出任务处理函数
export const processRoleAssignment = async (client, guildId) => {
    try {
        const guild = await client.guilds.fetch(guildId);
        if (!guild) {
            logTime(`无法获取服务器 ${guildId}`, true);
            return;
        }

        // 获取目标身份组
        const targetRole = await guild.roles.fetch(TARGET_ROLE_ID);
        const excludeRole = await guild.roles.fetch(EXCLUDE_ROLE_ID);

        if (!targetRole || !excludeRole) {
            logTime('无法找到指定的身份组，请检查配置', true);
            return;
        }

        // 获取所有成员
        const members = await guild.members.fetch();

        // 筛选需要处理的成员
        const membersToProcess = members.filter(
            member =>
                !member.roles.cache.has(EXCLUDE_ROLE_ID) && !member.roles.cache.has(TARGET_ROLE_ID) && !member.user.bot,
        );

        if (membersToProcess.size === 0) {
            logTime('没有找到需要处理的成员');
            return;
        }

        logTime(`开始处理 ${membersToProcess.size} 个成员...`);

        let successCount = 0;
        let failCount = 0;
        let processedCount = 0;
        const totalCount = membersToProcess.size;

        // 串行处理每个成员
        for (const member of membersToProcess.values()) {
            try {
                await member.roles.add(targetRole, '批量添加身份组操作');
                successCount++;
            } catch (error) {
                logTime(`为成员 ${member.user.tag} 添加身份组失败: ${error.message}`, true);
                failCount++;
            }

            processedCount++;

            // 每处理100个用户输出一次进度日志
            if (processedCount % 100 === 0) {
                logTime(
                    `[身份组分配] 进度: ${processedCount}/${totalCount} ` +
                        `(${Math.floor((processedCount / totalCount) * 100)}%) ` +
                        `✅成功: ${successCount} ❌失败: ${failCount}`,
                );
            }

            // 等待250ms再处理下一个成员
            await delay(250);
        }

        // 处理完成后输出最终进度
        logTime(`[身份组分配] 完成! 总计: ${totalCount} ` + `✅成功: ${successCount} ❌失败: ${failCount}`);

        // 发送最终报告到日志频道
        const guildConfig = client.guildManager.get(guildId);
        if (guildConfig?.automation?.logThreadId) {
            const logChannel = await client.channels.fetch(guildConfig.automation.logThreadId);
            await logChannel.send({
                embeds: [
                    {
                        color: 0x0099ff,
                        title: '批量添加身份组操作报告',
                        description: [
                            '自动执行批量身份组添加',
                            `目标身份组: ${targetRole.name}`,
                            `排除身份组: ${excludeRole.name}`,
                            `处理成员总数: ${totalCount}`,
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
        logTime(`批量添加身份组任务执行失败: ${error.message}`, true);
    }
};
