import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'path';
import { PunishmentModel } from '../sqlite/models/punishmentModel.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

const blacklistPath = join(process.cwd(), 'data', 'blacklist.json');

/**
 * 黑名单服务类
 * 负责管理用户黑名单的读取、写入和操作
 */
export class BlacklistService {
    /**
     * 读取黑名单配置
     * @returns {Object} 黑名单配置对象
     */
    static getBlacklist() {
        return ErrorHandler.handleSilentSync(
            () => JSON.parse(readFileSync(blacklistPath, 'utf8')),
            "读取黑名单配置",
            {
                users: [],
                lastUpdated: null,
                manuallyAdded: [],
                protectedUsers: []
            }
        );
    }

    /**
     * 写入黑名单配置
     * @param {Object} blacklist - 黑名单对象
     */
    static saveBlacklist(blacklist) {
        return ErrorHandler.handleServiceSync(
            () => writeFileSync(blacklistPath, JSON.stringify(blacklist, null, 4), 'utf8'),
            "保存黑名单配置",
            { throwOnError: true }
        );
    }

    /**
     * 检查用户是否在黑名单中
     * @param {string} userId - 用户ID
     * @returns {boolean} 是否在黑名单中
     */
    static isUserBlacklisted(userId) {
        return ErrorHandler.handleSilentSync(
            () => {
                const blacklist = BlacklistService.getBlacklist();

                // 受保护用户永远不在黑名单中
                if ((blacklist.protectedUsers || []).includes(userId)) {
                    return false;
                }

                return blacklist.users.includes(userId) || (blacklist.manuallyAdded || []).includes(userId);
            },
            "检查用户黑名单状态",
            false // 默认返回不在黑名单中
        );
    }

    /**
     * 更新黑名单（扫描处罚表）
     * @param {Object} client - Discord客户端（用于获取黑名单角色用户）
     * @returns {Promise<{success: boolean, addedCount: number, totalCount: number}>}
     */
    static async updateBlacklistFromPunishments(client = null) {
        try {
            // 获取现有黑名单
            const blacklist = BlacklistService.getBlacklist();

            // 确保所有字段存在
            if (!blacklist.users) blacklist.users = [];
            if (!blacklist.manuallyAdded) blacklist.manuallyAdded = [];
            if (!blacklist.protectedUsers) blacklist.protectedUsers = [];

            // 获取所有处罚记录（包括已过期的）
            const allPunishments = await PunishmentModel.getAllPunishments(true);

            // 提取用户ID列表并去重
            const punishedUserIds = [...new Set(allPunishments.map(punishment => punishment.userId))];

            // 添加黑名单角色用户
            let roleBlacklistUsers = [];
            if (client) {
                try {
                    // 遍历所有配置的服务器，查找有黑名单角色的用户
                    for (const [guildId, guildConfig] of client.guildManager.guilds.entries()) {
                        if (guildConfig.blacklistRoleId) {
                            try {
                                const guild = await client.guilds.fetch(guildId);
                                const role = await guild.roles.fetch(guildConfig.blacklistRoleId);
                                if (role) {
                                    const membersWithRole = role.members.map(member => member.user.id);
                                    roleBlacklistUsers.push(...membersWithRole);
                                    logTime(`[黑名单] 从服务器 ${guild.name} 的角色 ${role.name} 获取了 ${membersWithRole.length} 个用户`);
                                }
                            } catch (error) {
                                logTime(`[黑名单] 获取服务器 ${guildId} 的黑名单角色失败: ${error.message}`, true);
                            }
                        }
                    }
                    roleBlacklistUsers = [...new Set(roleBlacklistUsers)]; // 去重
                } catch (error) {
                    logTime(`[黑名单] 获取角色黑名单用户失败: ${error.message}`, true);
                }
            }

            // 合并所有黑名单来源并去重
            const allBlacklistCandidates = [...new Set([...punishedUserIds, ...roleBlacklistUsers])];

            // 合并到现有黑名单，去重
            const originalAutoList = blacklist.users || [];
            const newAutoList = [...new Set([...originalAutoList, ...allBlacklistCandidates])];

            // 计算新增用户数量
            const addedCount = newAutoList.length - originalAutoList.length;

            // 更新黑名单
            blacklist.users = newAutoList;
            blacklist.lastUpdated = new Date().toISOString();

            // 保存黑名单
            BlacklistService.saveBlacklist(blacklist);

            logTime(`[黑名单] 黑名单更新完成，新增 ${addedCount} 个用户，总计 ${newAutoList.length + (blacklist.manuallyAdded?.length || 0)} 个用户`);

            return {
                success: true,
                addedCount,
                totalCount: newAutoList.length + (blacklist.manuallyAdded?.length || 0)
            };
        } catch (error) {
            logTime(`[黑名单] 更新黑名单失败: ${error.message}`, true);
            return {
                success: false,
                addedCount: 0,
                totalCount: 0
            };
        }
    }

    /**
     * 添加用户到黑名单（用于处罚时立即添加）
     * @param {string} userId - 用户ID
     * @returns {Promise<boolean>} 是否成功添加
     */
    static async addUserToBlacklistImmediately(userId) {
        const result = await ErrorHandler.handleService(
            async () => {
                const blacklist = BlacklistService.getBlacklist();

                // 确保所有字段存在
                if (!blacklist.users) blacklist.users = [];
                if (!blacklist.manuallyAdded) blacklist.manuallyAdded = [];
                if (!blacklist.protectedUsers) blacklist.protectedUsers = [];

                // 检查是否为受保护用户
                if (blacklist.protectedUsers.includes(userId)) {
                    logTime(`[黑名单] 用户 ${userId} 为受保护用户，不会被添加到黑名单`);
                    return false;
                }

                // 检查是否已在黑名单中
                if (blacklist.users.includes(userId) || blacklist.manuallyAdded.includes(userId)) {
                    return true; // 已经在黑名单中，返回成功
                }

                // 添加到自动黑名单
                blacklist.users.push(userId);

                // 保存黑名单
                BlacklistService.saveBlacklist(blacklist);

                logTime(`[黑名单] 已将用户 ${userId} 立即添加到黑名单`);
                return true;
            },
            "立即添加用户到黑名单"
        );

        return result.success ? result.data : false;
    }
}
