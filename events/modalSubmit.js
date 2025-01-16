const { Events, ChannelType } = require('discord.js');
const { logTime } = require('../utils/helper');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (!interaction.isModalSubmit()) return;
        if (interaction.customId !== 'creator_role_modal') return;

        await interaction.deferReply({ ephemeral: true });

        try {
            const threadLink = interaction.fields.getTextInputValue('thread_link');
            const matches = threadLink.match(/channels\/(\d+)\/(\d+)\/(\d+)/);

            if (!matches) {
                await interaction.editReply('❌ 无效的帖子链接格式');
                return;
            }

            const [, guildId, channelId, threadId] = matches;
            const guildConfig = interaction.client.guildManager.getGuildConfig(guildId);

            if (!guildConfig || !guildConfig.creatorRoleId) {
                await interaction.editReply('❌ 服务器配置错误');
                return;
            }

            const thread = await interaction.client.channels.fetch(threadId);
            
            if (!thread || !thread.isThread() || !thread.parent?.type === ChannelType.GuildForum) {
                await interaction.editReply('❌ 提供的链接不是论坛帖子');
                return;
            }

            // 获取首条消息
            const firstMessage = await thread.messages.fetch({ limit: 1, after: '0' });
            const threadStarter = firstMessage.first();

            if (!threadStarter || threadStarter.author.id !== interaction.user.id) {
                await interaction.editReply('❌ 您不是该帖子的作者');
                return;
            }

            // 获取反应数最多的表情
            let maxReactions = 0;
            threadStarter.reactions.cache.forEach(reaction => {
                const count = reaction.count;
                if (count > maxReactions) {
                    maxReactions = count;
                }
            });

            if (maxReactions >= 5) {
                // 添加身份组
                const member = await interaction.guild.members.fetch(interaction.user.id);
                await member.roles.add(guildConfig.creatorRoleId);
                
                await interaction.editReply('✅ 审核通过，已为您添加创作者身份组。');
                logTime(`用户 ${interaction.user.tag} 获得了创作者身份组`);
            } else {
                await interaction.editReply('❌ 审核未通过，请获取足够正面反应后再申请。');
            }

        } catch (error) {
            logTime(`处理创作者身份组申请时出错: ${error}`, true);
            await interaction.editReply('❌ 处理申请时出现错误，请稍后重试。');
        }
    }
}; 