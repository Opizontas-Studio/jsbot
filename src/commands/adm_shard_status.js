import { SlashCommandBuilder } from 'discord.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 添加状态映射函数
const getReadableStatus = client => {
    // 直接从 client.ws 获取状态
    const status = client.ws.status;

    switch (status) {
        case 0: // WebSocket.CONNECTING
            return '🌐 正在连接';
        case 1: // WebSocket.OPEN
            return '✅ 已就绪';
        case 2: // WebSocket.CLOSING
            return '🔄 正在关闭';
        case 3: // WebSocket.CLOSED
            return '⛔ 已断开';
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
            const status = getReadableStatus(client);

            // 如果延迟为-1，等待后再获取
            if (ping === -1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                ping = Math.round(client.ws.ping);
            }

            // 获取队列信息
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
                                name: '系统状态',
                                value: status,
                                inline: true,
                            },
                            {
                                name: '队列状态',
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
