import { defineService } from '../../../core/Container.js';
import { ComponentV2Factory, createStandardMessage } from '../../../shared/factories/ComponentV2Factory.js';
import { SystemMessageBuilder } from '../builders/systemMessages.js';

/**
 * 系统命令服务
 * 协调各种系统管理操作，处理完整的业务流程
 */
export class SystemCommandService {
    static dependencies = [
        'logger',
        'commandDeployer',
        'moduleReloader',
        'configManager',
        'activeOperationTracker',
        'confirmationService'
    ];

    constructor(deps) {
        Object.assign(this, deps);
    }

    /**
     * 执行命令同步
     * 包含完整的流程：显示进度消息、执行同步、更新结果、记录日志
     */
    async executeSyncCommands(ctx) {
        // 显示检查中消息
        await ctx.interaction.editReply(createStandardMessage('progress', SystemMessageBuilder.MESSAGES.sync.checking));

        // 调用核心服务执行同步
        const result = await this.commandDeployer.syncCommandsToGuild(ctx.interaction.guildId, ctx.client.token);

        // 显示结果消息
        if (result.unchanged) {
            await ctx.interaction.editReply(
                SystemMessageBuilder.createSyncUpToDate({
                    localTotal: result.localTotal,
                    deployedTotal: result.deployedTotal
                })
            );

            this.logger.info({
                msg: '[System.SyncCommands] 命令已是最新',
                guildId: ctx.guild?.id,
                userId: ctx.user.id,
                localTotal: result.localTotal,
                deployedTotal: result.deployedTotal
            });
        } else {
            await ctx.interaction.editReply(
                SystemMessageBuilder.createSyncCompleted({
                    duration: result.duration,
                    localTotal: result.localTotal,
                    deleted: result.deleted,
                    updated: result.updated,
                    added: result.added
                })
            );

            this.logger.info({
                msg: '[System.SyncCommands] 同步完成',
                guildId: ctx.guild?.id,
                userId: ctx.user.id,
                duration: result.duration,
                changes: {
                    deleted: result.deleted.length,
                    updated: result.updated.length,
                    added: result.added.length
                }
            });
        }
    }

    /**
     * 执行模块重载（实际的重载逻辑，供确认回调使用）
     * @param {Object} options - 重载选项
     * @param {string} options.moduleName - 模块名称
     * @param {string} options.scope - 重载范围
     * @param {boolean} options.hasActiveOps - 是否有活跃操作
     * @param {string} options.modulesPath - 模块路径
     * @returns {Promise<Object>} 重载结果
     */
    async executeReloadModule({ moduleName, scope, hasActiveOps, modulesPath }) {
        const result = await this.moduleReloader.reloadModule(moduleName, {
            scope,
            modulesPath,
            force: hasActiveOps
        });

        this.logger.debug({
            msg: '[System.ReloadModule] 重载成功',
            moduleName,
            scope,
            duration: result.duration,
            cleared: result.cleared,
            loaded: result.loaded
        });

        return result;
    }

    /**
     * 执行配置重载（实际的重载逻辑，供确认回调使用）
     * @param {string} guildId - 服务器ID
     * @returns {Object} { success: boolean, hasConfig: boolean }
     */
    executeReloadConfig(guildId) {
        const reloadedConfig = this.configManager.reloadGuild(guildId);

        this.logger.info({
            msg: '[System.ReloadConfig] 配置已重载',
            guildId,
            hasConfig: !!reloadedConfig
        });

        return {
            success: true,
            hasConfig: !!reloadedConfig
        };
    }

    /**
     * 执行重启
     * @param {number} delay - 延迟毫秒数（默认1000）
     */
    executeRestart(delay = 1000) {
        this.logger.warn({
            msg: '[System.Restart] 执行重启',
            delay
        });

        // 延迟退出以确保消息发送
        setTimeout(() => process.exit(0), delay);
    }

    /**
     * 获取可重载的模块列表（用于自动补全）
     * @param {string} modulesPath - 模块路径
     * @returns {Promise<Array<string>>}
     */
    getReloadableModules(modulesPath) {
        return this.moduleReloader.getReloadableModules(modulesPath);
    }

    /**
     * 创建标准错误处理器
     * @private
     * @param {Function} errorMessageFn - 错误消息构建函数
     * @param {Object} logTemplate - 日志模板对象
     * @returns {Function} 错误处理回调
     */
    _createErrorHandler(errorMessageFn, logTemplate) {
        return async (error, confirmation, context) => {
            await confirmation.editReply(createStandardMessage('error', errorMessageFn(error.message)));

            return {
                logInfo: {
                    ...logTemplate,
                    error: error.message
                }
            };
        };
    }

    /**
     * 处理重载模块命令
     * 包含完整流程：参数提取、活跃操作检查、确认流程、执行重载
     * @param {Context} ctx - 命令上下文
     * @param {string} modulesPath - 模块根路径
     */
    async handleReloadModule(ctx, modulesPath) {
        const moduleName = ctx.interaction.options.getString('模块');
        const scope = ctx.interaction.options.getString('范围');
        const hasActiveOps = this.activeOperationTracker.getActiveOperations(moduleName).length > 0;

        const context = { moduleName, scope, hasActiveOps, modulesPath };

        const { confirmationId, messagePayload } = this.confirmationService.createConfirmationWithMessage({
            userId: ctx.user.id,
            onConfirm: async (confirmation, context) => {
                await confirmation.update(
                    createStandardMessage(
                        'progress',
                        SystemMessageBuilder.MESSAGES.reload.progress(context.moduleName, context.scope)
                    )
                );

                const result = await this.executeReloadModule(context);

                await confirmation.editReply(SystemMessageBuilder.createReloadSuccess(result));

                return {
                    logInfo: {
                        msg: '[System.ReloadModule] 确认重载',
                        moduleName: context.moduleName,
                        scope: context.scope,
                        userId: ctx.user.id
                    }
                };
            },
            onError: this._createErrorHandler(
                errorMsg => SystemMessageBuilder.MESSAGES.reload.error(context.moduleName, errorMsg),
                {
                    msg: '[System.ReloadModule] 重载失败',
                    moduleName: context.moduleName,
                    scope: context.scope,
                    userId: ctx.user.id
                }
            ),
            context,
            title: '⚠️ 确认重载模块',
            message: SystemMessageBuilder.MESSAGES.reload.confirmation(moduleName, scope, hasActiveOps),
            buttonLabel: hasActiveOps ? '⚠️ 强制重载' : '确认重载',
            buttonStyle: 'danger',
            color: hasActiveOps ? ComponentV2Factory.Colors.ERROR : ComponentV2Factory.Colors.WARNING
        });

        await ctx.interaction.editReply(messagePayload);
    }

    /**
     * 处理重载配置命令
     * 包含完整流程：确认流程、执行重载
     * @param {Context} ctx - 命令上下文
     */
    async handleReloadConfig(ctx) {
        const guildId = ctx.interaction.guildId;

        const { confirmationId, messagePayload } = this.confirmationService.createConfirmationWithMessage({
            userId: ctx.user.id,
            onConfirm: async (confirmation, context) => {
                await confirmation.update(
                    createStandardMessage('progress', SystemMessageBuilder.MESSAGES.config.progress(context.guildId))
                );

                const result = this.executeReloadConfig(context.guildId);

                await confirmation.editReply(
                    SystemMessageBuilder.createConfigReloadSuccess(context.guildId, result.hasConfig)
                );

                return {
                    logInfo: {
                        msg: '[System.ReloadConfig] 确认重载',
                        guildId: context.guildId,
                        userId: ctx.user.id,
                        username: ctx.user.tag
                    }
                };
            },
            onError: this._createErrorHandler(
                errorMsg => SystemMessageBuilder.MESSAGES.config.error(guildId, errorMsg),
                {
                    msg: '[System.ReloadConfig] 配置重载失败',
                    guildId,
                    userId: ctx.user.id
                }
            ),
            context: { guildId },
            title: '⚠️ 确认重载配置',
            message: SystemMessageBuilder.MESSAGES.config.confirmation(guildId),
            buttonLabel: '确认重载',
            buttonStyle: 'primary'
        });

        await ctx.interaction.editReply(messagePayload);
    }

    /**
     * 处理重启命令
     * 包含完整流程：确认流程、执行重启
     * @param {Context} ctx - 命令上下文
     */
    async handleRestart(ctx) {
        this.logger.warn({
            msg: '[System.Restart] 请求重启 Bot',
            guildId: ctx.guild?.id,
            userId: ctx.user.id,
            username: ctx.user.tag
        });

        const { confirmationId, messagePayload } = this.confirmationService.createConfirmationWithMessage({
            userId: ctx.user.id,
            onConfirm: async (confirmation, context) => {
                await confirmation.update(
                    createStandardMessage('progress', SystemMessageBuilder.MESSAGES.restart.progress)
                );

                this.executeRestart(1000);

                return {
                    logInfo: {
                        msg: '[System.Restart] 确认重启 Bot',
                        guildId: ctx.guild?.id,
                        userId: ctx.user.id,
                        username: ctx.user.tag
                    },
                    logLevel: 'warn'
                };
            },
            context: { guildId: ctx.guild?.id, userId: ctx.user.id, username: ctx.user.tag },
            title: '⚠️ 确认重启 Bot',
            message: SystemMessageBuilder.MESSAGES.restart.confirmation(),
            buttonLabel: '确认重启',
            buttonStyle: 'danger'
        });

        await ctx.interaction.editReply(messagePayload);
    }
}

// 服务注册配置（供 Registry 自动扫描）
export const serviceConfig = defineService('basic.systemCommandService', SystemCommandService);
