import { SlashCommandBuilder } from 'discord.js';
import { checkAndHandlePermission, handleCommandError, measureTime } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 30,
    data: new SlashCommandBuilder()
        .setName('同步永封')
        .setDescription('同步所有服务器的永封列表'),

    async execute(interaction, guildConfig) {
        // 检查管理员权限
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        const timer = measureTime();
        try {
            await interaction.editReply('⏳ 正在收集所有服务器的永封列表...');
            
            // 获取所有配置的服务器
            const allGuilds = Array.from(interaction.client.guildManager.guilds.values());
            const banLists = new Map(); // Map<guildId, Set<userId>>
            const guildBanFetchResults = [];

            // 收集所有服务器的永封列表
            for (const guildData of allGuilds) {
                try {
                    const guild = await interaction.client.guilds.fetch(guildData.id);
                    const bans = await guild.bans.fetch();
                    banLists.set(guildData.id, new Set(bans.map(ban => ban.user.id)));
                    guildBanFetchResults.push(`✅ ${guild.name}: ${bans.size} 个永封`);
                } catch (error) {
                    guildBanFetchResults.push(`❌ ${guildData.id}: 获取失败 (${error.message})`);
                    logTime(`获取服务器 ${guildData.id} 的永封列表失败: ${error.message}`, true);
                }
            }

            // 更新进度
            await interaction.editReply([
                '⏳ 正在分析永封差异...',
                '**永封列表获取结果：**',
                guildBanFetchResults.join('\n'),
            ].join('\n'));

            // 分析需要同步的永封
            const syncTasks = [];
            const allUserIds = new Set();
            banLists.forEach(userIds => userIds.forEach(id => allUserIds.add(id)));

            for (const userId of allUserIds) {
                const bannedIn = new Set();
                const notBannedIn = new Set();

                // 检查用户在哪些服务器被封禁
                banLists.forEach((userIds, guildId) => {
                    if (userIds.has(userId)) {
                        bannedIn.add(guildId);
                    } else {
                        notBannedIn.add(guildId);
                    }
                });

                // 如果用户不是在所有服务器都被封禁，则需要同步
                if (bannedIn.size > 0 && notBannedIn.size > 0) {
                    syncTasks.push({
                        userId,
                        bannedIn: Array.from(bannedIn),
                        notBannedIn: Array.from(notBannedIn),
                    });
                }
            }

            // 如果没有需要同步的永封
            if (syncTasks.length === 0) {
                await interaction.editReply([
                    '✅ 所有服务器的永封列表已同步',
                    '**永封列表获取结果：**',
                    guildBanFetchResults.join('\n'),
                    `\n总用时: ${timer()}秒`,
                ].join('\n'));
                return;
            }

            // 更新进度
            await interaction.editReply([
                `⏳ 正在同步 ${syncTasks.length} 个永封差异...`,
                '**永封列表获取结果：**',
                guildBanFetchResults.join('\n'),
            ].join('\n'));

            // 执行同步
            const syncResults = [];
            for (const task of syncTasks) {
                try {
                    // 获取用户信息
                    const user = await interaction.client.users.fetch(task.userId);
                    
                    // 获取原始ban的信息
                    const bannedGuild = await interaction.client.guilds.fetch(task.bannedIn[0]);
                    const banInfo = await bannedGuild.bans.fetch(task.userId);

                    // 在未封禁的服务器中执行封禁
                    for (const guildId of task.notBannedIn) {
                        try {
                            const guild = await interaction.client.guilds.fetch(guildId);
                            await guild.members.ban(task.userId, {
                                deleteMessageSeconds: 0,
                                reason: `同步永封 - 原因: ${banInfo.reason || '未提供原因'}`,
                            });
                            logTime(`在服务器 ${guild.name} 同步永封用户 ${user.tag}`);
                        } catch (error) {
                            logTime(`在服务器 ${guildId} 同步永封用户 ${user.tag} 失败: ${error.message}`, true);
                        }
                    }

                    syncResults.push(`✅ ${user.tag}: 已同步到 ${task.notBannedIn.length} 个服务器`);
                } catch (error) {
                    syncResults.push(`❌ ${task.userId}: 同步失败 (${error.message})`);
                    logTime(`同步用户 ${task.userId} 的永封失败: ${error.message}`, true);
                }
            }

            // 发送最终结果
            await interaction.editReply([
                '✅ 永封同步完成！',
                '**永封列表获取结果：**',
                guildBanFetchResults.join('\n'),
                '\n**同步结果：**',
                syncResults.join('\n'),
                `\n总用时: ${timer()}秒`,
            ].join('\n'));

        } catch (error) {
            await handleCommandError(interaction, error, '同步永封');
        }
    },
}; 