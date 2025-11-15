import { SlashCommandBuilder } from 'discord.js';
import { handleCommandError } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';
import { followHistoryService } from '../../services/user/followHistoryService.js';

export default {
    cooldown: 10,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('查看我的历史关注')
        .setDescription('查看你关注的所有帖子历史记录')
        .addStringOption(option =>
            option
                .setName('筛选')
                .setDescription('选择要查看的关注类型')
                .setRequired(false)
                .addChoices(
                    { name: '正在关注', value: 'active' },
                    { name: '全部关注', value: 'all' }
                )
        ),

    async execute(interaction) {
        try {
            const userId = interaction.user.id;
            const filterType = interaction.options.getString('筛选') || 'active';
            const showAll = filterType === 'all';

            // 使用服务层统一逻辑构建消息
            const result = await followHistoryService.buildFollowHistoryMessage({
                userId,
                user: interaction.user,
                showAll,
                page: 1,
                client: interaction.client
            });

            if (result.isEmpty) {
                await interaction.editReply({
                    content: `✅ ${result.message}`,
                });
                return;
            }

            // 发送消息
            await interaction.editReply(result.payload);
        } catch (error) {
            await handleCommandError(interaction, error, '查看历史关注');
        }
    },
};
