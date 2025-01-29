import { SlashCommandBuilder, WebSocketShardStatus } from 'discord.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 添加状态映射函数
const getReadableStatus = status => {
    switch (status) {
        case WebSocketShardStatus.Idle:
            return '🔄 空闲中';
        case WebSocketShardStatus.Connecting:
            return '🌐 正在连接';
        case WebSocketShardStatus.Resuming:
            return '⏳ 正在恢复会话';
        case WebSocketShardStatus.Ready:
            return '✅ 已就绪';
        default:
            return '❓ 未知状态';
    }
};

export default {
    cooldown: 3,
    data: new SlashCommandBuilder().setName('系统状态').setDescription('查看当前系统运行状态'),

    async execute(interaction, guildConfig) {
        try {
            if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
                return;
            }

            const client = interaction.client;
            let ping = Math.round(client.ws.ping);
            const guildCount = client.guilds.cache.size;
            const rawStatus = globalRequestQueue.shardStatus.get(0);
            const status = getReadableStatus(rawStatus);
            const queueStats = globalRequestQueue.getStats();

            // 如果延迟为-1，等待后再获取
            if (ping === -1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                ping = Math.round(client.ws.ping);
            }

            // 只执行一次回复
            await interaction.editReply({
                embeds: [
                    {
                        color: 0x0099ff,
                        title: '系统运行状态',
                        fields: [
                            {
                                name: '网络延迟',
                                value: ping === -1 ? '无法获取' : `${ping}ms`,
                                inline: true,
                            },
                            {
                                name: '服务器数量',
                                value: `${guildCount}`,
                                inline: true,
                            },
                            {
                                name: '系统状态',
                                value: status,
                                inline: true,
                            },
                            {
                                name: '队列状态',
                                value: globalRequestQueue.paused ? '🔴 已暂停' : '🟢 运行中',
                                inline: true,
                            },
                            {
                                name: '队列统计',
                                value: [
                                    `📥 等待处理: ${queueStats.queueLength}`,
                                    `⚡ 正在处理: ${queueStats.currentProcessing - 1}`,
                                    `✅ 已完成: ${queueStats.processed}`,
                                    `❌ 失败: ${queueStats.failed}`,
                                ].join('\n'),
                                inline: false,
                            },
                        ],
                        timestamp: new Date(),
                        footer: {
                            text: '系统监控',
                        },
                    },
                ],
            });

            logTime(`用户 ${interaction.user.tag} 查看了系统状态`);
        } catch (error) {
            await handleCommandError(interaction, error, '系统状态');
        }
    },
};
