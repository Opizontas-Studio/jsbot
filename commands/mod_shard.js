import { SlashCommandBuilder } from 'discord.js';
import { checkPermission, handlePermissionResult } from '../utils/helper.js';
import { globalRequestQueue } from '../utils/concurrency.js';

export default {
    data: new SlashCommandBuilder()
        .setName('分片状态')
        .setDescription('查看当前分片的状态'),

    async execute(interaction, guildConfig) {
        // 检查权限
        const hasPermission = checkPermission(interaction.member, guildConfig.AdministratorRoleIds);
        if (!await handlePermissionResult(interaction, hasPermission)) return;

        await interaction.deferReply({ flags: ['Ephemeral'] });

        const client = interaction.client;
        const shardId = client.shard?.ids[0] ?? 0;
        const shardCount = client.shard?.count ?? 1;
        const shardPing = client.ws.ping;
        const guildCount = client.guilds.cache.size;
        const status = globalRequestQueue.shardStatus.get(shardId) || '未知';

        await interaction.editReply({
            embeds: [{
                color: 0x0099ff,
                title: '分片状态信息',
                fields: [
                    {
                        name: '分片ID',
                        value: `${shardId}`,
                        inline: true
                    },
                    {
                        name: '总分片数',
                        value: `${shardCount}`,
                        inline: true
                    },
                    {
                        name: '延迟',
                        value: `${shardPing}ms`,
                        inline: true
                    },
                    {
                        name: '服务器数量',
                        value: `${guildCount}`,
                        inline: true
                    },
                    {
                        name: '分片状态',
                        value: status,
                        inline: true
                    },
                    {
                        name: '请求队列状态',
                        value: globalRequestQueue.paused ? '已暂停' : '运行中',
                        inline: true
                    }
                ],
                timestamp: new Date()
            }]
        });
    }
}; 