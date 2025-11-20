import { MessageFlags } from 'discord.js';
import { ComponentV2Factory } from '../factories/componentV2Factory.js';

/**
 * 合集组件 - Component V2版本
 * 用于展示作者的作品合集
 * 复用FollowHistoryComponentV2的结构
 */
export class CollectionComponent {
    /**
     * 构建合集消息（Component V2格式）
     * @param {Object} params - 参数对象
     * @param {Array} params.records - 当前页的记录列表
     * @param {Object} params.author - 作者对象（User类型）
     * @param {number} params.currentPage - 当前页码
     * @param {number} params.totalPages - 总页数
     * @param {number} params.totalRecords - 总记录数
     * @param {string} params.authorId - 作者ID
     * @param {number} [params.currentGroup] - 当前分组（可选，用于超过25页的情况）
     * @param {number} [params.pageSize] - 每页数量（用于正确计算序号）
     * @returns {Object} Discord消息对象
     */
    static buildMessage({
        records,
        author,
        currentPage,
        totalPages,
        totalRecords,
        authorId,
        currentGroup,
        pageSize
    }) {
        const container = ComponentV2Factory.createContainer(ComponentV2Factory.Colors.DISCORD_BLUE);

        // 标题
        const emoji = '📚';
        ComponentV2Factory.addHeading(container, `${emoji} ${author.username} 的作品合集`, 2);

        // 如果没有记录
        if (records.length === 0) {
            ComponentV2Factory.addText(container, '\n该作者没有发布过符合条件的帖子\n');
        } else {
            // 显示记录列表
            const actualPageSize = pageSize || Math.ceil(totalRecords / totalPages);
            this._buildRecordsList(container, records, currentPage, actualPageSize);
        }

        // 添加分页选择菜单（如果有多页）
        if (totalPages > 1) {
            ComponentV2Factory.addPaginationSelectMenu(container, {
                baseId: `collection_page_${authorId}`, // 区分于follow_history
                currentPage,
                totalPages,
                totalRecords,
                currentGroup
            });
        }

        return {
            components: [container],
            flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral]
        };
    }

    /**
     * 构建记录列表
     * @private
     */
    static _buildRecordsList(container, records, currentPage, pageSize = 10) {
        records.forEach((record, index) => {
            const num = (currentPage - 1) * pageSize + index + 1;
            
            // 格式化时间
            const createTime = this._formatTime(record.created_at);
            
            // 构建内容
            let content = `**${num}.** **${record.title}**\n`;
            content += `发布于: ${createTime}`;
            
            // 创建跳转按钮
            const jumpButton = ComponentV2Factory.createButton({
                customId: `jump_${record.thread_id}`,
                label: '跳转',
                style: 'link',
                url: record.jump_url,
                emoji: '🔗'
            });

            // 添加Section
            ComponentV2Factory.addSection(container, content, {
                type: 'button',
                button: jumpButton
            });
        });
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

