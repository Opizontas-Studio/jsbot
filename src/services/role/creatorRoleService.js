import { ChannelType } from 'discord.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'path';
import { EmbedFactory } from '../../factories/embedFactory.js';
import { globalRequestQueue } from '../../utils/concurrency.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';
import { manageRolesByGroups, getRoleSyncConfig } from './roleApplication.js';
import { pgManager } from '../../pg/pgManager.js';

const optOutFilePath = join(process.cwd(), 'data', 'creatorRoleOptOut.json');

/**
 * 创作者身份组自动发放限速器
 * 每10分钟只发放一个
 */
class CreatorRoleRateLimiter {
    constructor() {
        this.lastGrantTime = 0;
        this.interval = 10 * 60 * 1000; // 10分钟
    }

    /**
     * 检查是否可以发放
     * @returns {boolean}
     */
    canGrant() {
        const now = Date.now();
        if (now - this.lastGrantTime >= this.interval) {
            this.lastGrantTime = now;
            return true;
        }
        return false;
    }

    /**
     * 获取下次可发放时间（毫秒）
     * @returns {number}
     */
    getNextGrantTime() {
        const now = Date.now();
        return Math.max(0, this.lastGrantTime + this.interval - now);
    }
}

const rateLimiter = new CreatorRoleRateLimiter();

/**
 * 读取创作者身份组放弃名单
 * @returns {Set<string>} 用户ID集合
 */
export const getOptOutList = () => {
    return ErrorHandler.handleServiceSync(
        () => {
            if (!existsSync(optOutFilePath)) {
                return new Set();
            }
            const data = JSON.parse(readFileSync(optOutFilePath, 'utf8'));
            return new Set(Array.isArray(data.optOutUsers) ? data.optOutUsers : []);
        },
        "读取创作者身份组放弃名单",
        { throwOnError: false }
    )?.data || new Set();
};

/**
 * 保存创作者身份组放弃名单
 * @param {Set<string>} optOutSet - 用户ID集合
 */
export const saveOptOutList = (optOutSet) => {
    return ErrorHandler.handleServiceSync(
        () => {
            const data = {
                optOutUsers: Array.from(optOutSet),
                lastUpdated: new Date().toISOString()
            };
            writeFileSync(optOutFilePath, JSON.stringify(data, null, 2), 'utf8');
            logTime(`[创作者身份组] 已保存放弃名单，共 ${optOutSet.size} 位用户`);
        },
        "保存创作者身份组放弃名单",
        { throwOnError: true }
    );
};

/**
 * 添加用户到放弃名单
 * @param {string} userId - 用户ID
 */
export const addToOptOutList = (userId) => {
    const optOutSet = getOptOutList();
    optOutSet.add(userId);
    saveOptOutList(optOutSet);
    logTime(`[创作者身份组] 用户 ${userId} 已加入放弃名单`);
};

/**
 * 从放弃名单中移除用户
 * @param {string} userId - 用户ID
 */
export const removeFromOptOutList = (userId) => {
    const optOutSet = getOptOutList();
    if (optOutSet.has(userId)) {
        optOutSet.delete(userId);
        saveOptOutList(optOutSet);
        logTime(`[创作者身份组] 用户 ${userId} 已从放弃名单移除`);
    }
};

/**
 * 检查用户是否在放弃名单中
 * @param {string} userId - 用户ID
 * @returns {boolean}
 */
export const isUserOptedOut = (userId) => {
    const optOutSet = getOptOutList();
    return optOutSet.has(userId);
};

/**
 * 处理用户放弃创作者身份组
 * @param {ButtonInteraction} interaction - 按钮交互对象
 */
export async function handleOptOutCreatorRole(interaction) {
    await ErrorHandler.handleInteraction(
        interaction,
        async () => {
            // 获取服务器配置
            const guildConfig = interaction.client.guildManager.getGuildConfig(interaction.guildId);
            if (!guildConfig.roleApplication?.creatorRoleId) {
                throw new Error('服务器未配置创作者身份组功能');
            }

            // 检查用户是否有创作者身份组
            const member = await interaction.guild.members.fetch(interaction.user.id);
            if (!member.roles.cache.has(guildConfig.roleApplication.creatorRoleId)) {
                throw new Error('您没有创作者身份组，无需放弃');
            }

            // 获取创作者同步组配置
            const creatorSyncGroup = getCreatorSyncGroup();

            if (!creatorSyncGroup) {
                throw new Error('无法找到创作者身份组同步配置');
            }

            // 移除创作者身份组
            const result = await manageRolesByGroups(
                interaction.client,
                interaction.user.id,
                [creatorSyncGroup],
                '用户自行放弃创作者身份组',
                true // 移除操作
            );

            if (!result.success) {
                throw new Error('放弃创作者身份组失败，请联系管理员');
            }

            // 从 PostgreSQL 删除记录
            const creatorRoleId = guildConfig.roleApplication?.creatorRoleId;
            await removeUserRoleFromPG(interaction.user.id, creatorRoleId);

            // 将用户添加到放弃名单
            addToOptOutList(interaction.user.id);

            // 使用EmbedFactory创建成功消息
            const successEmbed = EmbedFactory.createCreatorRoleOptOutSuccessEmbed(result.successfulServers);

            await interaction.editReply({
                embeds: [successEmbed]
            });

            logTime(`[创作者身份组] 用户 ${interaction.user.tag} 已成功放弃创作者身份组`);
        },
        "处理用户放弃创作者身份组",
        { ephemeral: true }
    );
}

/**
 * 获取创作者同步组配置
 * @returns {Object|null} 创作者同步组配置
 */
function getCreatorSyncGroup() {
    const roleSyncConfig = getRoleSyncConfig();
    const syncGroups = Array.isArray(roleSyncConfig?.syncGroups) ? roleSyncConfig.syncGroups : [];
    return syncGroups.find(group => group.name === '创作者') || null;
}

/**
 * 从 PostgreSQL 统计创作者总数
 * @param {string} creatorRoleId - 创作者身份组ID
 * @returns {Promise<number>} 创作者总数
 */
async function getCreatorCount(creatorRoleId) {
    return await ErrorHandler.handleService(
        async () => {
            if (!pgManager.getConnectionStatus() || !creatorRoleId) {
                return 0;
            }

            const models = pgManager.getModels();
            const count = await models.UserRoles.count({
                where: { role_id: creatorRoleId }
            });

            return count;
        },
        "统计创作者总数",
        { throwOnError: false }
    )?.data || 0;
}

/**
 * 检查并获取最高反应数
 * @param {Message} message - 首条消息对象
 * @returns {number} 最高反应数
 */
function getMaxReactionsFromMessage(message) {
    if (!message) {
        return 0;
    }

    let maxReactions = 0;
    message.reactions.cache.forEach(reaction => {
        if (reaction.count > maxReactions) {
            maxReactions = reaction.count;
        }
    });

    return maxReactions;
}

/**
 * 从 PostgreSQL 删除用户的创作者身份组记录
 * @param {string} userId - 用户ID
 * @param {string} creatorRoleId - 创作者身份组ID
 */
async function removeUserRoleFromPG(userId, creatorRoleId) {
    await ErrorHandler.handleSilent(
        async () => {
            if (!pgManager.getConnectionStatus() || !creatorRoleId) {
                return;
            }

            const models = pgManager.getModels();
            
            const deletedCount = await models.UserRoles.destroy({
                where: {
                    user_id: userId,
                    role_id: creatorRoleId
                }
            });

            if (deletedCount > 0) {
                logTime(`[创作者身份组] 已从 PostgreSQL 删除用户 ${userId} 的身份组记录`);
            }
        },
        "从PostgreSQL删除用户身份组记录"
    );
}

/**
 * 立即同步用户的创作者身份组到 PostgreSQL
 * @param {string} userId - 用户ID
 * @param {string} creatorRoleId - 创作者身份组ID
 */
async function syncUserRoleToPG(userId, creatorRoleId) {
    await ErrorHandler.handleSilent(
        async () => {
            if (!pgManager.getConnectionStatus() || !creatorRoleId) {
                return;
            }

            const models = pgManager.getModels();
            
            // 使用 findOrCreate 确保数据存在且不重复
            await models.UserRoles.findOrCreate({
                where: {
                    user_id: userId,
                    role_id: creatorRoleId
                },
                defaults: {
                    user_id: userId,
                    role_id: creatorRoleId
                }
            });
        },
        "同步用户身份组到PostgreSQL"
    );
}

/**
 * 发送创作者欢迎私聊消息
 * @param {Object} client - Discord客户端
 * @param {string} userId - 用户ID
 * @param {Array<string>} syncedServers - 同步成功的服务器列表
 * @param {number} totalCreators - 创作者总数
 * @param {string} logPrefix - 日志前缀
 */
async function sendCreatorWelcomeMessage(client, userId, syncedServers, totalCreators, logPrefix) {
    await ErrorHandler.handleSilent(
        async () => {
            const user = await client.users.fetch(userId);
            const successEmbed = EmbedFactory.createCreatorRoleSuccessEmbed(
                syncedServers, 
                totalCreators
            );
            await user.send({ embeds: [successEmbed] });
            logTime(`[${logPrefix}] 已向用户 ${user.tag} 发送欢迎消息`);
        },
        "发送创作者欢迎私聊消息"
    );
}

/**
 * 自动为符合条件的帖子作者发放创作者身份组
 * @param {Object} client - Discord客户端
 * @param {string} threadId - 帖子ID
 * @param {string} authorId - 作者ID
 * @returns {Promise<{granted: boolean, reason?: string}>}
 */
export async function autoGrantCreatorRole(client, threadId, authorId) {
    return await ErrorHandler.handleService(
        async () => {
            // 1. 检查限速器
            if (!rateLimiter.canGrant()) {
                const nextGrantTime = rateLimiter.getNextGrantTime();
                const minutesLeft = Math.ceil(nextGrantTime / 60000);
                return { 
                    granted: false, 
                    reason: `限速：下次可发放时间还有 ${minutesLeft} 分钟` 
                };
            }

            // 2. 检查用户是否在放弃名单中
            if (isUserOptedOut(authorId)) {
                return { 
                    granted: false, 
                    reason: '用户已放弃自动获取创作者身份组' 
                };
            }

            // 3. 检查PostgreSQL连接
            if (!pgManager.getConnectionStatus()) {
                return { 
                    granted: false, 
                    reason: 'PostgreSQL未连接' 
                };
            }

            // 4. 获取创作者同步组配置
            const creatorSyncGroup = getCreatorSyncGroup();

            if (!creatorSyncGroup) {
                return { 
                    granted: false, 
                    reason: '未找到创作者同步组配置' 
                };
            }

            // 从数据库检查作者是否已有创作者身份组
            const models = pgManager.getModels();

            // 获取创作者身份组ID（从主服务器配置）
            const mainGuildConfig = client.guildManager.getMainServerConfig();
            const creatorRoleId = mainGuildConfig?.roleApplication?.creatorRoleId;

            if (!creatorRoleId) {
                return { 
                    granted: false, 
                    reason: '未配置创作者身份组ID' 
                };
            }

            // 检查数据库中是否已有此身份组
            const existingRole = await models.UserRoles.findOne({
                where: {
                    user_id: authorId,
                    role_id: creatorRoleId
                },
                raw: true
            });

            if (existingRole) {
                return { 
                    granted: false, 
                    reason: '用户已有创作者身份组' 
                };
            }

            // 5. 获取帖子信息并检查反应数
            const thread = await client.channels.fetch(threadId);
            if (!thread || !thread.isThread()) {
                return { 
                    granted: false, 
                    reason: '帖子不存在或已被删除' 
                };
            }

            // 获取首条消息检查反应数
            const firstMessage = await thread.messages.fetch({ limit: 1, after: '0' });
            const threadStarter = firstMessage.first();
            const maxReactions = getMaxReactionsFromMessage(threadStarter);
            
            if (maxReactions < 5) {
                return { 
                    granted: false, 
                    reason: `反应数不足（当前 ${maxReactions}/5）` 
                };
            }

            // 6. 发放创作者身份组
            const grantResult = await manageRolesByGroups(
                client,
                authorId,
                [creatorSyncGroup],
                '自动发放创作者身份组',
                false // 添加操作
            );

            if (!grantResult.success) {
                return { 
                    granted: false, 
                    reason: '发放身份组失败' 
                };
            }

            // 7. 立即同步到 PostgreSQL
            await syncUserRoleToPG(authorId, creatorRoleId);

            // 8. 统计创作者总数并发送欢迎消息
            const totalCreators = await getCreatorCount(creatorRoleId);
            await sendCreatorWelcomeMessage(
                client, 
                authorId, 
                grantResult.successfulServers, 
                totalCreators,
                '自动发放创作者'
            );

            logTime(
                `[自动发放创作者] 用户 ${authorId} 已获得创作者身份组（帖子 ${threadId}，反应数 ${maxReactions}），同步至: ${grantResult.successfulServers.join('、')}`
            );

            return { 
                granted: true, 
                syncedServers: grantResult.successfulServers,
                maxReactions,
                totalCreators
            };
        },
        `自动发放创作者身份组给用户 ${authorId}`,
        { throwOnError: false }
    )?.data || { granted: false, reason: '处理过程中出现错误' };
}

/**
 * 处理创作者身份组申请的业务逻辑
 * @param {Object} client - Discord客户端
 * @param {Object} interaction - Discord交互对象
 * @param {string} threadLink - 帖子链接
 * @returns {Promise<Object>} 处理结果
 */
export async function handleCreatorRoleApplication(client, interaction, threadLink) {
    return await ErrorHandler.handleService(
        async () => {
            const matches = threadLink.match(/channels\/(\d+)\/(?:\d+\/threads\/)?(\d+)/);
            if (!matches) {
                throw new Error('无效的帖子链接格式');
            }

            const [, linkGuildId, threadId] = matches;
            const currentGuildConfig = client.guildManager.getGuildConfig(interaction.guildId);

            // 检查链接所属服务器是否在配置中
            const linkGuildConfig = client.guildManager.getGuildConfig(linkGuildId);
            if (!linkGuildConfig) {
                throw new Error('提供的帖子不在允许的服务器中');
            }

            // 使用队列处理申请逻辑
            const result = await globalRequestQueue.add(async () => {
                const thread = await client.channels.fetch(threadId);

                if (!thread || !thread.isThread() || thread.parent?.type !== ChannelType.GuildForum) {
                    throw new Error('提供的链接不是论坛帖子');
                }

                // 获取首条消息并验证作者
                const firstMessage = await thread.messages.fetch({ limit: 1, after: '0' });
                const threadStarter = firstMessage.first();

                if (!threadStarter || threadStarter.author.id !== interaction.user.id) {
                    throw new Error('您不是该帖子的作者');
                }

                // 获取反应数最多的表情
                const maxReactions = getMaxReactionsFromMessage(threadStarter);

                // 使用EmbedFactory创建审核日志
                const auditEmbed = EmbedFactory.createCreatorRoleAuditEmbed({
                    user: interaction.user,
                    threadLink,
                    maxReactions,
                    serverName: thread.guild.name,
                    approved: maxReactions >= 5,
                    isAutoGrant: false
                });

                if (maxReactions >= 5) {
                    // 手动申请时，从放弃名单中移除用户
                    removeFromOptOutList(interaction.user.id);

                    // 获取创作者同步组配置
                    const creatorSyncGroup = getCreatorSyncGroup();

                    if (!creatorSyncGroup) {
                        throw new Error('无法找到创作者身份组同步配置');
                    }

                    // 使用manageRolesByGroups函数批量添加身份组
                    const roleResult = await manageRolesByGroups(
                        client,
                        interaction.user.id,
                        [creatorSyncGroup],
                        '创作者身份组申请通过',
                        false // 设置为添加操作
                    );

                    // 检查是否有成功的服务器
                    if (roleResult.successfulServers.length === 0) {
                        throw new Error('添加身份组时出现错误，请联系管理员');
                    }

                    const syncedServers = roleResult.successfulServers;

                    logTime(
                        `[手动申请] 用户 ${interaction.user.tag} 获得了创作者身份组, 同步至: ${syncedServers.join('、')}`
                    );

                    // 立即同步到 PostgreSQL
                    const creatorRoleId = currentGuildConfig.roleApplication?.creatorRoleId;
                    await syncUserRoleToPG(interaction.user.id, creatorRoleId);

                    // 统计创作者总数（基于PostgreSQL）
                    const totalCreators = await getCreatorCount(creatorRoleId);

                    // 发送审核日志（可容错操作）
                    await ErrorHandler.handleSilent(
                        async () => {
                            const moderationChannel = await client.channels.fetch(
                                currentGuildConfig.roleApplication.logThreadId
                            );
                            if (moderationChannel) {
                                await moderationChannel.send({ embeds: [auditEmbed] });
                            }
                        },
                        "发送审核日志"
                    );

                    // 发送私聊欢迎消息并创建成功embed
                    await sendCreatorWelcomeMessage(
                        client,
                        interaction.user.id,
                        syncedServers,
                        totalCreators,
                        '手动申请'
                    );

                    const successEmbed = EmbedFactory.createCreatorRoleSuccessEmbed(syncedServers, totalCreators);
                    return { success: true, embed: successEmbed };
                } else {
                    return { success: false, message: '审核未通过，请获取足够正面反应后再申请。' };
                }
            }, 3); // 用户指令优先级

            return result;
        },
        "处理创作者身份组申请"
    );
}

