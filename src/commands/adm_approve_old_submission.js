import { SlashCommandBuilder } from 'discord.js';
import { updateOpinionRecord } from '../services/roleApplication.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('批准旧投稿')
        .setDescription('批准旧的投稿消息并将用户添加到合理建议记录中')
        .addStringOption(option =>
            option
                .setName('消息链接')
                .setDescription('投稿消息的链接')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('投稿类型')
                .setDescription('投稿类型')
                .setRequired(true)
                .addChoices(
                    { name: '新闻投稿', value: 'news' },
                    { name: '社区意见', value: 'opinion' }
                )
        ),

    async execute(interaction, guildConfig) {
        // 检查权限
        if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
            return;
        }

        const messageLink = interaction.options.getString('消息链接');
        const submissionType = interaction.options.getString('投稿类型');

        try {
            // 解析消息链接
            const linkMatch = messageLink.match(/https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
            if (!linkMatch) {
                await interaction.editReply({
                    content: '❌ 无效的消息链接格式',
                });
                return;
            }

            const [, guildId, channelId, messageId] = linkMatch;

            // 获取目标服务器
            const targetGuild = await interaction.client.guilds.fetch(guildId).catch(() => null);
            if (!targetGuild) {
                await interaction.editReply({
                    content: '❌ 无法访问目标服务器',
                });
                return;
            }

            // 获取目标频道
            const targetChannel = await targetGuild.channels.fetch(channelId).catch(() => null);
            if (!targetChannel) {
                await interaction.editReply({
                    content: '❌ 无法访问目标频道',
                });
                return;
            }

            // 获取目标消息
            const targetMessage = await targetChannel.messages.fetch(messageId).catch(() => null);
            if (!targetMessage) {
                await interaction.editReply({
                    content: '❌ 无法获取目标消息',
                });
                return;
            }

            // 检查消息是否有embed
            if (!targetMessage.embeds || targetMessage.embeds.length === 0) {
                await interaction.editReply({
                    content: '❌ 目标消息没有embed内容',
                });
                return;
            }

            const embed = targetMessage.embeds[0];

            // 检查embed是否有author信息
            if (!embed.author || !embed.author.name) {
                await interaction.editReply({
                    content: '❌ embed中没有找到作者信息',
                });
                return;
            }

            const authorName = embed.author.name;

            // 尝试通过用户名查找用户
            let targetUser = null;

            // 方法1: 在当前服务器中查找
            const currentGuildMembers = await interaction.guild.members.fetch();
            const memberByTag = currentGuildMembers.find(member =>
                member.user.tag === authorName ||
                member.user.username === authorName ||
                member.displayName === authorName
            );

            if (memberByTag) {
                targetUser = memberByTag.user;
            } else {
                await interaction.editReply({
                    content: `❌ 无法找到用户名为 "${authorName}" 的用户\n请确认用户名正确或用户仍在服务器中`,
                });
                return;
            }

            // 从embed中提取投稿信息
            let submissionData = null;
            if (embed) {
                // 提取标题（去掉前缀）
                let title = embed.title || '未记录标题';
                if (title.startsWith('📰 新闻投稿：')) {
                    title = title.replace('📰 新闻投稿：', '').trim();
                } else if (title.startsWith('💬 社区意见：')) {
                    title = title.replace('💬 社区意见：', '').trim();
                }

                // 提取内容
                const content = embed.description || '未记录内容';

                submissionData = {
                    title: title,
                    content: content
                };
            }

            // 更新意见记录
            const result = await updateOpinionRecord(targetUser.id, submissionType, true, submissionData);

            if (result.success) {
                // 尝试更新原消息的embed（如果有权限）
                try {
                    const updatedEmbed = {
                        ...embed.toJSON(),
                        footer: {
                            text: '审定有效，可申请志愿者身份组'
                        }
                    };

                    await targetMessage.edit({
                        embeds: [updatedEmbed],
                        components: [] // 移除按钮
                    });
                } catch (error) {
                    logTime(`无法编辑原消息: ${error.message}`, true);
                }

                await interaction.editReply({
                    content: [
                        '✅ 旧投稿批准成功',
                        '',
                        `**用户：** ${targetUser.tag} (${targetUser.id})`,
                        `**投稿类型：** ${submissionType === 'news' ? '新闻投稿' : '社区意见'}`,
                        `**投稿标题：** ${submissionData?.title || '未记录标题'}`,
                        `**消息链接：** [点击查看](${messageLink})`,
                        '',
                        '该用户现在可以申请志愿者身份组了。'
                    ].join('\n'),
                });

                logTime(`管理员 ${interaction.user.tag} 批准了用户 ${targetUser.tag} 的旧${submissionType === 'news' ? '新闻投稿' : '社区意见'}: "${submissionData?.title || '未知标题'}"`);
            } else {
                await interaction.editReply({
                    content: `❌ ${result.message}`,
                });
            }

        } catch (error) {
            await handleCommandError(interaction, error, '批准旧投稿');
        }
    },
};
