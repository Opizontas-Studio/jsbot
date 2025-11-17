import { ActivityType, Client, GatewayIntentBits, Options } from 'discord.js';

/**
 * Discord客户端工厂
 * 负责创建和配置Discord客户端
 */
class ClientFactory {
    /**
     * 创建Discord客户端
     * @param {Object} options - 配置选项
     * @param {Object} options.intents - Gateway Intents
     * @param {Object} options.cache - 缓存配置
     * @param {Object} options.rest - REST配置
     * @returns {Client}
     */
    static create(options = {}) {
        const client = new Client({
            intents: options.intents || [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.DirectMessages,
            ],
            makeCache: options.cache || Options.cacheWithLimits({
                MessageManager: {
                    maxSize: 200,
                },
            }),
            rest: options.rest || {
                retries: 3,
            },
            failIfNotExists: false,
        });

        return client;
    }

    /**
     * 设置Bot状态
     * @param {Client} client - Discord客户端
     * @param {Object} options - 状态配置
     */
    static setPresence(client, options = {}) {
        const activity = options.activity || {
            name: 'Wait for your eternal presence.',
            type: ActivityType.Custom,
        };

        const status = options.status || 'idle';

        client.user.setPresence({
            activities: [activity],
            status
        });
    }
}

export { ClientFactory };

