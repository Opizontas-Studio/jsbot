import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { logTime } from '../utils/logger.js';

const qualifiedUsersPath = join(process.cwd(), 'data', 'qualifiedSuggestionUsers.json');

/**
 * 读取合格建议用户记录
 * @returns {Object} 用户记录对象
 */
function readQualifiedUsers() {
    try {
        return JSON.parse(readFileSync(qualifiedUsersPath, 'utf8'));
    } catch (error) {
        logTime(`[意见监控] 读取合格建议用户记录失败: ${error.message}`, true);
        return { users: {} };
    }
}

/**
 * 保存合格建议用户记录
 * @param {Object} data - 用户记录数据
 */
function saveQualifiedUsers(data) {
    try {
        writeFileSync(qualifiedUsersPath, JSON.stringify(data, null, 4), 'utf8');
    } catch (error) {
        logTime(`[意见监控] 保存合格建议用户记录失败: ${error.message}`, true);
    }
}

/**
 * 检查用户是否有提交过合理建议的记录
 * @param {string} userId - 用户ID
 * @returns {boolean} 是否有合理建议记录
 */
export function hasQualifiedSuggestion(userId) {
    const data = readQualifiedUsers();
    return !!data.users[userId];
}

/**
 * 添加用户到合格建议记录
 * @param {string} userId - 用户ID
 * @param {Object} suggestionInfo - 建议信息
 */
export function addQualifiedUser(userId, suggestionInfo) {
    const data = readQualifiedUsers();

    if (!data.users[userId]) {
        data.users[userId] = {
            firstQualifiedAt: Date.now(),
            suggestions: []
        };
    }

    data.users[userId].suggestions.push({
        messageId: suggestionInfo.messageId,
        timestamp: suggestionInfo.timestamp,
        title: suggestionInfo.title,
        reactionCount: suggestionInfo.reactionCount
    });

    saveQualifiedUsers(data);
    logTime(`[意见监控] 用户 ${userId} 的建议获得认可，已记录到合格建议列表`);
}

/**
 * 处理意见信箱消息的反应监控
 * @param {MessageReaction} reaction - 反应对象
 * @param {User} user - 反应用户
 * @param {Client} client - Discord客户端
 */
export async function handleOpinionReaction(reaction, user, client) {
    try {
        // 检查是否是白勾表情
        if (reaction.emoji.name !== '✅') {
            return;
        }

        // 检查是否是意见信箱频道
        const message = reaction.message;
        const guildConfig = client.guildManager.getGuildConfig(message.guild.id);

        if (!guildConfig?.opinionMailThreadId || message.channel.id !== guildConfig.opinionMailThreadId) {
            return;
        }

        // 检查消息是否有embed（意见投稿消息都有embed）
        if (!message.embeds || message.embeds.length === 0) {
            return;
        }

        const embed = message.embeds[0];

        // 获取原始投稿者ID（从author字段获取）
        if (!embed.author || !embed.author.name) {
            return;
        }

        // 从author.name中提取用户标签，然后通过guild成员查找用户ID
        const authorTag = embed.author.name;
        let authorId = null;

        try {
            // 尝试通过用户标签找到用户
            const members = await message.guild.members.fetch();
            const targetMember = members.find(member => member.user.tag === authorTag);

            if (targetMember) {
                authorId = targetMember.user.id;
            } else {
                logTime(`[意见监控] 无法找到投稿者: ${authorTag}`, true);
                return;
            }
        } catch (error) {
            logTime(`[意见监控] 查找投稿者失败: ${error.message}`, true);
            return;
        }

        // 检查反应数量是否达到阈值（至少1个✅反应）
        const checkMarkReaction = reaction.emoji.name === '✅' ? reaction : null;
        if (!checkMarkReaction || checkMarkReaction.count < 1) {
            return;
        }

        // 记录用户到合格建议列表
        const suggestionInfo = {
            messageId: message.id,
            timestamp: Date.now(),
            title: embed.title.replace('💬 社区意见：', '').trim(),
            reactionCount: checkMarkReaction.count
        };

        addQualifiedUser(authorId, suggestionInfo);

        logTime(`[意见监控] 用户 ${authorTag}(${authorId}) 的建议 "${suggestionInfo.title}" 获得了 ${suggestionInfo.reactionCount} 个认可反应`);

    } catch (error) {
        logTime(`[意见监控] 处理意见反应时出错: ${error.message}`, true);
    }
}

/**
 * 获取用户的合理建议记录
 * @param {string} userId - 用户ID
 * @returns {Object|null} 用户的建议记录
 */
export function getUserSuggestionRecord(userId) {
    const data = readQualifiedUsers();
    return data.users[userId] || null;
}
