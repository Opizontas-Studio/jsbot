const { Events } = require('discord.js');
const { logTime } = require('../utils/helper');
const cron = require('node-cron');

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        // 处理单个服务器的lockdown
        async function handleGuildLockdown(guild, guildConfig) {
            try {
                if (!guild.members.me.permissions.has('ManageGuild')) {
                    logTime(`服务器 ${guild.name} (${guild.id}) 缺少管理服务器权限，无法设置邀请暂停`, true);
                    return;
                }

                // 设置24小时的邀请暂停
                await guild.edit({
                    invitesDisabled: true
                });
                logTime(`服务器 ${guild.name} (${guild.id}) 已设置24小时邀请暂停`);

            } catch (error) {
                logTime(`设置服务器 ${guild.name} (${guild.id}) 的lockdown状态时出错: ${error.message}`, true);
            }
        }

        // 初始检查所有需要lockdown的服务器
        for (const [guildId, guildConfig] of client.guildManager.guilds) {
            if (guildConfig.lockdown) {
                const guild = await client.guilds.fetch(guildId);
                if (guild) {
                    await handleGuildLockdown(guild, guildConfig);
                }
            }
        }

        // 设置每天晚上9点的定时任务
        cron.schedule('0 21 * * *', async () => {
            logTime('开始执行每日lockdown重置任务');
            
            for (const [guildId, guildConfig] of client.guildManager.guilds) {
                if (guildConfig.lockdown) {
                    try {
                        const guild = await client.guilds.fetch(guildId);
                        if (!guild) continue;

                        // 先解除当前的邀请暂停
                        await guild.edit({
                            invitesDisabled: false
                        });
                        logTime(`服务器 ${guild.name} (${guild.id}) 已解除邀请暂停`);

                        // 等待一小段时间后重新设置
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        // 重新设置24小时的邀请暂停
                        await handleGuildLockdown(guild, guildConfig);

                    } catch (error) {
                        logTime(`重置服务器 ${guildId} 的lockdown状态时出错: ${error.message}`, true);
                    }
                }
            }
        }, {
            timezone: "Asia/Shanghai"  // 使用中国时区
        });
    },
}; 