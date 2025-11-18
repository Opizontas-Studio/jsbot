import { ConfirmationMessageBuilder } from '../builders/ConfirmationMessage.js';
import { createStandardMessage } from '../factories/ComponentV2Factory.js';

/**
 * 确认按钮配置
 * 处理所有使用统一路由的确认按钮
 */
export default [
    {
        id: 'shared.confirmButton',
        type: 'button',
        pattern: 'confirm_{confirmationId}',
        inject: ['confirmationService'],

        /**
         * 处理确认按钮点击
         */
        async handle(ctx, params, { confirmationService }) {
            const { confirmationId } = params;

            // 执行确认
            const result = await confirmationService.executeConfirmation(confirmationId, ctx.user.id, ctx.interaction);

            if (!result.success) {
                // 确认失败（过期、无权限等）
                await ctx.interaction.reply(
                    createStandardMessage('error', {
                        ...ConfirmationMessageBuilder.MESSAGES.error('操作失败', result.error),
                        additionalFlags: ['Ephemeral']
                    })
                );
            }
            // 成功的情况由回调函数处理交互响应
        }
    }
];
