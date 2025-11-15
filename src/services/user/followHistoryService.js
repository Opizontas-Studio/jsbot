import { pgManager } from '../../pg/pgManager.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { logTime } from '../../utils/logger.js';
import { Op } from 'sequelize';
import { FollowHistoryComponentV2 } from '../../components/followHistoryComponentV2.js';
import { ComponentV2Factory } from '../../factories/componentV2Factory.js';

/**
 * 用户关注历史服务
 * 负责查询和管理用户的帖子关注历史
 * 以及处理相关的按钮交互业务逻辑
 */
class FollowHistoryService {
    /**
     * 构造函数
     * @param {Object} config - 配置对象
     * @param {number} config.pageSize - 每页显示的记录数
     */
    constructor(config = {}) {
        this.config = {
            pageSize: config.pageSize || 10
        };
    }

    /**
     * 获取用户的关注历史记录
     * @param {string} userId - 用户ID
     * @param {boolean} showLeft - 是否显示已离开的（曾经关注）
     * @returns {Promise<Array>} 关注记录列表
     */
    async getUserFollowHistory(userId, showLeft = false) {
        return await ErrorHandler.handleService(
            async () => {
                if (!pgManager.getConnectionStatus()) {
                    throw new Error('数据库未连接');
                }

                const models = pgManager.getModels();
                
                // 构建查询条件
                const whereClause = {
                    user_id: userId,
                    // showLeft = false: 正在关注（is_leave = false）
                    // showLeft = true: 曾经关注（is_leave = true）
                    is_leave: showLeft ? true : false
                };

                // 查询用户的关注记录，并联表获取帖子信息
                const records = await models.PostMembers.findAll({
                    where: whereClause,
                    include: [{
                        model: models.PostsMain,
                        as: 'post',
                        required: true,
                        attributes: [
                            'thread_id',
                            'title',
                            'author_id',
                            'jump_url',
                            'created_at',
                            'is_valid',
                            'is_deleted'
                        ]
                    }],
                    order: [
                        ['last_join_at', 'DESC'], // 按最后加入时间倒序排列
                    ],
                    raw: false // 需要包含关联数据，不能用raw模式
                });

                // 格式化返回数据
                const formattedRecords = records.map(record => {
                    const recordData = record.get({ plain: true });
                    const postData = recordData.post || {};
                    
                    return {
                        // PostMembers 表字段
                        user_id: recordData.user_id,
                        thread_id: recordData.thread_id,
                        is_thread_owner: recordData.is_thread_owner,
                        first_join_at: recordData.first_join_at,
                        last_join_at: recordData.last_join_at,
                        last_leave_at: recordData.last_leave_at,
                        is_leave: recordData.is_leave,
                        message_count: recordData.message_count || 0,
                        
                        // PostsMain 表字段
                        post_title: postData.title || '未知标题',
                        post_author_id: postData.author_id,
                        jump_url: postData.jump_url || '#',
                        post_created_at: postData.created_at,
                        post_is_valid: postData.is_valid,
                        post_is_deleted: postData.is_deleted
                    };
                });

                logTime(`[关注历史查询] 用户 ${userId} 查询${showLeft ? '曾经' : '正在'}关注，返回 ${formattedRecords.length} 条记录`);
                
                return formattedRecords;
            },
            '查询用户关注历史',
            { throwOnError: true }
        );
    }

    /**
     * 获取用户关注统计
     * @param {string} userId - 用户ID
     * @returns {Promise<Object>} 统计信息
     */
    async getUserFollowStats(userId) {
        return await ErrorHandler.handleService(
            async () => {
                if (!pgManager.getConnectionStatus()) {
                    throw new Error('数据库未连接');
                }

                const models = pgManager.getModels();
                
                // 查询总数
                const totalCount = await models.PostMembers.count({
                    where: { user_id: userId }
                });

                // 查询正在关注的数量
                const activeCount = await models.PostMembers.count({
                    where: {
                        user_id: userId,
                        is_leave: false
                    }
                });

                // 查询已离开的数量
                const leftCount = totalCount - activeCount;

                // 查询有消息的帖子数量
                const messageThreadCount = await models.PostMembers.count({
                    where: {
                        user_id: userId,
                        message_count: {
                            [Op.gt]: 0
                        }
                    }
                });

                return {
                    totalCount,      // 总关注数
                    activeCount,     // 正在关注
                    leftCount,       // 已离开
                    messageThreadCount  // 有消息的帖子数
                };
            },
            '查询用户关注统计',
            { throwOnError: true }
        );
    }

    /**
     * 检查用户是否关注某个帖子
     * @param {string} userId - 用户ID
     * @param {string} threadId - 帖子ID
     * @returns {Promise<Object|null>} 关注记录或null
     */
    async checkUserFollowThread(userId, threadId) {
        return await ErrorHandler.handleService(
            async () => {
                if (!pgManager.getConnectionStatus()) {
                    return null;
                }

                const models = pgManager.getModels();
                
                const record = await models.PostMembers.findOne({
                    where: {
                        user_id: userId,
                        thread_id: threadId
                    },
                    raw: true
                });

                return record;
            },
            '检查用户关注状态',
            { throwOnError: false }
        );
    }

    /**
     * 构建并缓存关注历史消息
     * @param {Object} params - 参数对象
     * @param {string} params.userId - 用户ID
     * @param {Object} params.user - 用户对象
     * @param {boolean} params.showLeft - 是否显示已离开的（曾经关注）
     * @param {number} params.page - 页码
     * @param {Object} params.client - Discord客户端
     * @param {number} params.pageSize - 每页显示数量（可选，默认使用配置值）
     * @returns {Promise<Object>} 消息数据
     */
    async buildFollowHistoryMessage({ userId, user, showLeft, page = 1, client, pageSize }) {
        return await ErrorHandler.handleService(
            async () => {
                // 查询数据（已格式化）
                const formattedRecords = await this.getUserFollowHistory(userId, showLeft);

                if (!formattedRecords || formattedRecords.length === 0) {
                    return {
                        isEmpty: true,
                        message: showLeft 
                            ? '你没有曾经关注过的帖子' 
                            : '你当前没有正在关注的帖子'
                    };
                }

                // 分页处理 - 使用传入的pageSize或配置的默认值
                const effectivePageSize = pageSize || this.config.pageSize;
                const paginationData = FollowHistoryComponentV2.paginate(formattedRecords, page, effectivePageSize);

                // 构建消息
                const messageData = FollowHistoryComponentV2.buildMessage({
                    records: paginationData.records,
                    user: user,
                    currentPage: paginationData.currentPage,
                    totalPages: paginationData.totalPages,
                    totalRecords: paginationData.totalRecords,
                    showLeft: showLeft,
                    userId: userId
                });

                // 更新缓存
                const cacheKey = `${userId}_${showLeft ? 'all' : 'active'}`;
                if (!client.followHistoryCache) {
                    client.followHistoryCache = new Map();
                }
                client.followHistoryCache.set(cacheKey, {
                    records: formattedRecords,
                    user: user,
                    showLeft: showLeft,
                    pageSize: effectivePageSize,
                    timestamp: Date.now()
                });

                // 设置15分钟后清除缓存
                setTimeout(() => {
                    if (client.followHistoryCache) {
                        client.followHistoryCache.delete(cacheKey);
                    }
                }, 15 * 60 * 1000);

                // 返回消息载荷
                return {
                    isEmpty: false,
                    payload: {
                        components: [...messageData.components, ...messageData.actionRows],
                        flags: messageData.flags
                    },
                    recordCount: formattedRecords.length
                };
            },
            '构建关注历史消息',
            { throwOnError: true }
        );
    }

    /**
     * 处理分页按钮交互
     * @param {ButtonInteraction} interaction - 按钮交互对象
     * @param {string} direction - 方向: 'prev' | 'next'
     */
    async handlePaginationButton(interaction, direction) {
        return await ErrorHandler.handleService(
            async () => {
                // 从customId中提取信息: follow_history_page_{userId}_{type}_prev/next
                const parts = interaction.customId.split('_');
                const userId = parts[3];
                const showLeft = parts[4] === 'all';
                
                // 检查权限
                if (interaction.user.id !== userId) {
                    throw new Error('这不是你的查询结果');
                }

                // 获取当前页码
                const currentPage = this._extractCurrentPage(interaction);
                
                // 从缓存获取数据
                const cacheKey = `${userId}_${showLeft ? 'all' : 'active'}`;
                const cachedData = interaction.client.followHistoryCache?.get(cacheKey);

                if (!cachedData) {
                    throw new Error('页面数据已过期，请重新执行查询命令');
                }

                // 计算新页码
                const newPage = direction === 'prev' ? currentPage - 1 : currentPage + 1;
                
                // 分页处理
                const paginationData = FollowHistoryComponentV2.paginate(
                    cachedData.records,
                    newPage,
                    cachedData.pageSize
                );

                // 构建新消息
                const messageData = FollowHistoryComponentV2.buildMessage({
                    records: paginationData.records,
                    user: cachedData.user,
                    currentPage: paginationData.currentPage,
                    totalPages: paginationData.totalPages,
                    totalRecords: paginationData.totalRecords,
                    showLeft: cachedData.showLeft,
                    userId: userId
                });

                // 添加ActionRows到消息
                // 更新消息时不包含flags字段，IS_COMPONENTS_V2标志一旦设置就无法移除
                const updatePayload = {
                    components: [...messageData.components, ...messageData.actionRows]
                };

                await interaction.update(updatePayload);
            },
            '处理历史关注翻页',
            { throwOnError: true }
        );
    }

    /**
     * 处理筛选切换按钮
     * @param {ButtonInteraction} interaction - 按钮交互对象
     * @param {boolean} targetShowLeft - 目标显示模式（是否显示已离开的）
     */
    async handleFilterSwitch(interaction, targetShowLeft) {
        return await ErrorHandler.handleService(
            async () => {
                // 从customId中提取用户ID: follow_history_switch_{type}_{userId}
                const parts = interaction.customId.split('_');
                const userId = parts[4];
                
                // 检查权限
                if (interaction.user.id !== userId) {
                    throw new Error('这不是你的查询结果');
                }

                // 构建消息（复用通用逻辑，从第1页开始）
                const result = await this.buildFollowHistoryMessage({
                    userId,
                    user: interaction.user,
                    showLeft: targetShowLeft,
                    page: 1,
                    client: interaction.client
                });

                if (result.isEmpty) {
                    // 使用Component V2显示空状态消息
                    await interaction.update({
                        components: ComponentV2Factory.buildEmptyStateMessage(`✅ ${result.message}`)
                        // 不包含flags字段和content字段，因为消息已经有IS_COMPONENTS_V2标志
                    });
                    return;
                }

                // 更新消息时移除flags字段，因为IS_COMPONENTS_V2标志一旦设置就无法移除
                const { flags, ...updatePayload } = result.payload;
                await interaction.update(updatePayload);
            },
            '处理关注历史筛选切换',
            { throwOnError: true }
        );
    }

    /**
     * 从交互消息中提取当前页码
     * @private
     */
    _extractCurrentPage(interaction) {
        try {
            // 
            // Component V2需要从components中提取，查找分页信息按钮的label（它的customId包含 _info）
            for (const actionRow of interaction.message.components) {
                for (const component of actionRow.components) {
                    // 寻找禁用的页码信息按钮（customId 以 _info 结尾）
                    if (component.customId && component.customId.includes('_info') && 
                        component.label && component.label.includes('/')) {
                        const match = component.label.match(/(\d+)\s*\/\s*(\d+)/);
                        if (match) {
                            const currentPage = parseInt(match[1]);
                            // logTime(`[关注历史] 提取到当前页码: ${currentPage}`);
                            return currentPage;
                        }
                    }
                }
            }
            
            // logTime(`[关注历史] 未找到页码信息，使用默认值 1`, true);
            return 1; // 默认第1页
        } catch (error) {
            logTime(`[关注历史] 提取页码失败: ${error.message}`, true);
            return 1;
        }
    }
}

// 导出单例
export const followHistoryService = new FollowHistoryService();
export default followHistoryService;

