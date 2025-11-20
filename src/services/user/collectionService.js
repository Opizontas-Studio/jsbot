import { pgManager } from '../../pg/pgManager.js';
import { ErrorHandler } from '../../utils/errorHandler.js';
import { CollectionComponent } from '../../components/collectionComponent.js';
import { ComponentV2Factory } from '../../factories/componentV2Factory.js';
import { logTime } from '../../utils/logger.js';
import { Op } from 'sequelize';

class CollectionService {
    constructor() {
        this.cache = new Map(); // authorId, value: { records: [], timestamp: number }
        this.CACHE_TIMEOUT = 60 * 60 * 1000; // 1小时
    }

    async buildCollectionMessage({ authorId, authorUser, page = 1, client, currentGroup }) {
        return await ErrorHandler.handleService(
            async () => {
                // 从缓存中获取数据
                let records = this._getFromCache(authorId);

                if (!records) {
                    // 查询数据库
                    if (!pgManager.getConnectionStatus()) {
                        throw new Error('数据库未连接');
                    }

                    const models = pgManager.getModels();
                    
                    // 构建查询条件
                    const whereClause = {
                        is_deleted: false,
                        is_valid: true,
                        is_locked: false
                    };

                    // 检查是否是搜索模式
                    const isSearchMode = authorId.toString().startsWith('search:');
                    if (isSearchMode) {
                        const searchTerm = authorId.toString().replace('search:', '');
                        whereClause.title = {
                            [Op.iLike]: `%${searchTerm}%`
                        };
                    } else {
                        whereClause.author_id = authorId;
                    }

                    const dbRecords = await models.PostsMain.findAll({
                        where: whereClause,
                        order: [['created_at', 'DESC']],
                        attributes: ['thread_id', 'title', 'created_at', 'jump_url'],
                        raw: true
                    });

                    const logPrefix = isSearchMode ? `搜索: ${authorId}` : `作者: ${authorId}`;
                    logTime(`[CollectionService] 查询结果: ${logPrefix} 有 ${dbRecords.length} 条记录`);

                    records = dbRecords;
                    this._setCache(authorId, records);
                }

                if (!records || records.length === 0) {
                    return {
                        isEmpty: true,
                        message: '该作者没有发布过符合条件的帖子'
                    };
                }

                // 分页处理
                const pageSize = 10;
                const paginationData = CollectionComponent.paginate(records, page, pageSize);

                // 构建消息
                const messageData = CollectionComponent.buildMessage({
                    records: paginationData.records,
                    author: authorUser,
                    currentPage: paginationData.currentPage,
                    totalPages: paginationData.totalPages,
                    totalRecords: paginationData.totalRecords,
                    authorId: authorId,
                    currentGroup,
                    pageSize
                });

                return {
                    isEmpty: false,
                    payload: {
                        components: messageData.components,
                        flags: messageData.flags
                    },
                    recordCount: records.length
                };
            },
            '构建作品合集消息',
            { throwOnError: true }
        );
    }

    async handlePaginationSelectMenu(interaction) {
        return await ErrorHandler.handleService(async () => {
            // collection_page_{authorId}_select
            const parts = interaction.customId.split('_');
            const authorId = parts[2];
            
            const targetPage = parseInt(interaction.values[0]);

            // 从缓存中获取数据
            const records = this._getFromCache(authorId);
            if (!records) {
                 throw new Error('页面数据已过期，请重新执行查询命令');
            }

             // 分页处理
            const pageSize = 10;
            const paginationData = CollectionComponent.paginate(records, targetPage, pageSize);
            
            // 获取作者用户对象
            let authorUser;
            if (authorId.startsWith('search:')) {
                const searchTerm = authorId.replace('search:', '');
                authorUser = { username: searchTerm };
            } else {
                try {
                    authorUser = await interaction.client.users.fetch(authorId);
                } catch (e) {
                    authorUser = { username: '未知用户' };
                }
            }

            // 计算分组
            const MAX_OPTIONS = 25;
            const targetGroup = Math.floor((targetPage - 1) / MAX_OPTIONS);

            const messageData = CollectionComponent.buildMessage({
                records: paginationData.records,
                author: authorUser,
                currentPage: paginationData.currentPage,
                totalPages: paginationData.totalPages,
                totalRecords: paginationData.totalRecords,
                authorId: authorId,
                currentGroup: targetGroup,
                pageSize
            });

            // 更新消息时不包含flags字段，IS_COMPONENTS_V2标志一旦设置就无法移除
            await interaction.update({
                components: messageData.components
            });
        },
        '处理合集分页',
        { throwOnError: true });
    }

    async handleGroupNavigation(interaction) {
         return await ErrorHandler.handleService(async () => {
            // collection_page_{authorId}_group_{currentGroup}_next
            const parts = interaction.customId.split('_');
            const authorId = parts[2];
            const currentGroup = parseInt(parts[4]);

             // 从缓存中获取数据
            const records = this._getFromCache(authorId);
            if (!records) {
                 throw new Error('页面数据已过期，请重新执行查询命令');
            }

            const pageSize = 10;
            const totalPages = Math.ceil(records.length / pageSize);
            const MAX_OPTIONS = 25;
            const totalGroups = Math.ceil(totalPages / MAX_OPTIONS);
            
            // 计算下一组
            const nextGroup = (currentGroup + 1) % totalGroups;
            const startPage = nextGroup * MAX_OPTIONS + 1;

             // 获取作者用户对象
            let authorUser;
            if (authorId.startsWith('search:')) {
                const searchTerm = authorId.replace('search:', '');
                authorUser = { username: searchTerm };
            } else {
                try {
                    authorUser = await interaction.client.users.fetch(authorId);
                } catch (e) {
                    authorUser = { username: '未知用户' };
                }
            }

            // 显示下一组的第一页
             const paginationData = CollectionComponent.paginate(records, startPage, pageSize);

             const messageData = CollectionComponent.buildMessage({
                records: paginationData.records,
                author: authorUser,
                currentPage: paginationData.currentPage,
                totalPages: paginationData.totalPages,
                totalRecords: paginationData.totalRecords,
                authorId: authorId,
                currentGroup: nextGroup,
                pageSize
            });

            // 更新消息时不包含flags字段
            await interaction.update({
                components: messageData.components
            });
         },
         '处理合集分组导航',
         { throwOnError: true });
    }

    _getFromCache(authorId) {
        const data = this.cache.get(authorId);
        if (!data) return null;
        if (Date.now() - data.timestamp > this.CACHE_TIMEOUT) {
            // 清除过期数据和定时器
            if (data.timeoutId) {
                clearTimeout(data.timeoutId);
            }
            this.cache.delete(authorId);
            return null;
        }
        return data.records;
    }

    _setCache(authorId, records) {
        // 检查并清除旧的定时器
        const existingData = this.cache.get(authorId);
        if (existingData?.timeoutId) {
            clearTimeout(existingData.timeoutId);
        }

        // 设置新的定时器，1小时后自动清理
        const timeoutId = setTimeout(() => {
            const currentData = this.cache.get(authorId);
            if (currentData && currentData.timeoutId === timeoutId) {
                this.cache.delete(authorId);
            }
        }, this.CACHE_TIMEOUT);

        this.cache.set(authorId, {
            records,
            timestamp: Date.now(),
            timeoutId
        });
    }
}

export const collectionService = new CollectionService();
