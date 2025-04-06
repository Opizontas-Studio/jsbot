import { exec } from 'child_process';
import { EmbedBuilder } from 'discord.js';
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
     * @param {string} guildId 服务器ID
     * @param {string} messageId 消息ID
     * @returns {Promise<boolean>} 更新是否成功
     */
    async updateConfigMessageId(guildId, messageId) {
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
            logTime(`已更新服务器 ${guildId} 的监控消息ID: ${messageId}`);
            return true;
        } catch (error) {
            logTime(`更新配置文件失败: ${error.message}`, true);
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
                        logTime(`消息 ${messageId} 不存在，将创建新消息`);
                    } else {
                        // 其他错误直接抛出
                        throw error;
                    }
                }
            }

            // 只有在没有messageId或消息不存在时才创建新消息
            const newMessage = await channel.send({ embeds: [embed] });

            // 更新配置文件
            await this.updateConfigMessageId(guildId, newMessage.id);

            // 直接更新内存中的配置
            if (client.guildManager && client.guildManager.guilds.has(guildId)) {
                const guildConfig = client.guildManager.guilds.get(guildId);
                if (guildConfig.monitor) {
                    guildConfig.monitor.messageId = newMessage.id;
                    logTime(`已更新内存中服务器 ${guildId} 的监控消息ID: ${newMessage.id}`);
                }
            }

        } catch (error) {
            logTime(`更新状态消息失败: ${error.message}`, true);
        }
    }
}

export const monitorService = new MonitorService();
