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
// 用于跟踪正在处理的目标用户，防止对同一用户并发处理，存储 guildId-targetUserId
const activeTargetUserSessions = new Set();
const MAX_CONCURRENT_QA = 2; // 每个服务器最大并发数

/**
 * 创建进度更新的Embed
 * @param {String} title - Embed标题
 * @param {String} description - Embed描述
 * @param {Number} color - Embed颜色代码
 * @returns {EmbedBuilder} 生成的Embed
 */
function createStatusEmbed(title, description, color = 0x3498db) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
}

export default {
    cooldown: 10,
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
        const targetUser = interaction.options.getUser('答疑对象');
        const targetUserLockKey = `${interaction.guildId}-${targetUser.id}`;

        // 检查是否已有针对同一用户的请求在处理
        if (activeTargetUserSessions.has(targetUserLockKey)) {
            const errorEmbed = createStatusEmbed(
                '答疑任务冲突',
                `⏳ 已有另一个针对用户 ${targetUser.tag} 的答疑任务正在运行，请稍后再试。`,
                0xf44336 // 红色
            );

            await interaction.editReply({
                embeds: [errorEmbed],
                flags: ['Ephemeral'],
            });
            return;
        }

        const currentSessions = activeQASessions.get(interaction.guildId) || 0;

        // 检查是否有超过并发限制
        if (currentSessions >= MAX_CONCURRENT_QA) {
            const limitEmbed = createStatusEmbed(
                '并发任务已达上限',
                `⏳ 当前服务器的答疑任务已达到最大并发数 (${MAX_CONCURRENT_QA})，请稍后再试。`,
                0xf44336 // 红色
            );

            await interaction.editReply({
                embeds: [limitEmbed],
                flags: ['Ephemeral'],
            });
            return;
        }

        // 获取目标用户锁
        activeTargetUserSessions.add(targetUserLockKey);
        // 增加服务器会话计数
        activeQASessions.set(interaction.guildId, currentSessions + 1);

        try {
            // 检查FastGPT功能是否启用
            if (!guildConfig.fastgpt?.enabled) {
                const disabledEmbed = createStatusEmbed(
                    '功能未启用',
                    '❌ 此服务器未启用FastGPT功能',
                    0xf44336 // 红色
                );

                await interaction.editReply({ embeds: [disabledEmbed] });
                return;
            }

            // 获取命令参数
            const prompt = interaction.options.getString('提示词'); // 现在是可选参数
            const messageCount = interaction.options.getInteger('消息数量') || 5; // 默认获取5条消息
            const responseFormat = interaction.options.getString('响应格式') || 'image'; // 默认响应格式为图片

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
                const permissionEmbed = createStatusEmbed(
                    '权限不足',
                    '❌ 你没有权限使用此命令。需要具有管理员、版主或答疑员身份组。',
                    0xf44336 // 红色
                );

                await interaction.editReply({ embeds: [permissionEmbed] });
                return;
            }

            // 获取用户最近消息
            logTime(`开始获取用户 ${targetUser.tag} 的最近 ${messageCount} 条消息`);
            const userMessages = await fetchUserMessages(interaction.channel, targetUser.id, messageCount);

            if (userMessages.length === 0) {
                const noMessagesEmbed = createStatusEmbed(
                    '未找到消息',
                    `❌ 无法找到用户 ${targetUser.tag} 在当前频道的1小时内消息`,
                    0xf44336 // 红色
                );

                await interaction.editReply({ embeds: [noMessagesEmbed] });
                return;
            }

            // 保存最近一条消息ID，用于回复
            const recentMessageId = userMessages[0]?.messageId;

            // 构建FastGPT请求体 - 使用新的格式和参数
            const requestBody = buildFastGPTRequestBody(userMessages, prompt, targetUser, interaction.user);

            // 准备初始日志数据
            const logInitData = {
                timestamp: new Date().toLocaleString('zh-CN'),
                executor: interaction.user.tag,
                target: targetUser.tag,
                prompt: prompt || '默认',
                messageCount: userMessages.length,
                channelName: interaction.channel.name,
            };

            // 发送处理中的提示
            const processingEmbed = createStatusEmbed(
                '正在处理',
                `⏳ 正在处理用户 ${targetUser.tag} 的问题，请稍候...`,
                0xffa500 // 橙色
            );

            await interaction.editReply({ embeds: [processingEmbed] });

            try {
                // 发送请求到FastGPT API，传入interaction用于进度更新和logInitData用于日志记录
                const apiResponse = await sendToFastGPT(requestBody, guildConfig, interaction, logInitData);

                // 从响应中提取文本内容
                const responseText = apiResponse.choices[0]?.message?.content;
                if (!responseText) {
                    const emptyResponseEmbed = createStatusEmbed(
                        '响应为空',
                        '❌ FastGPT返回了空响应',
                        0xf44336 // 红色
                    );

                    await interaction.editReply({ embeds: [emptyResponseEmbed] });
                    // 记录日志
                    await logQAResult(logInitData, null, null, null, 'failed', apiResponse.endpoint || null, 'FastGPT返回了空响应');
                    return;
                }

                // 立即更新进度消息，清除超时倒计时信息
                const processingResponseEmbed = createStatusEmbed(
                    '处理响应',
                    `✅ 请求成功，正在处理响应...`,
                    0x00cc66 // 绿色
                );

                await interaction.editReply({ embeds: [processingResponseEmbed] });

                // 处理响应并转换为图片
                const { attachment, imageInfo, links } = await processResponseToAttachment(apiResponse, responseFormat);

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

                    // 记录日志 - 成功但发送方式不同
                    await logQAResult(
                        logInitData,
                        responseText,
                        imageInfo,
                        links,
                        'success',
                        apiResponse.endpoint || null,
                    );

                    return;
                }

                // 构建回复内容，如果存在链接且是图片格式，则添加链接
                let replyContent = '';
                if (responseFormat === 'image' && links && links.length > 0) {
                    replyContent = `**以下是回复中包含的链接：**\n${links
                        .map((link, index) => {
                            // 如果链接是对象(有text和url)，则使用"[文本](URL)"格式
                            if (typeof link === 'object' && link.text && link.url) {
                                return `• [${link.text}](${link.url})`;
                            }
                            // 否则直接显示URL
                            return `• ${link}`;
                        })
                        .join('\n')}`;
                }

                // 回复目标用户的最近消息
                await targetMessage.reply({
                    content: replyContent || null,
                    files: [attachment],
                });

                // 记录日志
                logTime(
                    `用户 ${interaction.user.tag} 成功对 ${targetUser.tag} 进行了答疑 [图片尺寸: ${imageInfo.width}x${
                        imageInfo.height
                    }px (${imageInfo.sizeKB}KB)]${links?.length > 0 ? ` [包含${links.length}个链接]` : ''}`,
                );

                // 记录到文件 - 完整成功日志
                await logQAResult(logInitData, responseText, imageInfo, links, 'success', apiResponse.endpoint || null);
            } catch (error) {
                // 错误消息
                await handleCommandError(interaction, error, '答疑命令');
            }
        } catch (error) {
            await handleCommandError(interaction, error, '答疑命令');
        } finally {
            // 释放目标用户锁
            activeTargetUserSessions.delete(targetUserLockKey);
            // 减少服务器会话计数
            const updatedSessions = (activeQASessions.get(interaction.guildId) || 1) - 1;
            if (updatedSessions <= 0) {
                activeQASessions.delete(interaction.guildId);
            } else {
                activeQASessions.set(interaction.guildId, updatedSessions);
            }
        }
    },
};
