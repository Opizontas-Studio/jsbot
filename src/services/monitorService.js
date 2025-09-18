import { exec } from 'child_process';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { EmbedFactory } from '../factories/embedFactory.js';
import { globalRequestQueue } from '../utils/concurrency.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { logTime } from '../utils/logger.js';

const execAsync = promisify(exec);

const MESSAGE_IDS_PATH = join(process.cwd(), 'data', 'messageIds.json');

// 获取WebSocket状态描述
const getConnectionStatus = client => {
    const monitor = client.wsStateMonitor;
    if (!monitor) return '🔄 状态未知';

    if (monitor.disconnectedAt) {
        const downtime = Math.floor((Date.now() - monitor.disconnectedAt) / 1000);
        return `❌ 已断开 ${downtime}秒`;
    }

    if (monitor.reconnectAttempts > 0) {
        return `🔄 重连中 (${monitor.reconnectAttempts}次)`;
    }

    return '✅ 已连接';
};

// 格式化运行时间
const formatUptime = uptime => {
    const days = Math.floor(uptime / (24 * 60 * 60));
    const hours = Math.floor((uptime % (24 * 60 * 60)) / (60 * 60));
    const minutes = Math.floor((uptime % (60 * 60)) / 60);
    const seconds = Math.floor(uptime % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);

    return parts.join(' ');
};

class MonitorService {
    constructor() {
        // 记录启动时间
        this.startTime = Date.now();
    }

    /**
     * 获取系统运行时间
     * @returns {string} 格式化的运行时间
     */
    getSystemUptime() {
        const uptime = Math.floor((Date.now() - this.startTime) / 1000);
        return formatUptime(uptime);
    }

    /**
     * 创建状态监控嵌入消息
     * @param {Client} client Discord客户端
     * @returns {Promise<EmbedBuilder>} 嵌入消息构建器
     */
    async createStatusEmbed(client) {
        const ping = Math.round(client.ws.ping);
        const connectionStatus = getConnectionStatus(client);
        const uptime = this.getSystemUptime();

        // 获取队列统计信息
        const queueLength = globalRequestQueue.queue.length;
        const currentProcessing = globalRequestQueue.currentProcessing;
        const { processed, failed } = globalRequestQueue.stats;

        const statusData = {
            ping,
            connectionStatus,
            uptime,
            queueStats: {
                queueLength,
                currentProcessing,
                processed,
                failed
            }
        };

        return EmbedFactory.createSystemStatusEmbed(statusData);
    }

    /**
     * 加载消息ID配置
     * @returns {Object} 消息ID配置对象
     */
    async loadMessageIds() {
        return await ErrorHandler.handleSilent(
            async () => {
                const data = await readFile(MESSAGE_IDS_PATH, 'utf8');
                return JSON.parse(data);
            },
            "加载消息ID配置",
            {}
        );
    }

    /**
     * 保存消息ID配置
     * @param {Object} messageIds - 消息ID配置对象
     */
    async saveMessageIds(messageIds) {
        await ErrorHandler.handleService(
            async () => {
                await writeFile(MESSAGE_IDS_PATH, JSON.stringify(messageIds, null, 4), 'utf8');
            },
            "保存消息ID配置",
            { throwOnError: true }
        );
    }

    /**
     * 获取监控配置的channelId和messageId
     * @param {string} guildId 服务器ID
     * @returns {Promise<{channelId: string|null, messageId: string|null}>}
     */
    async getMonitorIds(guildId) {
        return await ErrorHandler.handleSilent(
            async () => {
                const messageIds = await this.loadMessageIds();

                // 从messageIds.json获取数据
                const monitorData = messageIds[guildId]?.monitor;
                if (!monitorData) {
                    return { channelId: null, messageId: null };
                }

                // messageIds.json中的结构是 { channelId: messageId }
                const channelId = Object.keys(monitorData)[0];
                const messageId = channelId ? monitorData[channelId] : null;

                return { channelId, messageId };
            },
            "获取监控ID",
            { channelId: null, messageId: null }
        );
    }

    /**
     * 更新messageIds.json中的监控消息ID
     * @param {string} guildId 服务器ID
     * @param {string} channelId 频道ID
     * @param {string} messageId 消息ID
     * @returns {Promise<boolean>} 更新是否成功
     */
    async updateMonitorMessageId(guildId, channelId, messageId) {
        const result = await ErrorHandler.handleService(
            async () => {
                const messageIds = await this.loadMessageIds();

                // 确保服务器结构存在
                if (!messageIds[guildId]) {
                    messageIds[guildId] = {};
                }
                if (!messageIds[guildId].monitor) {
                    messageIds[guildId].monitor = {};
                }

                // 更新messageId
                messageIds[guildId].monitor[channelId] = messageId;

                // 保存文件
                await this.saveMessageIds(messageIds);
                logTime(`[监控服务] 已更新服务器 ${guildId} 的监控消息ID: ${messageId}`);
            },
            "更新监控消息ID"
        );

        return result.success;
    }

    /**
     * 更新配置中的senatorRoleChannelId
     * @param {Object} client Discord客户端
     * @param {string} guildId 服务器ID
     * @param {string} channelId 频道ID
     * @returns {Promise<boolean>} 更新是否成功
     */
    async updateConfigSenatorChannelId(client, guildId, channelId) {
        const result = await ErrorHandler.handleService(
            async () => {
                // 读取配置文件
                const configPath = join(process.cwd(), 'config.json');
                const configData = await readFile(configPath, 'utf8');
                const config = JSON.parse(configData);

                // 更新senatorRoleChannelId
                if (!config.guilds?.[guildId]?.monitor) {
                    throw new Error('无效的服务器配置');
                }

                config.guilds[guildId].monitor.senatorRoleChannelId = channelId;

                // 写入配置文件
                await writeFile(configPath, JSON.stringify(config, null, 4), 'utf8');
                logTime(`[监控服务] 已更新服务器 ${guildId} 的议员监控频道ID: ${channelId}`);

                // 直接更新内存中的配置
                if (client.guildManager?.guilds?.has(guildId)) {
                    const guildConfig = client.guildManager.guilds.get(guildId);
                    if (guildConfig?.monitor) {
                        guildConfig.monitor.senatorRoleChannelId = channelId;
                        logTime(`[监控服务] 已更新内存中服务器 ${guildId} 的议员监控频道ID: ${channelId}`);
                    }
                }
            },
            "更新议员监控频道配置"
        );

        return result.success;
    }

    /**
     * 更新状态消息
     * @param {Client} client Discord客户端
     * @param {string} guildId 服务器ID
     */
    async updateStatusMessage(client, guildId) {
        await ErrorHandler.handleSilent(
            async () => {
                // 从messageIds.json获取channelId和messageId
                const { channelId, messageId } = await this.getMonitorIds(guildId);

                if (!channelId) {
                    logTime(`[监控服务] 服务器 ${guildId} 未配置监控频道ID`, true);
                    return;
                }

                const channel = await client.channels.fetch(channelId);
                const embed = await this.createStatusEmbed(client);

                // 如果有messageId，尝试更新现有消息
                if (messageId) {
                    const updated = await ErrorHandler.handleSilent(
                        async () => {
                            const message = await channel.messages.fetch(messageId);
                            await message.edit({ embeds: [embed] });
                            return true;
                        },
                        "更新现有监控消息",
                        false
                    );

                    if (updated) return; // 成功更新后直接返回
                    logTime(`[监控服务] 消息 ${messageId} 不存在，将创建新消息`);
                }

                // 创建新消息
                const newMessage = await channel.send({ embeds: [embed] });
                await this.updateMonitorMessageId(guildId, channelId, newMessage.id);
            },
            "更新状态消息"
        );
    }

    /**
     * 监控志愿者角色成员数量
     * @param {Client} client Discord客户端
     * @param {string} guildId 服务器ID
     */
    async monitorSenatorRole(client, guildId) {
        await ErrorHandler.handleSilent(
            async () => {
                const guildConfig = client.guildManager.getGuildConfig(guildId);
                if (!guildConfig?.monitor?.enabled || !guildConfig.monitor.roleMonitorCategoryId) {
                    return;
                }

                const volunteerRoleId = guildConfig.roleApplication?.volunteerRoleId;
                if (!volunteerRoleId) {
                    logTime(`[监控服务] 服务器 ${guildId} 未配置角色ID`, true);
                    return;
                }

                // 获取服务器和相关资源
                const guild = await client.guilds.fetch(guildId);
                const [roles, members, category] = await Promise.all([
                    guild.roles.fetch(),
                    guild.members.fetch(),
                    guild.channels.fetch(guildConfig.monitor.roleMonitorCategoryId)
                ]);

                const role = roles.get(volunteerRoleId);
                if (!role) {
                    throw new Error(`无法获取角色 ${volunteerRoleId}`);
                }

                // 统计拥有志愿者身份组的成员数量
                const memberCount = members.filter(
                    member => member.roles.cache.has(volunteerRoleId) && !member.user.bot
                ).size;

                const channelName = `社区志愿者: ${memberCount}`;

                // 获取或创建监控频道
                let channel = null;
                if (guildConfig.monitor.senatorRoleChannelId) {
                    channel = await ErrorHandler.handleSilent(
                        () => guild.channels.fetch(guildConfig.monitor.senatorRoleChannelId),
                        "获取现有志愿者监控频道",
                        null
                    );
                }

                if (!channel) {
                    // 创建新频道
                    channel = await guild.channels.create({
                        name: channelName,
                        type: ChannelType.GuildVoice,
                        parent: category.id,
                        permissionOverwrites: [
                            {
                                id: guild.roles.everyone.id,
                                allow: [PermissionFlagsBits.ViewChannel],
                                deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages]
                            },
                            {
                                id: client.user.id,
                                allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels]
                            }
                        ]
                    });

                    await this.updateConfigSenatorChannelId(client, guildId, channel.id);
                    logTime(`[监控服务] 已在服务器 ${guildId} 创建志愿者监控频道: ${channel.name}`);
                } else if (channel.name !== channelName) {
                    // 更新频道名称
                    await channel.setName(channelName);
                    logTime(`[监控服务] 已更新服务器 ${guildId} 的志愿者监控频道名称: ${channelName}`);
                }
            },
            `监控志愿者人数 [服务器 ${guildId}]`
        );
    }
}

export const monitorService = new MonitorService();
