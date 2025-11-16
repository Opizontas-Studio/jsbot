import { AttachmentBuilder, SlashCommandBuilder } from 'discord.js';
import { Op } from 'sequelize';
import { pgManager } from '../../pg/pgManager.js';
import { handleCommandError } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';

/**
 * 赛事统计命令
 * 支持两种模式：
 * 1. 从PostsMain数据库查询包含特定关键词的帖子
 * 2. 从当前频道消息中提取帖子链接
 * 然后fetch实际Discord数据生成统计报告
 */
export default {
    cooldown: 10,
    ephemeral: false, // 非ephemeral以便附件能正常显示
    data: new SlashCommandBuilder()
        .setName('赛事统计')
        .setDescription('统计包含特定关键词的帖子信息')
        .addStringOption(option =>
            option
                .setName('比赛名')
                .setDescription('要搜索的比赛名称或关键词（如"拯救杯"）')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('数据来源')
                .setDescription('选择数据来源方式')
                .setRequired(true)
                .addChoices(
                    { name: '数据库', value: 'database' },
                    { name: '当前频道消息', value: 'channel' },
                    { name: '数据库+当前频道消息', value: 'both' }
                )
        )
        .addBooleanOption(option =>
            option
                .setName('排除删卡链接')
                .setDescription('是否排除标题包含"已删"、"删卡"、"已删除"的帖子（默认：是）')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option
                .setName('频道数据需包含比赛名')
                .setDescription('从频道获取的帖子是否要求标题包含比赛名称（默认：是）')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option
                .setName('数据库备选')
                .setDescription('fetch失败时是否使用数据库的旧数据作为备选（默认：否）')
                .setRequired(false)
        ),

    async execute(interaction, guildConfig) {
        try {
            const eventName = interaction.options.getString('比赛名');
            const dataSource = interaction.options.getString('数据来源');
            const excludeDeleted = interaction.options.getBoolean('排除删卡链接') ?? true;
            const channelNeedKeyword = interaction.options.getBoolean('频道数据需包含比赛名') ?? true;
            const useDatabaseFallback = interaction.options.getBoolean('数据库备选') ?? false;

            const fromDatabase = dataSource === 'database' || dataSource === 'both';
            const fromChannel = dataSource === 'channel' || dataSource === 'both';

            // 构建查询提示信息
            const sources = [];
            if (fromDatabase) sources.push('数据库');
            if (fromChannel) sources.push('当前频道消息');
            const sourceText = sources.join('和');

            await interaction.editReply({
                content: `🔄 正在从${sourceText}查询包含"${eventName}"的帖子...`
            });

            const startTime = Date.now();
            const allThreadIds = new Set();
            let dbPostsMap = new Map(); // 存储数据库中的帖子信息，用于备选

            // 从数据库查询
            if (fromDatabase) {
                try {
                    const dbResult = await queryThreadIdsFromDatabase(eventName, interaction, excludeDeleted, useDatabaseFallback);
                    dbResult.threadIds.forEach(id => allThreadIds.add(id));
                    if (useDatabaseFallback && dbResult.postsMap) {
                        dbPostsMap = dbResult.postsMap;
                    }
                    logTime(`[赛事统计] 从数据库找到 ${dbResult.threadIds.length} 个帖子ID`);
                } catch (error) {
                    logTime(`[赛事统计] 数据库查询失败: ${error.message}`, true);
                    // 如果只启用了数据库，则抛出错误；否则继续
                    if (!fromChannel) throw error;
                }
            }

            // 从当前频道消息提取
            if (fromChannel) {
                try {
                    const channelThreadIds = await extractThreadIdsFromChannel(eventName, interaction);
                    channelThreadIds.forEach(id => allThreadIds.add(id));
                    logTime(`[赛事统计] 从当前频道消息找到 ${channelThreadIds.length} 个帖子链接`);
                } catch (error) {
                    logTime(`[赛事统计] 频道消息提取失败: ${error.message}`, true);
                    // 如果只启用了频道，则抛出错误；否则继续
                    if (!fromDatabase) throw error;
                }
            }

            const threadIds = Array.from(allThreadIds);

            if (threadIds.length === 0) {
                await interaction.editReply({
                    content: `✅ 查询完成，未找到包含"${eventName}"的帖子`
                });
                return;
            }

            logTime(`[赛事统计] 去重后共 ${threadIds.length} 个帖子ID，开始fetch实际数据...`);

            // Fetch实际Discord数据
            const threadData = await fetchThreadsData(
                threadIds, 
                interaction, 
                eventName, 
                fromChannel && channelNeedKeyword, // 只有从频道获取且需要关键词时才过滤
                excludeDeleted,
                useDatabaseFallback,
                dbPostsMap
            );

            const executionTime = Date.now() - startTime;

            if (threadData.length === 0) {
                await interaction.editReply({
                    content: `✅ 查询完成，所有帖子均无法访问或已被删除`
                });
                return;
            }

            logTime(`[赛事统计] 用户 ${interaction.user.tag} 查询"${eventName}"，成功获取 ${threadData.length} 个帖子数据，耗时 ${executionTime}ms`);

            // 按论坛分类
            const categorized = {};
            for (const data of threadData) {
                const forumName = data.forum;
                if (!categorized[forumName]) {
                    categorized[forumName] = [];
                }
                categorized[forumName].push(data);
            }

            // 生成统计报告
            const reportContent = generateReport(eventName, threadData, categorized, sourceText, executionTime);

            // 创建附件
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const filename = `event_stats_${eventName}_${timestamp}.txt`;
            const attachment = new AttachmentBuilder(
                Buffer.from(reportContent, 'utf8'),
                { name: filename }
            );

            await interaction.editReply({
                content: `✅ 查询完成！找到 ${threadData.length} 个包含"${eventName}"的帖子 (耗时: ${executionTime}ms)\n📄 详细统计请查看附件`,
                files: [attachment]
            });

        } catch (error) {
            await handleCommandError(interaction, error, '赛事统计失败');
        }
    },
};

/**
 * 从数据库查询包含关键词的帖子ID列表
 * @param {string} eventName - 赛事名称/关键词
 * @param {Object} interaction - Discord交互对象
 * @param {boolean} excludeDeleted - 是否排除删卡链接
 * @param {boolean} needFullData - 是否需要完整数据（用于数据库备选）
 * @returns {Promise<Object>} { threadIds: Array<string>, postsMap?: Map }
 */
async function queryThreadIdsFromDatabase(eventName, interaction, excludeDeleted = true, needFullData = false) {
    // 检查数据库连接
    if (!pgManager.getConnectionStatus()) {
        throw new Error('PostgreSQL数据库未连接');
    }

    const models = pgManager.getModels();

    // 构建查询条件
    const andConditions = [
        {
            title: {
                [Op.like]: `%${eventName}%`
            }
        }
    ];

    // 如果需要排除删卡链接
    if (excludeDeleted) {
        andConditions.push(
            {
                title: {
                    [Op.notLike]: '%已删%'
                }
            },
            {
                title: {
                    [Op.notLike]: '%删卡%'
                }
            },
            {
                title: {
                    [Op.notLike]: '%已删除%'
                }
            }
        );
    }

    const whereClause = {
        [Op.and]: andConditions,
        is_valid: true,
        is_deleted: false,
        in_forum: true
    };

    // 根据是否需要完整数据决定查询的字段
    const attributes = needFullData 
        ? ['thread_id', 'title', 'author_id', 'channel_name', 'created_at', 'reaction_count', 'reply_count', 'jump_url']
        : ['thread_id'];

    // 查询帖子
    const posts = await models.PostsMain.findAll({
        where: whereClause,
        attributes: attributes,
        raw: true
    });

    const threadIds = posts.map(p => p.thread_id.toString());
    
    // 如果需要完整数据，构建Map
    let postsMap = null;
    if (needFullData) {
        postsMap = new Map();
        posts.forEach(post => {
            postsMap.set(post.thread_id.toString(), post);
        });
    }

    return { threadIds, postsMap };
}

/**
 * 从当前频道消息中提取包含关键词的帖子链接
 * @param {string} eventName - 赛事名称/关键词
 * @param {Object} interaction - Discord交互对象
 * @returns {Promise<Array<string>>} 帖子ID列表
 */
async function extractThreadIdsFromChannel(eventName, interaction) {
    const channel = interaction.channel;

    logTime(`[赛事统计] 开始在频道 ${channel.name} 中扫描消息...`);

    // 收集所有消息
    const allMessages = [];
    let lastMessageId = null;
    let messageCount = 0;

    // 分批读取消息，每批100条
    while (true) {
        const options = { limit: 100 };
        if (lastMessageId) {
            options.before = lastMessageId;
        }

        const messages = await channel.messages.fetch(options);

        if (messages.size === 0) break;

        allMessages.push(...messages.values());
        messageCount += messages.size;
        lastMessageId = messages.last().id;

        logTime(`[赛事统计] 已读取 ${messageCount} 条消息...`);

        // 如果这批消息不足100条，说明已经读到最早的消息
        if (messages.size < 100) break;
    }

    logTime(`[赛事统计] 消息读取完成，共 ${messageCount} 条消息，开始提取帖子链接...`);

    // 处理消息，提取帖子ID
    const threadIds = new Set();
    const threadLinkRegex = /channels\/(\d+)\/(?:\d+\/threads\/)?(\d+)/g;

    for (const message of allMessages) {
        const content = message.content;
        if (!content) continue;

        const matches = [...content.matchAll(threadLinkRegex)];

        for (const match of matches) {
            const threadId = match[2];
            threadIds.add(threadId);
        }
    }

    logTime(`[赛事统计] 从消息中提取到 ${threadIds.size} 个帖子链接`);

    return Array.from(threadIds);
}

/**
 * Fetch帖子的实际Discord数据
 * @param {Array<string>} threadIds - 帖子ID列表
 * @param {Object} interaction - Discord交互对象
 * @param {string} eventName - 赛事名称（用于关键词过滤）
 * @param {boolean} needKeywordFilter - 是否需要检查标题包含关键词
 * @param {boolean} excludeDeleted - 是否排除删卡链接
 * @param {boolean} useDatabaseFallback - 是否使用数据库备选
 * @param {Map} dbPostsMap - 数据库帖子数据映射
 * @returns {Promise<Array>} 帖子数据列表
 */
async function fetchThreadsData(threadIds, interaction, eventName, needKeywordFilter, excludeDeleted, useDatabaseFallback, dbPostsMap) {
    const { client, guild } = interaction;
    const threadData = [];
    let fallbackCount = 0;

    for (const threadId of threadIds) {
        try {
            // Fetch帖子
            const thread = await client.channels.fetch(threadId).catch(() => null);

            // 如果fetch失败且启用了数据库备选
            if (!thread && useDatabaseFallback && dbPostsMap && dbPostsMap.has(threadId)) {
                const dbPost = dbPostsMap.get(threadId);
                
                // 检查是否需要排除删卡
                if (excludeDeleted && isDeletedTitle(dbPost.title)) {
                    logTime(`[赛事统计] 帖子 ${threadId} 标题包含删除标记，跳过`);
                    continue;
                }

                // 检查关键词过滤
                if (needKeywordFilter && !dbPost.title.includes(eventName)) {
                    logTime(`[赛事统计] 帖子 ${threadId} 标题不包含"${eventName}"，跳过`);
                    continue;
                }

                // 使用数据库数据
                threadData.push({
                    threadId: threadId,
                    title: dbPost.title,
                    authorId: dbPost.author_id.toString(),
                    authorDisplay: `用户${dbPost.author_id}`,
                    createdAt: new Date(dbPost.created_at),
                    forum: dbPost.channel_name || '未知论坛',
                    forumId: null,
                    maxReactions: dbPost.reaction_count || 0,
                    replyCount: dbPost.reply_count || 0,
                    url: dbPost.jump_url,
                    fromDatabase: true // 标记为数据库备选数据
                });

                fallbackCount++;
                logTime(`[赛事统计] ✓ [备选] 使用数据库数据: ${dbPost.title} (赞数: ${dbPost.reaction_count}, 回复数: ${dbPost.reply_count})`);
                continue;
            }

            if (!thread || !thread.isThread()) {
                logTime(`[赛事统计] 频道 ${threadId} 不是帖子，跳过`);
                continue;
            }

            // 检查标题是否包含排除关键词
            if (excludeDeleted && isDeletedTitle(thread.name)) {
                logTime(`[赛事统计] 帖子 ${thread.name} 标题包含删除标记，跳过`);
                continue;
            }

            // 如果需要关键词过滤
            if (needKeywordFilter && !thread.name.includes(eventName)) {
                logTime(`[赛事统计] 帖子 ${thread.name} 标题不包含"${eventName}"，跳过`);
                continue;
            }

            // Fetch帖子的首楼消息
            const starterMessage = await thread.fetchStarterMessage().catch(() => null);

            if (!starterMessage) {
                logTime(`[赛事统计] 帖子 ${thread.name} 没有首楼消息，跳过`);
                continue;
            }

            // 获取首楼的最高反应数
            let maxReactions = 0;
            if (starterMessage.reactions.cache.size > 0) {
                maxReactions = Math.max(...starterMessage.reactions.cache.map(r => r.count));
            }

            // 获取帖子评论数（消息总数 - 1，因为首楼不算）
            const replyCount = thread.messageCount ? thread.messageCount - 1 : 0;

            // 获取父频道（论坛）
            const parentChannel = thread.parent;

            // 获取作者信息
            let authorDisplay = '未知用户';
            try {
                const author = await client.users.fetch(thread.ownerId);
                const member = await guild.members.fetch(thread.ownerId).catch(() => null);

                const username = author.username || author.tag;
                const displayName = member?.displayName || username;

                authorDisplay = `${username}(${displayName})`;
            } catch (error) {
                logTime(`[赛事统计] 无法获取用户 ${thread.ownerId} 信息: ${error.message}`, true);
            }

            threadData.push({
                threadId: thread.id,
                title: thread.name,
                authorId: thread.ownerId,
                authorDisplay,
                createdAt: thread.createdAt,
                forum: parentChannel ? parentChannel.name : '未知论坛',
                forumId: parentChannel ? parentChannel.id : null,
                maxReactions,
                replyCount,
                url: `https://discord.com/channels/${thread.guildId}/${thread.id}`,
                fromDatabase: false
            });

            logTime(`[赛事统计] ✓ 记录帖子: ${thread.name} (赞数: ${maxReactions}, 回复数: ${replyCount})`);

        } catch (error) {
            logTime(`[赛事统计] 处理帖子 ${threadId} 时出错: ${error.message}`, true);
            
            // 如果fetch失败且启用了数据库备选
            if (useDatabaseFallback && dbPostsMap && dbPostsMap.has(threadId)) {
                const dbPost = dbPostsMap.get(threadId);
                
                // 检查是否需要排除删卡
                if (excludeDeleted && isDeletedTitle(dbPost.title)) {
                    continue;
                }

                // 检查关键词过滤
                if (needKeywordFilter && !dbPost.title.includes(eventName)) {
                    continue;
                }

                threadData.push({
                    threadId: threadId,
                    title: dbPost.title,
                    authorId: dbPost.author_id.toString(),
                    authorDisplay: `用户${dbPost.author_id}`,
                    createdAt: new Date(dbPost.created_at),
                    forum: dbPost.channel_name || '未知论坛',
                    forumId: null,
                    maxReactions: dbPost.reaction_count || 0,
                    replyCount: dbPost.reply_count || 0,
                    url: dbPost.jump_url,
                    fromDatabase: true
                });

                fallbackCount++;
                logTime(`[赛事统计] ✓ [备选] 使用数据库数据: ${dbPost.title}`);
            }
        }
    }

    if (fallbackCount > 0) {
        logTime(`[赛事统计] 使用数据库备选数据共 ${fallbackCount} 个帖子`);
    }

    return threadData;
}

/**
 * 检查标题是否包含删除标记
 * @param {string} title - 帖子标题
 * @returns {boolean} 是否包含删除标记
 */
function isDeletedTitle(title) {
    const deleteKeywords = ['已删', '删卡', '已删除'];
    return deleteKeywords.some(keyword => title.includes(keyword));
}

/**
 * 生成统计报告文本
 * @param {string} eventName - 赛事名称
 * @param {Array} threadData - 帖子数据列表
 * @param {Object} categorized - 按论坛分类的帖子
 * @param {string} sourceText - 数据来源描述文本
 * @param {number} executionTime - 查询耗时
 * @returns {string} 报告文本
 */
function generateReport(eventName, threadData, categorized, sourceText, executionTime) {
    let report = '赛事帖子统计报告\n';
    report += '='.repeat(120) + '\n';

    // 格式化当前时间为UTC+8
    const now = new Date();
    const utc8Time = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    report += `统计时间: ${utc8Time.toISOString().replace('T', ' ').substring(0, 19)} (UTC+8)\n`;
    report += `搜索关键词: ${eventName}\n`;
    report += `数据来源: ${sourceText}\n`;
    report += `查询耗时: ${executionTime}ms\n`;
    report += `总帖子数: ${threadData.length}\n`;
    report += `论坛分类数: ${Object.keys(categorized).length}\n`;
    report += '='.repeat(120) + '\n\n';

    // 按论坛输出，每个论坛内按点赞数排序
    for (const [forumName, forumThreads] of Object.entries(categorized)) {
        // 确保按点赞数降序排序
        forumThreads.sort((a, b) => b.maxReactions - a.maxReactions);

        report += `\n【${forumName}】 (共 ${forumThreads.length} 个帖子)\n`;
        report += '-'.repeat(120) + '\n';

        for (const thread of forumThreads) {
            // 格式: 👍 ${点赞数} | 作者（作者服务器显示名） | 标题 | 回复数：... | 发帖时间：... | 链接
            const createdTime = new Date(thread.createdAt);
            const createdTimeUTC8 = new Date(createdTime.getTime() + 8 * 60 * 60 * 1000);
            const formattedTime = createdTimeUTC8.toISOString().replace('T', ' ').substring(0, 19);

            // 如果是数据库备选数据，添加标记
            const dataSource = thread.fromDatabase ? ' [数据库备选]' : '';

            report += `👍 ${thread.maxReactions} | ${thread.authorDisplay} | ${thread.title}${dataSource} | 回复数：${thread.replyCount} | 发帖时间：${formattedTime} | ${thread.url}\n`;
        }
    }

    // 添加汇总统计
    report += '\n' + '='.repeat(120) + '\n';
    report += '汇总统计\n';
    report += '-'.repeat(120) + '\n';

    const totalReactions = threadData.reduce((sum, t) => sum + t.maxReactions, 0);
    const totalReplies = threadData.reduce((sum, t) => sum + t.replyCount, 0);
    const avgReactions = threadData.length > 0 ? (totalReactions / threadData.length).toFixed(2) : 0;
    const avgReplies = threadData.length > 0 ? (totalReplies / threadData.length).toFixed(2) : 0;

    report += `总点赞数: ${totalReactions}\n`;
    report += `总回复数: ${totalReplies}\n`;
    report += `平均点赞数: ${avgReactions}\n`;
    report += `平均回复数: ${avgReplies}\n`;

    return report;
}

