import { MessageFlags } from 'discord.js';
import { ComponentV2Factory } from '../factories/componentV2Factory.js';

/**
 * 历史关注组件 - Component V2版本
 * 使用Discord的Component V2 API构建消息
 */
export class FollowHistoryComponentV2 {
    /**
     * 构建历史关注消息（Component V2格式）
     * @param {Object} params - 参数对象
     * @param {Array} params.records - 当前页的关注记录列表
     * @param {Object} params.user - 用户对象
     * @param {number} params.currentPage - 当前页码
     * @param {number} params.totalPages - 总页数
     * @param {number} params.totalRecords - 总记录数
     * @param {boolean} params.showAll - 是否显示全部（包括已离开）
     * @param {string} params.userId - 用户ID
     * @returns {Object} Discord消息对象
     */
    static buildMessage({
        records,
        user,
        currentPage,
        totalPages,
        totalRecords,
        showAll,
        userId
    }) {
        const container = ComponentV2Factory.createContainer(
            showAll ? ComponentV2Factory.Colors.PURPLE : ComponentV2Factory.Colors.DISCORD_BLUE
        );

        // 标题和统计信息（合并到一起）
        const emoji = showAll ? '📋' : '✅';
        const typeText = showAll ? '全部' : '正在';
        ComponentV2Factory.addHeading(container, `${emoji} ${user.username} 的${typeText}关注`, 1);
        
        ComponentV2Factory.addText(
            container,
            `共 **${totalRecords}** 个帖子 | 第 **${currentPage}/${totalPages}** 页`
        );

        // 如果没有记录
        if (records.length === 0) {
            const message = showAll 
                ? '你还没有关注过任何帖子' 
                : '你当前没有正在关注的帖子';
            ComponentV2Factory.addText(container, `\n${message}\n`);
        } else {
            // 显示记录列表（不使用分隔符）
            this._buildRecordsList(container, records, currentPage, showAll, 20);
        }

        // 添加操作按钮
        const components = [container];
        const actionRows = this._buildActionRows(userId, showAll, currentPage, totalPages);
        
        return {
            components: [...components],
            actionRows: actionRows, // 返回ActionRow用于添加到消息
            flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
        };
    }

    /**
     * 构建记录列表
     * @private
     */
    static _buildRecordsList(container, records, currentPage, showAll, pageSize = 20) {
        records.forEach((record, index) => {
            const num = (currentPage - 1) * pageSize + index + 1;
            const statusEmoji = record.is_leave ? ComponentV2Factory.Emojis.LEAVE : ComponentV2Factory.Emojis.SUCCESS;
            
            // 格式化时间
            const joinTime = this._formatTime(record.last_join_at);
            
            // 构建内容（精简版，移除消息数）
            let content = `**${num}.** ${statusEmoji} **${record.post_title}**\n`;
            content += `作者: <@${record.post_author_id}> | 关注: ${joinTime}`;
            
            // 只在全部关注模式下显示离开时间
            if (showAll && record.is_leave && record.last_leave_at) {
                const leaveTime = this._formatTime(record.last_leave_at);
                content += ` | 离开: ${leaveTime}`;
            }

            // 创建跳转按钮
            const jumpButton = ComponentV2Factory.createButton({
                customId: `jump_${record.thread_id}`,
                label: '跳转',
                style: 'link',
                url: record.jump_url,
                emoji: '🔗'
            });

            // 添加Section（不添加分隔符）
            ComponentV2Factory.addSection(container, content, {
                type: 'button',
                button: jumpButton
            });
        });
    }

    /**
     * 构建操作按钮行
     * @private
     */
    static _buildActionRows(userId, showAll, currentPage, totalPages) {
        const rows = [];

        // 分页按钮行（如果有多页）
        if (totalPages > 1) {
            rows.push(ComponentV2Factory.createPaginationRow({
                baseId: `follow_history_page_${userId}_${showAll ? 'all' : 'active'}`,
                currentPage,
                totalPages
            }));
        }

        // 筛选按钮行
        const filterButtons = [
            ComponentV2Factory.createButton({
                customId: `follow_history_switch_active_${userId}`,
                label: '正在关注',
                style: showAll ? 'secondary' : 'success',
                emoji: '✅'
            }),
            ComponentV2Factory.createButton({
                customId: `follow_history_switch_all_${userId}`,
                label: '全部关注',
                style: showAll ? 'success' : 'secondary',
                emoji: '📋'
            })
        ];
        rows.push(ComponentV2Factory.createButtonRow(filterButtons));

        return rows;
    }

    /**
     * 格式化时间
     * @private
     */
    static _formatTime(dateString) {
        return new Date(dateString).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    /**
     * 格式化数据库记录
     * @param {Array} dbRecords - 数据库查询结果
     * @returns {Array} 格式化后的记录列表
     */
    static formatRecords(dbRecords) {
        return dbRecords.map(record => ({
            thread_id: record.thread_id,
            user_id: record.user_id,
            is_leave: record.is_leave,
            last_join_at: record.last_join_at,
            last_leave_at: record.last_leave_at,
            message_count: record.message_count || 0,
            post_title: record.post_title || '未知标题',
            post_author_id: record.post_author_id,
            jump_url: record.jump_url || '#'
        }));
    }

    /**
     * 分页处理
     * @param {Array} records - 所有记录
     * @param {number} page - 当前页码（从1开始）
     * @param {number} pageSize - 每页数量
     * @returns {Object} 分页后的数据
     */
    static paginate(records, page = 1, pageSize = 10) {
        const totalPages = Math.max(1, Math.ceil(records.length / pageSize));
        const currentPage = Math.max(1, Math.min(page, totalPages));
        const startIndex = (currentPage - 1) * pageSize;
        const endIndex = startIndex + pageSize;
        
        return {
            records: records.slice(startIndex, endIndex),
            currentPage,
            totalPages,
            totalRecords: records.length,
            pageSize
        };
    }
}

