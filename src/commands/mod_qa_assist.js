import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import {
    buildFastGPTRequestBody,
    fetchUserMessages,
    logQAResult,
    processResponseToAttachment,
    sendToFastGPT,
} from '../services/fastgptService.js';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 用于跟踪活动答疑会话的 Map，键是 guildId，值是当前活动会话数
const activeQASessions = new Map();
const MAX_CONCURRENT_QA = 2; // 每个服务器最大并发数

export default {
    cooldown: 10, // 降低冷却时间，允许多个用户同时请求
    data: new SlashCommandBuilder()
        .setName('答疑')
        .setDescription('使用AI助手回答用户问题')
        .addUserOption(option => option.setName('答疑对象').setDescription('需要回答问题的用户').setRequired(true))
        .addStringOption(option => option.setName('提示词').setDescription('给AI的自定义提示词').setRequired(true))
        .addIntegerOption(option =>
            option
                .setName('消息数量')
                .setDescription('获取用户的最近消息数量（1-10条）')
                .setMinValue(1)
                .setMaxValue(10)
                .setRequired(false),
        )
        .addStringOption(option =>
            option
                .setName('响应格式')
                .setDescription('响应格式（文本或图片）')
                .setChoices({ name: '文本文件', value: 'text' }, { name: '图片', value: 'image' })
                .setRequired(false),
        ),

    async execute(interaction, guildConfig) {
        const currentSessions = activeQASessions.get(interaction.guildId) || 0;

        // 检查是否有超过并发限制
        if (currentSessions >= MAX_CONCURRENT_QA) {
            await interaction.editReply({
                content: `⏳ 当前服务器的答疑任务已达到最大并发数 (${MAX_CONCURRENT_QA})，请稍后再试。`,
                flags: ['Ephemeral'],
            });
            return;
        }

        // 增加会话计数
        activeQASessions.set(interaction.guildId, currentSessions + 1);

        try {
            // 检查FastGPT功能是否启用
            if (!guildConfig.fastgpt?.enabled) {
                await interaction.editReply('❌ 此服务器未启用FastGPT功能');
                return;
            }

            // 获取命令参数
            const targetUser = interaction.options.getUser('答疑对象');
            const prompt = interaction.options.getString('提示词'); // 现在是可选参数
            const messageCount = interaction.options.getInteger('消息数量') || 5; // 默认获取5条消息
            const responseFormat = interaction.options.getString('响应格式') || 'text'; // 默认响应格式为文本文件

            // 权限验证
            const hasAdminPermission = interaction.member.roles.cache.some(role =>
                guildConfig.AdministratorRoleIds.includes(role.id),
            );
            const hasModeratorPermission = interaction.member.roles.cache.some(role =>
                guildConfig.ModeratorRoleIds.includes(role.id),
            );
            const hasQAerPermission = interaction.member.roles.cache.some(
                role => role.id === guildConfig.roleApplication?.QAerRoleId,
            );

            // 检查权限
            if (!hasAdminPermission && !hasModeratorPermission && !hasQAerPermission) {
                await interaction.editReply('❌ 你没有权限使用此命令。需要具有管理员、版主或答疑员身份组。');
                return;
            }

            // 获取用户最近消息
            logTime(`开始获取用户 ${targetUser.tag} 的最近 ${messageCount} 条消息`);
            const userMessages = await fetchUserMessages(interaction.channel, targetUser.id, messageCount);

            if (userMessages.length === 0) {
                await interaction.editReply(`❌ 无法找到用户 ${targetUser.tag} 在当前频道的1小时内消息`);
                return;
            }

            // 保存最近一条消息ID，用于回复
            const recentMessageId = userMessages[0]?.messageId;

            // 构建FastGPT请求体 - 使用新的格式和参数
            const requestBody = buildFastGPTRequestBody(userMessages, prompt, targetUser, interaction.user);

            // 发送处理中的提示
            await interaction.editReply(`⏳ 正在处理用户 ${targetUser.tag} 的问题，请稍候...`);

            // 发送请求到FastGPT API
            const apiResponse = await sendToFastGPT(requestBody, guildConfig);

            // 从响应中提取文本内容
            const responseText = apiResponse.choices[0]?.message?.content;
            if (!responseText) {
                await interaction.editReply('❌ FastGPT返回了空响应');
                return;
            }

            // 处理响应并转换为图片
            const { attachment, imageInfo } = await processResponseToAttachment(apiResponse, responseFormat);

            // 创建临时回复用的Embed
            const replyEmbed = new EmbedBuilder()
                .setTitle('答疑完成')
                .setColor(0x3498db)
                .setDescription(`✅ 已成功为 ${targetUser} 提供答疑`)
                .setTimestamp();

            // 更新原始回复为临时提示
            await interaction.editReply({
                embeds: [replyEmbed],
                files: [],
            });

            // 获取目标消息用于回复
            let targetMessage;
            try {
                targetMessage = await interaction.channel.messages.fetch(recentMessageId);
            } catch (error) {
                logTime(`无法获取目标消息进行回复: ${error.message}`, true);

                // 如果无法获取目标消息，直接在当前频道发送
                await interaction.channel.send({
                    content: `回复给 ${targetUser}:`,
                    files: [attachment],
                });

                return;
            }

            // 回复目标用户的最近消息
            await targetMessage.reply({
                files: [attachment],
            });

            // 记录日志
            logTime(
                `用户 ${interaction.user.tag} 成功对 ${targetUser.tag} 进行了答疑 [图片尺寸: ${imageInfo.width}x${imageInfo.height}px (${imageInfo.sizeKB}KB)]`,
            );

            // 记录到文件
            const timestamp = new Date().toLocaleString('zh-CN');
            await logQAResult(
                {
                    timestamp,
                    executor: interaction.user.tag,
                    target: targetUser.tag,
                    prompt: prompt || '默认',
                    messageCount: userMessages.length,
                    channelName: interaction.channel.name,
                },
                responseText,
                imageInfo,
            );
        } catch (error) {
            await handleCommandError(interaction, error, '答疑命令');
        } finally {
            // 减少会话计数
            const updatedSessions = (activeQASessions.get(interaction.guildId) || 1) - 1;
            if (updatedSessions <= 0) {
                activeQASessions.delete(interaction.guildId);
            } else {
                activeQASessions.set(interaction.guildId, updatedSessions);
            }
        }
    },
};
