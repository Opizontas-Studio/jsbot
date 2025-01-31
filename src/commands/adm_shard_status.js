import { SlashCommandBuilder } from 'discord.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 获取WebSocket状态描述
const getConnectionStatus = client => {
    const monitor = client.wsStateMonitor;
    if (!monitor) return '🔄 状态未知';

    if (monitor.disconnectedAt) {
        const downtime = Math.floor((Date.now() - monitor.disconnectedAt) / 1000);
        return `❌ 已断开 ${downtime}秒`;
    }

    if (monitor.reconnectAttempts > 0) {
        return `🔄 重连中 (${monitor.reconnectAttempts}次)`;
    }

    return '✅ 已连接';
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
            const ping = Math.round(client.ws.ping);
            const guildCount = client.guilds.cache.size;
            const status = getConnectionStatus(client);

            // 获取队列统计信息
            const queueLength = globalRequestQueue.queue.length;
            const currentProcessing = globalRequestQueue.currentProcessing;
            const { processed, failed } = globalRequestQueue.stats;

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
                                name: 'WebSocket状态',
                                value: status,
                                inline: true,
                            },
                            {
                                name: '队列状态',
                                value: `🟢 运行中`,
                                inline: true,
                            },
                            {
                                name: '队列统计',
                                value: [
                                    `📥 等待处理: ${queueLength}`,
                                    `⚡ 正在处理: ${currentProcessing}`,
                                    `✅ 已完成: ${processed}`,
                                    `❌ 失败: ${failed}`,
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
