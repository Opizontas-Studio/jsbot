import { Events } from 'discord.js';

/**
 * 消息事件监听器
 * 处理消息相关事件
 */
export class MessageListener {
    constructor(container, registry, logger) {
        this.container = container;
        this.registry = registry;
        this.logger = logger;
    }

    /**
     * 注册事件监听器
     * @param {Client} client - Discord客户端
     */
    register(client) {
        // 消息创建
        client.on(Events.MessageCreate, async message => {
            await this.dispatchEvent('messageCreate', message);
        });

        // 消息删除
        client.on(Events.MessageDelete, async message => {
            await this.dispatchEvent('messageDelete', message);
        });

        // 消息更新
        client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
            await this.dispatchEvent('messageUpdate', { oldMessage, newMessage });
        });

        // 消息批量删除
        client.on(Events.MessageBulkDelete, async messages => {
            await this.dispatchEvent('messageBulkDelete', messages);
        });

        this.logger.debug('[MessageListener] 已注册');
    }

    /**
     * 分发事件到注册的处理器
     * @private
     * @param {string} eventName - 事件名称
     * @param {any} eventData - 事件数据
     */
    async dispatchEvent(eventName, eventData) {
        const handlers = this.registry.getEventHandlers(eventName);

        if (handlers.length === 0) {
            return;
        }

        this.logger.debug({
            msg: `处理事件: ${eventName}`,
            handlersCount: handlers.length
        });

        // 按优先级顺序执行
        for (const config of handlers) {
            try {
                // 检查filter
                if (config.filter) {
                    const guildId = eventData.guild?.id || eventData.newMessage?.guild?.id;
                    const guildConfig = this.getGuildConfig(guildId);

                    const filterCtx = {
                        guild: eventData.guild || eventData.newMessage?.guild,
                        message: eventData,
                        config: guildConfig,
                        container: this.container
                    };

                    const shouldHandle = await config.filter(filterCtx);
                    if (!shouldHandle) {
                        continue;
                    }
                }

                // 解析依赖
                const dependencies = config.inject ? this.container.resolve(config.inject) : {};

                // 执行处理器
                await config.handle(eventData, dependencies);

                this.logger.debug({
                    msg: `事件处理完成: ${eventName}`,
                    handlerId: config.id
                });
            } catch (error) {
                this.logger.error({
                    msg: `事件处理器错误: ${eventName}`,
                    handlerId: config.id,
                    error: error.message,
                    stack: error.stack
                });
            }
        }
    }

    /**
     * 获取服务器配置
     * @private
     */
    getGuildConfig(guildId) {
        if (!guildId) return {};
        const configManager = this.container.get('configManager');
        return configManager.getGuild(guildId) || {};
    }
}
