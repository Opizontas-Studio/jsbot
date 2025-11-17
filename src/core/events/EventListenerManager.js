import { InteractionListener } from './InteractionListener.js';
import { MemberListener } from './MemberListener.js';
import { MessageListener } from './MessageListener.js';

/**
 * 事件监听器管理器
 * 负责创建和注册所有Discord事件监听器
 */
class EventListenerManager {
    /**
     * 注册所有事件监听器
     * @param {Client} client - Discord客户端
     * @param {Container} container - DI容器
     * @param {Registry} registry - 注册中心
     * @param {MiddlewareChain} middlewareChain - 中间件链
     * @param {Logger} logger - 日志器
     */
    static register(client, container, registry, middlewareChain, logger) {
        const listeners = [];

        // 创建交互事件监听器
        const interactionListener = new InteractionListener(
            container,
            registry,
            logger,
            middlewareChain
        );
        interactionListener.register(client);
        listeners.push(interactionListener);

        // 创建成员事件监听器
        const memberListener = new MemberListener(
            container,
            registry,
            logger
        );
        memberListener.register(client);
        listeners.push(memberListener);

        // 创建消息事件监听器
        const messageListener = new MessageListener(
            container,
            registry,
            logger
        );
        messageListener.register(client);
        listeners.push(messageListener);

        logger.info('[EventListenerManager] 事件监听器已注册');

        return listeners;
    }
}

export { EventListenerManager };

