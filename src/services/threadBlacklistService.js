import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

const blacklistPath = join(process.cwd(), 'data', 'thread_blacklist.json');

/**
 * 用户拉黑服务类
 * 负责管理用户之间的全局拉黑功能（owner拉黑target，在owner的所有帖子中生效）
 *
 * 数据结构：
 * cache.blacklists = {
 *     "ownerId": {
 *         "targetUserId": {
 *             addedAt: timestamp,
 *             addedBy: "ownerId",
 *             totalViolations: 5,
 *             threads: {
 *                 "threadId": { violationCount: 2, lastViolation: timestamp }
 *             }
 *         }
 *     }
 * }
 */
export class ThreadBlacklistService {
    /**
     * 内存缓存（owner -> target 全局拉黑）
     * @private
     */
    static cache = {
        blacklists: {}, // ownerId -> { targetUserId -> { ...拉黑记录 } }
        dirty: false, // 标记数据是否已修改
        saveTimer: null // 延迟保存定时器
    };

    /**
     * 从文件读取拉黑数据
     * @private
     * @returns {Object} 拉黑数据对象
     */
    static readBlacklistFile() {
        return ErrorHandler.handleSilentSync(
            () => JSON.parse(readFileSync(blacklistPath, 'utf8')),
            "读取帖子拉黑配置",
            { blacklists: {} }
        );
    }

    /**
     * 写入拉黑数据到文件
     * @private
     * @param {Object} data - 拉黑数据对象
     */
    static saveBlacklistFile(data) {
        return ErrorHandler.handleServiceSync(
            () => writeFileSync(blacklistPath, JSON.stringify(data, null, 4), 'utf8'),
            "保存帖子拉黑配置",
            { throwOnError: true }
        );
    }

    /**
     * 加载拉黑数据到内存
     * 在bot启动时调用
     */
    static loadBlacklistData() {
        try {
            const data = ThreadBlacklistService.readBlacklistFile();
            ThreadBlacklistService.cache.blacklists = data.blacklists || {};

            // 统计数据
            let totalOwners = 0;
            let totalBlacklists = 0;

            for (const [ownerId, targets] of Object.entries(ThreadBlacklistService.cache.blacklists)) {
                totalOwners++;
                totalBlacklists += Object.keys(targets).length;
            }

            logTime(`[用户拉黑] 已加载拉黑数据：${totalOwners} 个用户创建了 ${totalBlacklists} 条拉黑记录`);
        } catch (error) {
            logTime(`[用户拉黑] 加载拉黑数据失败: ${error.message}`, true);
            ThreadBlacklistService.cache.blacklists = {};
        }
    }

    /**
     * 保存内存数据到文件（立即）
     * @private
     */
    static saveToFile() {
        const data = {
            blacklists: ThreadBlacklistService.cache.blacklists
        };
        ThreadBlacklistService.saveBlacklistFile(data);
        ThreadBlacklistService.cache.dirty = false;
    }

    /**
     * 标记数据为脏，并延迟保存
     * @private
     * @param {number} delay - 延迟时间（毫秒），默认5秒
     */
    static scheduleSave(delay = 5000) {
        ThreadBlacklistService.cache.dirty = true;

        // 清除现有的定时器
        if (ThreadBlacklistService.cache.saveTimer) {
            clearTimeout(ThreadBlacklistService.cache.saveTimer);
        }

        // 设置新的定时器
        ThreadBlacklistService.cache.saveTimer = setTimeout(() => {
            if (ThreadBlacklistService.cache.dirty) {
                ThreadBlacklistService.saveToFile();
                logTime('[帖子拉黑] 延迟保存已执行');
            }
            ThreadBlacklistService.cache.saveTimer = null;
        }, delay);
    }

    /**
     * 强制立即保存（用于bot关闭时）
     */
    static forceSave() {
        if (ThreadBlacklistService.cache.saveTimer) {
            clearTimeout(ThreadBlacklistService.cache.saveTimer);
            ThreadBlacklistService.cache.saveTimer = null;
        }
        if (ThreadBlacklistService.cache.dirty) {
            ThreadBlacklistService.saveToFile();
            logTime('[帖子拉黑] 强制保存已执行');
        }
    }

    /**
     * 检查用户是否被帖子所有者拉黑
     * @param {string} ownerId - 帖子所有者ID
     * @param {string} targetUserId - 目标用户ID
     * @returns {Object|null} 拉黑记录，如果不存在则返回null
     */
    static isUserBlacklisted(ownerId, targetUserId) {
        const ownerBlacklist = ThreadBlacklistService.cache.blacklists[ownerId];
        if (!ownerBlacklist) return null;

        const record = ownerBlacklist[targetUserId];
        return record || null;
    }

    /**
     * 获取指定用户的所有拉黑列表
     * @param {string} ownerId - 用户ID
     * @returns {Array} 拉黑记录数组
     */
    static getUserBlacklist(ownerId) {
        const ownerBlacklist = ThreadBlacklistService.cache.blacklists[ownerId];
        if (!ownerBlacklist) return [];

        return Object.entries(ownerBlacklist).map(([targetUserId, record]) => ({
            targetUserId,
            ...record
        }));
    }

    /**
     * 获取所有有拉黑记录的用户ID集合
     * @returns {Set<string>} 用户ID集合
     */
    static getOwnersWithBlacklist() {
        return new Set(Object.keys(ThreadBlacklistService.cache.blacklists));
    }

    /**
     * 添加全局拉黑记录
     * @param {string} ownerId - 帖子所有者ID
     * @param {string} targetUserId - 目标用户ID
     * @returns {boolean} 是否成功添加（如果已存在则返回false）
     */
    static addUserToBlacklist(ownerId, targetUserId) {
        try {
            // 检查是否已存在
            if (ThreadBlacklistService.isUserBlacklisted(ownerId, targetUserId)) {
                return false;
            }

            // 初始化用户拉黑列表
            if (!ThreadBlacklistService.cache.blacklists[ownerId]) {
                ThreadBlacklistService.cache.blacklists[ownerId] = {};
            }

            // 添加拉黑记录
            ThreadBlacklistService.cache.blacklists[ownerId][targetUserId] = {
                addedAt: Date.now(),
                addedBy: ownerId,
                totalViolations: 0,
                threads: {}
            };

            // 立即保存（拉黑操作需要立即持久化）
            ThreadBlacklistService.saveToFile();

            logTime(`[用户拉黑] 用户 ${ownerId} 已全局拉黑用户 ${targetUserId}`);
            return true;
        } catch (error) {
            logTime(`[用户拉黑] 添加拉黑记录失败: ${error.message}`, true);
            return false;
        }
    }

    /**
     * 移除全局拉黑记录
     * @param {string} ownerId - 帖子所有者ID
     * @param {string} targetUserId - 目标用户ID
     * @returns {boolean} 是否成功移除
     */
    static removeUserFromBlacklist(ownerId, targetUserId) {
        try {
            const ownerBlacklist = ThreadBlacklistService.cache.blacklists[ownerId];
            if (!ownerBlacklist) return false;

            if (!ownerBlacklist[targetUserId]) return false;

            // 移除记录
            delete ownerBlacklist[targetUserId];

            // 如果该用户的拉黑列表为空，删除整个键
            if (Object.keys(ownerBlacklist).length === 0) {
                delete ThreadBlacklistService.cache.blacklists[ownerId];
            }

            // 立即保存（解除拉黑操作需要立即持久化）
            ThreadBlacklistService.saveToFile();

            logTime(`[用户拉黑] 用户 ${ownerId} 已解除对用户 ${targetUserId} 的拉黑`);
            return true;
        } catch (error) {
            logTime(`[用户拉黑] 移除拉黑记录失败: ${error.message}`, true);
            return false;
        }
    }

    /**
     * 增加用户的违规次数
     * @param {string} ownerId - 帖子所有者ID
     * @param {string} targetUserId - 目标用户ID
     * @param {string} threadId - 发生违规的帖子ID
     * @returns {Object} { total: 总违规次数, thread: 该帖子违规次数 }，失败返回null
     */
    static incrementViolationCount(ownerId, targetUserId, threadId) {
        try {
            const ownerBlacklist = ThreadBlacklistService.cache.blacklists[ownerId];
            if (!ownerBlacklist) return null;

            const record = ownerBlacklist[targetUserId];
            if (!record) return null;

            // 增加总违规次数
            record.totalViolations++;

            // 初始化或更新该帖子的违规记录
            if (!record.threads[threadId]) {
                record.threads[threadId] = {
                    violationCount: 0,
                    lastViolation: Date.now()
                };
            }

            record.threads[threadId].violationCount++;
            record.threads[threadId].lastViolation = Date.now();

            // 违规计数批量保存，提高性能
            ThreadBlacklistService.scheduleSave(5000);

            logTime(
                `[用户拉黑] 用户 ${targetUserId} 违规次数增加：` +
                `总计 ${record.totalViolations} 次，` +
                `在帖子 ${threadId} 中 ${record.threads[threadId].violationCount} 次`
            );

            return {
                total: record.totalViolations,
                thread: record.threads[threadId].violationCount
            };
        } catch (error) {
            logTime(`[用户拉黑] 增加违规次数失败: ${error.message}`, true);
            return null;
        }
    }
}

