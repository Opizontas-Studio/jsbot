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

        // 状态检查
        await globalRequestQueue.add(async () => {
            const client = interaction.client;
            const ping = Math.round(client.ws.ping);
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
                            value: ping === -1 ? '正在测量...' : `${ping}ms`,
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

            // 如果延迟为-1，等待一会儿后重新获取并更新消息
            if (ping === -1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                const updatedPing = Math.round(client.ws.ping);
                if (updatedPing !== -1) {
                    const reply = await interaction.fetchReply();
                    const updatedEmbed = reply.embeds[0];
                    updatedEmbed.fields[0].value = `${updatedPing}ms`;
                    await interaction.editReply({ embeds: [updatedEmbed] });
                }
            }
        }, 3); // 极高优先级
    }
}; 