import { SlashCommandBuilder } from 'discord.js';
import { checkPermission, handlePermissionResult } from '../utils/helper.js';
import { globalRequestQueue } from '../utils/concurrency.js';

export default {
    data: new SlashCommandBuilder()
        .setName('分片状态')
        .setDescription('查看当前系统运行状态'),

    async execute(interaction, guildConfig) {
        // 检查权限
        const hasPermission = checkPermission(interaction.member, guildConfig.AdministratorRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        await interaction.deferReply({ flags: ['Ephemeral'] });

        const client = interaction.client;
        const shardPing = client.ws.ping;
        const guildCount = client.guilds.cache.size;
        const status = globalRequestQueue.shardStatus.get(0) || '未知';
        const queueStats = globalRequestQueue.getStats();

        await interaction.editReply({
            embeds: [{
                color: 0x0099ff,
                title: '系统运行状态',
                fields: [
                    {
                        name: '网络延迟',
                        value: `${shardPing}ms`,
                        inline: true
                    },
                    {
                        name: '服务器数量',
                        value: `${guildCount}`,
                        inline: true
                    },
                    {
                        name: '系统状态',
                        value: status,
                        inline: true
                    },
                    {
                        name: '队列状态',
                        value: globalRequestQueue.paused ? '🔴 已暂停' : '🟢 运行中',
                        inline: true
                    },
                    {
                        name: '队列统计',
                        value: [
                            `📥 等待处理: ${queueStats.queueLength}`,
                            `⚡ 正在处理: ${queueStats.currentProcessing}`,
                            `✅ 已完成: ${queueStats.processed}`,
                            `🔄 重试: ${queueStats.retried}`,
                            `❌ 失败: ${queueStats.failed}`
                        ].join('\n'),
                        inline: false
                    },
                    {
                        name: '平均等待时间',
                        value: `${Math.round(queueStats.averageWaitTime)}ms`,
                        inline: true
                    }
                ],
                timestamp: new Date(),
                footer: {
                    text: '系统监控'
                }
            }]
        });
    }
}; 