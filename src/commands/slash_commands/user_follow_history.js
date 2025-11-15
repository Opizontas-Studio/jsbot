import { SlashCommandBuilder } from 'discord.js';
import { handleCommandError } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';
import { followHistoryService } from '../../services/user/followHistoryService.js';
import { ComponentV2Factory } from '../../factories/componentV2Factory.js';

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
                    { name: '曾经关注', value: 'ever_followed' }
                )
        ),

    async execute(interaction) {
        try {
            const userId = interaction.user.id;
            const filterType = interaction.options.getString('筛选') || 'active';
            const showLeft = filterType === 'ever_followed';

            // 使用服务层统一逻辑构建消息
            const result = await followHistoryService.buildFollowHistoryMessage({
                userId,
                user: interaction.user,
                showLeft,
                page: 1,
                client: interaction.client
            });

            if (result.isEmpty) {
                // 使用Component V2显示空状态消息，保持一致性
                await interaction.editReply({
                    components: ComponentV2Factory.buildEmptyStateMessage(`✅ ${result.message}`),
                    flags: ['IsComponentsV2', 'Ephemeral']
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
