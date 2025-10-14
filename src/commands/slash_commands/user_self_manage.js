import { SlashCommandBuilder } from 'discord.js';
import { SelectMenuFactory } from '../../factories/selectMenuFactory.js';
import {
    handleCleanInactiveUsers,
    handleDeleteThread,
    handleDeleteUserMessages,
    handleLockThread,
    updateSlowMode,
    validateForumThread,
    validateThreadOwner
} from '../../services/selfManageService.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('自助管理')
        .setDescription('管理你自己的帖子，命令在当前帖子生效')
        .addSubcommand(subcommand => subcommand.setName('删贴').setDescription('删除你的当前这个帖子'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('锁定并关闭')
                .setDescription('锁定并关闭你的帖子（沉底并关闭其他人的回复权限）')
                .addStringOption(option => option.setName('理由').setDescription('锁定原因').setRequired(false)),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('清理不活跃用户')
                .setDescription('清理当前帖子中的不活跃用户')
                .addIntegerOption(option =>
                    option
                        .setName('阈值')
                        .setDescription('目标人数阈值（默认950，最低800）')
                        .setMinValue(800)
                        .setMaxValue(1000)
                        .setRequired(false),
                )
                .addBooleanOption(option =>
                    option
                        .setName('启用自动清理')
                        .setDescription('是否启用自动清理功能（默认为是）')
                        .setRequired(false),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('删除某用户全部消息')
                .setDescription('删除某特定用户在当前帖子的所有消息并将其移出子区（注意：如果帖子消息数量很多，此操作可能需要较长时间）')
                .addUserOption(option =>
                    option
                        .setName('目标用户')
                        .setDescription('要删除其消息的用户')
                        .setRequired(true),
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('编辑慢速模式')
                .setDescription('修改当前帖子的慢速模式')
                .addStringOption(option =>
                    option
                        .setName('速度')
                        .setDescription('慢速模式时间间隔')
                        .setRequired(true)
                        .addChoices(
                            { name: '无慢速', value: '0' },
                            { name: '5秒', value: '5' },
                            { name: '10秒', value: '10' },
                            { name: '15秒', value: '15' },
                            { name: '30秒', value: '30' },
                            { name: '1分钟', value: '60' }
                        )
                ),
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('移除帖子反应')
                .setDescription('移除你的帖子首楼消息上的反应，切记谨慎操作！')
        ),

    async execute(interaction, guildConfig) {
        const subcommand = interaction.options.getSubcommand();
        const thread = interaction.channel;

        // 检查是否在论坛帖子中使用
        const forumValidation = validateForumThread(thread);
        if (!forumValidation.isValid) {
            await interaction.editReply({
                content: forumValidation.error,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 检查是否为帖子作者
        const ownerValidation = validateThreadOwner(thread, interaction.user.id);
        if (!ownerValidation.isValid) {
            await interaction.editReply({
                content: ownerValidation.error,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 使用switch处理不同的子命令
        switch (subcommand) {
            case '删贴':
                await ErrorHandler.handleSilent(
                    async () => await handleDeleteThread(interaction, thread),
                    '删除帖子处理'
                );
                break;

            case '锁定并关闭':
                const reason = interaction.options.getString('理由');
                await ErrorHandler.handleSilent(
                    async () => await handleLockThread(interaction, thread, reason),
                    '锁定帖子处理'
                );
                break;

            case '清理不活跃用户':
                const threshold = interaction.options.getInteger('阈值') || 950;
                const enableAutoCleanup = interaction.options.getBoolean('启用自动清理') ?? true;

                await ErrorHandler.handleSilent(
                    async () => await handleCleanInactiveUsers(interaction, thread, guildConfig, threshold, enableAutoCleanup),
                    '清理不活跃用户处理'
                );
                break;

            case '删除某用户全部消息':
                const targetUser = interaction.options.getUser('目标用户');

                const result = await handleDeleteUserMessages(interaction, thread, guildConfig, targetUser);
                if (!result.success) {
                    await interaction.editReply({
                        content: result.error,
                        flags: ['Ephemeral'],
                    });
                }
                break;

            case '编辑慢速模式':
                const speed = interaction.options.getString('速度');
                if (!speed || !['0', '5', '10', '15', '30', '60'].includes(speed)) {
                    await interaction.editReply({
                        content: '❌ 无效的速度选择',
                        flags: ['Ephemeral'],
                    });
                    return;
                }

                await ErrorHandler.handleInteraction(
                    interaction,
                    async () => {
                        await updateSlowMode(thread, parseInt(speed), interaction.user);
                    },
                    '更新帖子慢速模式',
                    {
                        ephemeral: false,
                        successMessage: '帖子慢速模式已更新'
                    }
                );
                break;

            case '移除帖子反应':
                await ErrorHandler.handleInteraction(
                    interaction,
                    async () => {
                        const starterMessage = await thread.fetchStarterMessage();

                        if (!starterMessage) {
                            throw new Error('无法获取帖子首楼消息');
                        }

                        if (starterMessage.reactions.cache.size === 0) {
                            throw new Error('帖子首楼没有任何反应');
                        }

                        const row = SelectMenuFactory.createReactionRemovalMenu(starterMessage, interaction.user.id);

                        await interaction.editReply({
                            content: '请选择要移除的反应：',
                            components: [row],
                            flags: ['Ephemeral'],
                        });

                        logTime(`[自助管理] 楼主 ${interaction.user.tag} 请求移除帖子 ${thread.name} 首楼的反应`);
                    },
                    '移除帖子反应',
                    { ephemeral: true }
                );
                break;
        }
    },
};
