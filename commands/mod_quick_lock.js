import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { handleCommandError, lockAndArchiveThread, checkAndHandlePermission } from '../utils/helper.js';

export default {
	cooldown: 10,
	data: new SlashCommandBuilder()
	    .setName('一键锁定关贴')
	    .setDescription('锁定并归档当前论坛帖子')
	    .addStringOption(option =>
	        option.setName('理由')
	            .setDescription('处理原因')
	            .setRequired(true),
	    )
	    // 设置命令需要的默认权限为管理消息
	    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

	async execute(interaction, guildConfig) {
	    try {
	        // 检查用户是否有管理消息的权限（只检查频道权限）
	        if (!await checkAndHandlePermission(interaction, [], {
	            checkChannelPermission: true,
	            errorMessage: '你没有权限锁定此帖子。需要具有管理消息的权限。',
	        })) {
	            return;
	        }

	        // 验证当前频道是否为论坛帖子
	        if (!interaction.channel.isThread()) {
	            await interaction.editReply({
	                content: '❌ 当前频道不是子区或帖子',
	                flags: ['Ephemeral'],
	            });
	            return;
	        }

	        // 检查父频道是否为论坛
	        const parentChannel = interaction.channel.parent;
	        if (!parentChannel || parentChannel.type !== ChannelType.GuildForum) {
	            await interaction.editReply({
	                content: '❌ 此子区不属于论坛频道',
	                flags: ['Ephemeral'],
	            });
	            return;
	        }

	        const reason = interaction.options.getString('理由');
	        const thread = interaction.channel;

	        // 执行锁定操作
	        await lockAndArchiveThread(thread, interaction.user, reason, {
	            isAdmin: true,
	            guildConfig,
	        });

	        await interaction.editReply({
	            content: `✅ 已成功锁定并归档帖子 "${thread.name}"`,
	            flags: ['Ephemeral'],
	        });

	    }
		catch (error) {
	        await handleCommandError(interaction, error, '一键锁定关贴');
	    }
	},
};