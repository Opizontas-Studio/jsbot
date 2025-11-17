import { SlashCommandBuilder } from 'discord.js';
import { PingMessageBuilder } from '../builders/pingMessages.js';
import { SystemMessageBuilder } from '../builders/systemMessages.js';

/**
 * Basic模块的命令配置
 * 导出配置数组供Registry自动注册
 */
export default [
    {
        id: 'basic.ping',
        type: 'command',
        commandKind: 'slash',
        name: 'ping',
        description: '测试Bot响应速度',
        defer: false, // Ping命令不需要defer，立即响应
        cooldown: 3000, // 3秒冷却

        /**
         * 构建命令
         */
        builder() {
            return new SlashCommandBuilder()
                .setName(this.name)
                .setDescription(this.description);
        },

        /**
         * 执行命令
         */
        async execute(ctx) {
            const start = Date.now();
            const apiLatency = Math.round(ctx.client.ws.ping);

            // 发送初始回复以测量往返延迟（使用Component V2）
            await ctx.reply(
                PingMessageBuilder.createMeasuring({ additionalFlags: ['Ephemeral'] })
            );

            const roundTripLatency = Date.now() - start;

            // 更新回复（使用Component V2）
            await ctx.interaction.editReply(
                PingMessageBuilder.createPong({
                    apiLatency,
                    roundTripLatency,
                    botTag: ctx.client.user.tag,
                    guildCount: ctx.client.guilds.cache.size
                }, { additionalFlags: ['Ephemeral'] })
            );
        }
    },

    {
        id: 'basic.system',
        type: 'command',
        commandKind: 'slash',
        name: '系统',
        description: 'Bot 系统管理指令',
        defer: { ephemeral: true },
        permissions: ['administrator'],
        inject: ['basic.commandSyncService', 'basic.moduleReloadService', 'activeOperationTracker', 'confirmationService', 'configManager'],

        /**
         * 构建命令
         */
        builder() {
            return new SlashCommandBuilder()
                .setName(this.name)
                .setDescription(this.description)
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('同步指令')
                        .setDescription('检查并同步当前服务器的Discord指令')
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('重载模块')
                        .setDescription('热重载指定模块（不支持 basic 模块）')
                        .addStringOption(option =>
                            option.setName('模块')
                                .setDescription('要重载的模块名称')
                                .setRequired(true)
                                .setAutocomplete(true)
                        )
                        .addStringOption(option =>
                            option.setName('范围')
                                .setDescription('重载范围')
                                .setRequired(true)
                                .addChoices(
                                    { name: '完全重载（服务+配置）', value: 'all' },
                                    { name: '仅重载 Builders', value: 'builders' }
                                )
                        )
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('重载配置')
                        .setDescription('重新加载当前服务器的配置文件')
                )
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('重启')
                        .setDescription('重启 Bot（需要进程管理器支持）')
                );
        },

        /**
         * 自动补全处理
         */
        async autocomplete(ctx, { moduleReloadService }) {
            const subcommand = ctx.interaction.options.getSubcommand();

            if (subcommand === '重载模块') {
                const focusedOption = ctx.interaction.options.getFocused(true);

                if (focusedOption.name === '模块') {
                    const modulesPath = new URL('../../', import.meta.url).pathname;
                    const modules = await moduleReloadService.getReloadableModules(modulesPath);

                    const filtered = modules
                        .filter(name => name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                        .slice(0, 25);

                    await ctx.interaction.respond(
                        filtered.map(name => ({ name, value: name }))
                    );
                }
            }
        },

        /**
         * 执行命令
         */
        async execute(ctx, dependencies) {
            const subcommand = ctx.interaction.options.getSubcommand();

            switch (subcommand) {
                case '同步指令':
                    await this._executeSyncCommands(ctx, dependencies);
                    break;
                case '重载模块':
                    await this._executeReloadModule(ctx, dependencies);
                    break;
                case '重载配置':
                    await this._executeReloadConfig(ctx, dependencies);
                    break;
                case '重启':
                    await this._executeRestart(ctx, dependencies);
                    break;
            }
        },

        /**
         * 执行同步指令子命令
         * @private
         */
        async _executeSyncCommands(ctx, { commandSyncService }) {
            // 显示检查中消息
            await ctx.interaction.editReply(SystemMessageBuilder.createSyncChecking());

            // 调用服务执行同步
            const result = await commandSyncService.syncCommands(ctx);

            // 显示结果消息
            if (result.unchanged) {
                await ctx.interaction.editReply(
                    SystemMessageBuilder.createSyncUpToDate({
                        localTotal: result.localTotal,
                        deployedTotal: result.deployedTotal
                    })
                );

                ctx.logger.info({
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

                ctx.logger.info({
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
        },

        /**
         * 执行重载模块子命令
         * @private
         */
        async _executeReloadModule(ctx, { moduleReloadService, activeOperationTracker, confirmationService }) {
            const moduleName = ctx.interaction.options.getString('模块');
            const scope = ctx.interaction.options.getString('范围');

            // 检查是否有活跃操作
            const activeOps = activeOperationTracker.getActiveOperations(moduleName);
            const hasActiveOps = activeOps.length > 0;

            // 显示确认消息
            const confirmMessage = SystemMessageBuilder.createReloadConfirmation(
                moduleName,
                scope,
                hasActiveOps
            );

            const { confirmationId, messagePayload } = confirmationService.createConfirmationWithMessage({
                userId: ctx.user.id,
                onConfirm: async (confirmation, context) => {
                    await confirmation.update(
                        SystemMessageBuilder.createReloadProgress(context.moduleName, context.scope)
                    );

                    try {
                        const modulesPath = new URL('../../', import.meta.url).pathname;
                        const result = await moduleReloadService.reloadModule(context.moduleName, {
                            scope: context.scope,
                            modulesPath,
                            force: context.hasActiveOps
                        });

                        await confirmation.editReply(
                            SystemMessageBuilder.createReloadSuccess(result)
                        );

                        ctx.logger.info({
                            msg: '[System.ReloadModule] 重载成功',
                            moduleName: context.moduleName,
                            scope: context.scope,
                            userId: ctx.user.id,
                            duration: result.duration,
                            cleared: result.cleared,
                            loaded: result.loaded
                        });
                    } catch (error) {
                        await confirmation.editReply(
                            SystemMessageBuilder.createReloadError(context.moduleName, error.message)
                        );

                        ctx.logger.error({
                            msg: '[System.ReloadModule] 重载失败',
                            moduleName: context.moduleName,
                            scope: context.scope,
                            userId: ctx.user.id,
                            error: error.message
                        });
                    }
                },
                context: { moduleName, scope, hasActiveOps },
                title: '⚠️ 确认重载模块',
                message: confirmMessage,
                buttonLabel: hasActiveOps ? '⚠️ 强制重载' : '确认重载',
                buttonStyle: 'danger',
                color: hasActiveOps ? ComponentV2Factory.Colors.ERROR : ComponentV2Factory.Colors.WARNING
            });

            await ctx.interaction.editReply(messagePayload);
        },

        /**
         * 执行重载配置子命令
         * @private
         */
        async _executeReloadConfig(ctx, { configManager, confirmationService }) {
            const guildId = ctx.interaction.guildId;

            if (!guildId) {
                ctx.logger.warn({
                    msg: '[System.ReloadConfig] 在非服务器环境中调用',
                    userId: ctx.user.id
                });

                await ctx.interaction.editReply(
                    SystemMessageBuilder.createConfigReloadError(
                        'N/A',
                        '此命令只能在服务器中使用'
                    )
                );
                return;
            }

            // 显示确认消息
            const confirmMessage = SystemMessageBuilder.createConfigReloadConfirmation(guildId);

            const { confirmationId, messagePayload } = confirmationService.createConfirmationWithMessage({
                userId: ctx.user.id,
                onConfirm: async (confirmation, context) => {
                    await confirmation.update(
                        SystemMessageBuilder.createConfigReloadProgress(context.guildId)
                    );

                    ctx.logger.info({
                        msg: '[System.ReloadConfig] 开始重载',
                        guildId: context.guildId,
                        userId: ctx.user.id
                    });

                    try {
                        // 重载配置
                        const reloadedConfig = configManager.reloadGuild(context.guildId);

                        ctx.logger.info({
                            msg: '[System.ReloadConfig] 配置已重载',
                            guildId: context.guildId,
                            userId: ctx.user.id,
                            username: ctx.user.tag,
                            hasConfig: !!reloadedConfig
                        });

                        await confirmation.editReply(
                            SystemMessageBuilder.createConfigReloadSuccess(
                                context.guildId,
                                !!reloadedConfig
                            )
                        );
                    } catch (error) {
                        ctx.logger.error({
                            msg: '[System.ReloadConfig] 配置重载失败',
                            guildId: context.guildId,
                            userId: ctx.user.id,
                            error: error.message,
                            stack: error.stack
                        });

                        await confirmation.editReply(
                            SystemMessageBuilder.createConfigReloadError(context.guildId, error.message)
                        );
                    }
                },
                context: { guildId },
                title: '⚠️ 确认重载配置',
                message: confirmMessage,
                buttonLabel: '确认重载',
                buttonStyle: 'primary'
            });

            await ctx.interaction.editReply(messagePayload);
        },

        /**
         * 执行重启子命令
         * @private
         */
        async _executeRestart(ctx, { confirmationService }) {
            ctx.logger.warn({
                msg: '[System.Restart] 请求重启 Bot',
                guildId: ctx.guild?.id,
                userId: ctx.user.id,
                username: ctx.user.tag
            });

            // 显示确认消息
            const confirmMessage = SystemMessageBuilder.createRestartConfirmation();

            const { confirmationId, messagePayload } = confirmationService.createConfirmationWithMessage({
                userId: ctx.user.id,
                onConfirm: async (confirmation, context) => {
                    await confirmation.update(
                        SystemMessageBuilder.createRestarting()
                    );

                    ctx.logger.warn({
                        msg: '[System.Restart] 确认重启 Bot',
                        guildId: ctx.guild?.id,
                        userId: ctx.user.id,
                        username: ctx.user.tag
                    });

                    // 延迟退出以确保消息发送
                    setTimeout(() => process.exit(0), 1000);
                },
                context: {},
                title: '⚠️ 确认重启 Bot',
                message: confirmMessage,
                buttonLabel: '确认重启',
                buttonStyle: 'danger'
            });

            await ctx.interaction.editReply(messagePayload);
        }
    }
];

