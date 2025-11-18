import { ComponentV2Factory } from '../../../shared/factories/ComponentV2Factory.js';

/**
 * Ping命令消息构建器
 * 包含消息文本定义和消息构建逻辑
 */
export class PingMessageBuilder {
    // ==================== 消息文本定义 ====================

    static MESSAGES = {
        measuring: {
            message: '🏓 **测量中...**',
            emoji: '' // 已在消息中包含表情
        }
    };
    /**
     * 创建Pong响应消息
     * @param {Object} data - 延迟数据
     * @param {number} data.apiLatency - API延迟（毫秒）
     * @param {number} data.roundTripLatency - 往返延迟（毫秒）
     * @param {string} data.botTag - Bot标签
     * @param {number} data.guildCount - 服务器数量
     * @param {Object} [options] - 消息选项
     * @returns {Object} Discord消息对象
     */
    static createPong({ apiLatency, roundTripLatency, botTag, guildCount }, options) {
        const container = ComponentV2Factory.createContainer(
            this._getLatencyColor(Math.max(apiLatency, roundTripLatency))
        );

        // 标题
        ComponentV2Factory.addHeading(container, '🏓 Pong!', 2);
        ComponentV2Factory.addSeparator(container);

        // 延迟信息
        ComponentV2Factory.addText(
            container,
            [`⚡ **API延迟:** ${apiLatency}ms`, `🔄 **往返延迟:** ${roundTripLatency}ms`].join('\n')
        );

        ComponentV2Factory.addSeparator(container);

        // Bot信息
        ComponentV2Factory.addText(
            container,
            [`🤖 **Bot:** \`${botTag}\``, `📊 **服务器数:** ${guildCount}`].join('\n')
        );

        return ComponentV2Factory.createMessage(container, options);
    }

    /**
     * 根据延迟选择颜色
     * @private
     * @param {number} latency - 延迟（毫秒）
     * @returns {Array<number>} RGB颜色数组
     */
    static _getLatencyColor(latency) {
        if (latency < 100) return ComponentV2Factory.Colors.SUCCESS;
        if (latency < 200) return ComponentV2Factory.Colors.INFO;
        if (latency < 500) return ComponentV2Factory.Colors.WARNING;
        return ComponentV2Factory.Colors.ERROR;
    }
}
