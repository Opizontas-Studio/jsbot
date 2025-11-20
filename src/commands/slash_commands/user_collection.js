import { SlashCommandBuilder } from 'discord.js';
import { collectionService } from '../../services/user/collectionService.js';
import { handleCommandError } from '../../utils/helper.js';
import { ComponentV2Factory } from '../../factories/componentV2Factory.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('合集')
        .setDescription('查看作品合集，参数可不填。帖子使用直接查看作者，杯赛频道使用直接查杯赛')
        .addUserOption(option =>
            option.setName('作者')
                .setDescription('选择作者（不填则查当前帖子作者）')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('杯赛名')
                .setDescription('指定杯赛名称搜索（不填则查当前频道杯赛）')
                .setRequired(false)
        ),

    async execute(interaction, guildConfig) {
        try {
            let targetUser = interaction.options.getUser('作者');
            let searchTerm = null;

            // 如果未指定作者
            if (!targetUser) {
                const cupName = interaction.options.getString('杯赛名');
                
                if (cupName) {
                    searchTerm = cupName;
                } else {
                    // 检查是否在 eventsCategoryId 下
                    const eventsCategoryId = guildConfig?.eventsCategoryId;
                    let isEventChannel = false;

                    if (eventsCategoryId && interaction.channel) {
                        const channel = interaction.channel;
                        if (channel.isThread()) {
                            if (channel.parent?.parentId === eventsCategoryId) {
                                isEventChannel = true;
                            }
                        } else if (channel.parentId === eventsCategoryId) {
                            isEventChannel = true;
                        }
                    }

                    if (isEventChannel) {
                        // 提取搜索词
                        const channelName = interaction.channel.name;
                        const separators = ['-', '｜', '|'];
                        let lastIndex = -1;

                        for (const sep of separators) {
                            const idx = channelName.lastIndexOf(sep);
                            if (idx > lastIndex) lastIndex = idx;
                        }

                        if (lastIndex !== -1) {
                            let tempTerm = channelName.substring(lastIndex + 1).trim();
                            // 如果包含“杯”，则截取到“杯”字为止
                            const beiIndex = tempTerm.indexOf('杯');
                            if (beiIndex !== -1) {
                                tempTerm = tempTerm.substring(0, beiIndex + 1);
                            }
                            searchTerm = tempTerm;
                        }
                    }
                }

                // 如果没提取到搜索词，尝试获取当前子区的作者
                if (!searchTerm) {
                    if (interaction.channel?.isThread()) {
                        targetUser = await interaction.client.users.fetch(interaction.channel.ownerId)
                            .catch(() => ({ id: interaction.channel.ownerId, username: '未知用户' }));
                    } else {
                        throw new Error('请指定作者，或在帖子内使用此命令以查看帖子作者的合集。');
                    }
                }
            }

            const authorId = searchTerm ? `search:${searchTerm}` : targetUser.id;
            const authorUserObj = searchTerm ? { username: searchTerm } : targetUser;

            const result = await collectionService.buildCollectionMessage({
                authorId: authorId,
                authorUser: authorUserObj,
                page: 1,
                client: interaction.client
            });

            if (result.isEmpty) {
                // 使用Component V2显示空状态消息
                await interaction.editReply({
                    components: ComponentV2Factory.buildEmptyStateMessage(`✅ ${result.message}`),
                    flags: ['IsComponentsV2', 'Ephemeral']
                });
                return;
            }

            await interaction.editReply(result.payload);

        } catch (error) {
            await handleCommandError(interaction, error, '查看作品合集');
        }
    }
};
