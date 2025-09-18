import { Collection } from 'discord.js';

/**
 * 统一的冷却时间管理器
 * 支持命令、按钮、模态框等所有交互类型的冷却控制
 */
export class CooldownManager {
    constructor() {
        // 存储各种类型的冷却时间
        this.cooldowns = new Collection();
    }

    /**
     * 检查并处理冷却时间
     * @param {Object} interaction - Discord交互对象
     * @param {Object} config - 冷却配置
     * @param {string} config.type - 冷却类型（如：'command'、'button'、'modal'）
     * @param {string} config.key - 冷却键值（如：命令名、按钮ID）
     * @param {number} [config.duration=5000] - 冷却时间（毫秒）
     * @param {boolean} [config.global=false] - 是否为全局冷却（否则为用户级冷却）
     * @returns {Promise<{inCooldown: boolean, timeLeft?: number, reply?: Function}>}
     */
    async checkCooldown(interaction, config) {
        const { type, key, duration = 5000, global = false } = config;

        // 构建冷却键
        const cooldownKey = global ? `${type}:${key}` : `${type}:${key}:${interaction.user.id}`;

        const now = Date.now();
        const expirationTime = this.cooldowns.get(cooldownKey);

        // 检查是否在冷却中
        if (expirationTime && now < expirationTime) {
            const timeLeft = Math.ceil((expirationTime - now) / 1000);

            // 生成冷却提示回复函数
            const reply = async () => {
                const content = this.getCooldownMessage(type, key, timeLeft);
                const replyData = {
                    content,
                    flags: ['Ephemeral']
                };

                if (interaction.deferred) {
                    return await interaction.editReply(replyData);
                } else if (!interaction.replied) {
                    return await interaction.reply(replyData);
                }
            };

            return { inCooldown: true, timeLeft, reply };
        }

        // 设置新的冷却时间
        this.cooldowns.set(cooldownKey, now + duration);

        // 自动清理过期的冷却时间
        setTimeout(() => {
            this.cooldowns.delete(cooldownKey);
        }, duration);

        return { inCooldown: false };
    }

    /**
     * 获取冷却提示消息
     * @private
     * @param {string} type - 冷却类型
     * @param {string} key - 冷却键值
     * @param {number} timeLeft - 剩余时间（秒）
     * @returns {string} 提示消息
     */
    getCooldownMessage(type, key, timeLeft) {
        const typeMessages = {
            command: `⏳ 请等待 ${timeLeft} 秒后再使用 \`${key}\` 命令`,
            button: `⏳ 请等待 ${timeLeft} 秒后再次操作`,
            modal: `⏳ 请等待 ${timeLeft} 秒后再次提交`
        };

        return typeMessages[type] || `❌ 请等待 ${timeLeft} 秒后重试`;
    }
}

// 导出全局冷却管理器实例
export const globalCooldownManager = new CooldownManager();
