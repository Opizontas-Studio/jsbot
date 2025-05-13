import { exec } from 'child_process';
import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { globalRequestQueue } from '../utils/concurrency.js';
import { logTime } from '../utils/logger.js';

const execAsync = promisify(exec);

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
        this.embedTemplate = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('系统运行状态')
            .setFooter({ text: '系统监控' });

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
        const status = getConnectionStatus(client);
        const uptime = this.getSystemUptime(); // 不再需要await

        // 获取队列统计信息
        const queueLength = globalRequestQueue.queue.length;
        const currentProcessing = globalRequestQueue.currentProcessing;
        const { processed, failed } = globalRequestQueue.stats;

        return this.embedTemplate.setFields(
            {
                name: '网络延迟',
                value: ping === -1 ? '无法获取' : `${ping}ms`,
                inline: true,
            },
            {
                name: 'WebSocket状态',
                value: status,
                inline: true,
            },
            {
                name: '运行时间',
                value: uptime,
                inline: true,
            },
            {
                name: '队列状态',
                value: `🟢 运行中`,
                inline: true,
            },
            {
                name: '队列统计',
                value: [
                    `📥 等待处理: ${queueLength}`,
                    `⚡ 正在处理: ${currentProcessing}`,
                    `✅ 已完成: ${processed}`,
                    `❌ 失败: ${failed}`,
                ].join('\n'),
                inline: false,
            },
        ).setTimestamp();
    }

    /**
     * 更新配置中的messageId
     * @param {Object} client Discord客户端
     * @param {string} guildId 服务器ID
     * @param {string} messageId 消息ID
     * @returns {Promise<boolean>} 更新是否成功
     */
    async updateConfigMessageId(client, guildId, messageId) {
        try {
            // 读取配置文件
            const configPath = join(process.cwd(), 'config.json');
            const configData = await readFile(configPath, 'utf8');
            const config = JSON.parse(configData);

            // 更新messageId
            if (!config.guilds?.[guildId]?.monitor) {
                throw new Error('无效的服务器配置');
            }

            config.guilds[guildId].monitor.messageId = messageId;

            // 写入配置文件
            await writeFile(configPath, JSON.stringify(config, null, 4), 'utf8');
            logTime(`[监控服务] 已更新服务器 ${guildId} 的监控消息ID: ${messageId}`);

            // 直接更新内存中的配置
            if (client.guildManager && client.guildManager.guilds.has(guildId)) {
                const guildConfig = client.guildManager.guilds.get(guildId);
                if (guildConfig.monitor) {
                    guildConfig.monitor.messageId = messageId;
                    logTime(`[监控服务] 已更新内存中服务器 ${guildId} 的监控消息ID: ${messageId}`);
                }
            }

            return true;
        } catch (error) {
            logTime(`[监控服务] 更新配置文件失败: ${error.message}`, true);
            return false;
        }
    }

    /**
     * 更新配置中的senatorRoleChannelId
     * @param {Object} client Discord客户端
     * @param {string} guildId 服务器ID
     * @param {string} channelId 频道ID
     * @returns {Promise<boolean>} 更新是否成功
     */
    async updateConfigSenatorChannelId(client, guildId, channelId) {
        try {
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
            if (client.guildManager && client.guildManager.guilds.has(guildId)) {
                const guildConfig = client.guildManager.guilds.get(guildId);
                if (guildConfig.monitor) {
                    guildConfig.monitor.senatorRoleChannelId = channelId;
                    logTime(`[监控服务] 已更新内存中服务器 ${guildId} 的议员监控频道ID: ${channelId}`);
                }
            }

            return true;
        } catch (error) {
            logTime(`[监控服务] 更新配置文件失败: ${error.message}`, true);
            return false;
        }
    }

    /**
     * 更新状态消息
     * @param {Client} client Discord客户端
     * @param {string} channelId 频道ID
     * @param {string} messageId 消息ID
     * @param {string} guildId 服务器ID
     */
    async updateStatusMessage(client, channelId, messageId, guildId) {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel) {
                throw new Error(`无法获取频道 ${channelId}`);
            }

            const embed = await this.createStatusEmbed(client);

            // 如果有messageId，尝试更新现有消息
            if (messageId) {
                try {
                    const message = await channel.messages.fetch(messageId);
                    await message.edit({ embeds: [embed] });
                    return; // 成功更新后直接返回
                } catch (error) {
                    // 只有在消息确实不存在时才继续创建新消息
                    if (error.code === 10008) { // Discord API: Unknown Message
                        logTime(`[监控服务] 消息 ${messageId} 不存在，将创建新消息`);
                    } else {
                        // 其他错误直接抛出
                        throw error;
                    }
                }
            }

            // 只有在没有messageId或消息不存在时才创建新消息
            const newMessage = await channel.send({ embeds: [embed] });

            // 更新配置文件
            await this.updateConfigMessageId(client, guildId, newMessage.id);

        } catch (error) {
            logTime(`[监控服务] 更新状态消息失败: ${error.message}`, true);
        }
    }

    /**
     * 监控Senator角色成员数量
     * @param {Client} client Discord客户端
     * @param {string} guildId 服务器ID
     */
    async monitorSenatorRole(client, guildId) {
        try {
            const guildConfig = client.guildManager.getGuildConfig(guildId);
            if (!guildConfig || !guildConfig.monitor?.enabled || !guildConfig.monitor?.roleMonitorCategoryId) {
                return;
            }

            // 获取参议员角色ID
            const senatorRoleId = guildConfig.roleApplication?.senatorRoleId;
            if (!senatorRoleId) {
                logTime(`[监控服务] 服务器 ${guildId} 未配置参议员角色ID`, true);
                return;
            }

            // 获取服务器实例
            const guild = await client.guilds.fetch(guildId);
            if (!guild) {
                throw new Error(`无法获取服务器 ${guildId}`);
            }

            // 获取角色
            const roles = await guild.roles.fetch();
            const role = roles.get(senatorRoleId);
            if (!role) {
                throw new Error(`无法获取角色 ${senatorRoleId}`);
            }

            // 获取所有服务器成员
            const members = await guild.members.fetch();

            // 统计拥有议员身份组的成员数量
            const memberCount = members.filter(
                member => member.roles.cache.has(senatorRoleId) && !member.user.bot
            ).size;

            logTime(`[监控服务] 服务器 ${guildId} 议员人数: ${memberCount} (身份组: ${role.name})`);

            const channelName = `赛博议员: ${memberCount}`;

            // 获取分类频道
            const category = await guild.channels.fetch(guildConfig.monitor.roleMonitorCategoryId);
            if (!category) {
                throw new Error(`无法获取分类频道 ${guildConfig.monitor.roleMonitorCategoryId}`);
            }

            let channel;
            // 检查现有频道
            if (guildConfig.monitor.senatorRoleChannelId) {
                try {
                    channel = await guild.channels.fetch(guildConfig.monitor.senatorRoleChannelId);
                } catch (error) {
                    // 频道不存在，将创建新频道
                    channel = null;
                }
            }

            // 如果频道不存在，创建新频道
            if (!channel) {
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

                // 更新配置文件
                await this.updateConfigSenatorChannelId(client, guildId, channel.id);

                logTime(`[监控服务] 已在服务器 ${guildId} 创建议员监控频道: ${channel.name}`);
            }
            // 如果频道存在但名称需要更新
            else if (channel.name !== channelName) {
                await channel.setName(channelName);
                logTime(`[监控服务] 已更新服务器 ${guildId} 的议员监控频道名称: ${channelName}`);
            }

        } catch (error) {
            logTime(`[监控服务] 监控议员人数失败 [服务器 ${guildId}]: ${error.message}`, true);
        }
    }
}

export const monitorService = new MonitorService();
