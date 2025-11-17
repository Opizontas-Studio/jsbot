import { ActionRowBuilder } from 'discord.js';
import { ComponentV2Factory } from '../factories/ComponentV2Factory.js';

/**
 * 确认消息构建器
 * 负责构建确认对话框的视觉呈现
 */
export class ConfirmationMessageBuilder {
    /**
     * 创建确认消息和按钮
     * @param {Object} options - 配置选项
     * @param {string} options.confirmationId - 确认ID
     * @param {string} options.title - 标题
     * @param {string} options.message - 消息内容
     * @param {string} [options.buttonLabel='确认'] - 按钮文本
     * @param {string} [options.buttonStyle='danger'] - 按钮样式
     * @param {Array<number>} [options.color] - 容器颜色
     * @param {number} [options.timeout=120000] - 超时时间（毫秒）
     * @returns {Object} Discord 消息对象
     */
    static createConfirmation({
        confirmationId,
        title,
        message,
        buttonLabel = '确认',
        buttonStyle = 'danger',
        color = ComponentV2Factory.Colors.WARNING,
        timeout = 120000
    }) {
        // 创建消息容器
        const container = ComponentV2Factory.createContainer(color);
        ComponentV2Factory.addHeading(container, title, 2);
        ComponentV2Factory.addText(container, message);

        // 添加超时提示
        const timeoutMinutes = Math.floor(timeout / 60000);
        ComponentV2Factory.addText(
            container,
            `\n*⏰ 此确认按钮将在 ${timeoutMinutes} 分钟后失效*`
        );

        // 创建确认按钮并直接添加到容器中
        const button = ComponentV2Factory.createButton({
            customId: `confirm_${confirmationId}`,
            label: buttonLabel,
            style: buttonStyle
        });

        const actionRow = new ActionRowBuilder().addComponents(button);
        container.addActionRowComponents(actionRow);

        // 使用统一的工厂方法返回完整的消息对象
        return ComponentV2Factory.createMessage(container);
    }

    /**
     * 创建超时消息
     * @param {string} operationName - 操作名称
     * @returns {Object} Discord消息对象
     */
    static createTimeoutMessage(operationName) {
        const container = ComponentV2Factory.createContainer(
            ComponentV2Factory.Colors.WARNING
        );
        ComponentV2Factory.addHeading(container, '⏰ 确认已超时', 2);
        ComponentV2Factory.addText(
            container,
            `${operationName}已取消。\n\n如需继续请重新执行命令。`
        );
        return ComponentV2Factory.createMessage(container);
    }

    /**
     * 创建操作失败消息
     * @param {string} title - 标题
     * @param {string} error - 错误信息
     * @returns {Object} Discord消息对象
     */
    static createErrorMessage(title, error) {
        const container = ComponentV2Factory.createContainer(
            ComponentV2Factory.Colors.ERROR
        );
        ComponentV2Factory.addHeading(container, `❌ ${title}`, 2);
        ComponentV2Factory.addText(container, error);
        return ComponentV2Factory.createMessage(container);
    }
}

