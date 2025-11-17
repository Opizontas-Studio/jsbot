import { Events } from 'discord.js';
import { CommandContext, Context } from '../Context.js';

/**
 * 交互事件监听器
 * 统一处理所有Discord交互事件并分发到对应的处理器
 */
class InteractionListener {
    constructor(container, registry, logger, middlewareChain) {
        this.container = container;
        this.registry = registry;
        this.logger = logger;
        this.middlewareChain = middlewareChain;
    }

    /**
     * 注册事件监听器
     * @param {Client} client - Discord客户端
     */
    register(client) {
        client.on(Events.InteractionCreate, async (interaction) => {
            try {
                await this.handle(interaction);
            } catch (error) {
                this.logger.error({
                    msg: '交互处理顶层错误',
                    error: error.message,
                    stack: error.stack
                });
            }
        });

        this.logger.debug('[InteractionListener] 已注册');
    }

    /**
     * 处理交互
     * @param {Interaction} interaction - Discord交互对象
     */
    async handle(interaction) {
        // 斜杠命令
        if (interaction.isChatInputCommand()) {
            await this.handleCommand(interaction);
            return;
        }

        // 上下文菜单命令
        if (interaction.isContextMenuCommand()) {
            await this.handleCommand(interaction);
            return;
        }

        // 按钮交互
        if (interaction.isButton()) {
            await this.handleButton(interaction);
            return;
        }

        // 选择菜单交互
        if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu() ||
            interaction.isRoleSelectMenu() || interaction.isChannelSelectMenu()) {
            await this.handleSelectMenu(interaction);
            return;
        }

        // 模态框提交
        if (interaction.isModalSubmit()) {
            await this.handleModal(interaction);
            return;
        }

        // 自动补全
        if (interaction.isAutocomplete()) {
            await this.handleAutocomplete(interaction);
            return;
        }
    }

    /**
     * 处理命令
     * @private
     */
    async handleCommand(interaction) {
        const commandName = interaction.commandName;
        const config = this.registry.findCommand(commandName);

        if (!config) {
            this.logger.warn({
                msg: '未找到命令',
                commandName,
                userId: interaction.user.id
            });
            return;
        }

        // 获取服务器配置
        const guildConfig = this.getGuildConfig(interaction.guildId);

        // 创建上下文
        const ctx = new CommandContext(interaction, guildConfig, this.container);

        // 执行中间件链
        await this.middlewareChain.execute(ctx, config, async () => {
            // 解析依赖
            const dependencies = config.inject ? this.container.resolve(config.inject) : {};

            // 执行命令
            await config.execute(ctx, dependencies);
        });
    }

    /**
     * 处理按钮交互
     * @private
     */
    async handleButton(interaction) {
        const customId = interaction.customId;
        const match = this.registry.findButton(customId);

        if (!match) {
            this.logger.warn({
                msg: '未找到按钮处理器',
                customId,
                userId: interaction.user.id
            });
            return;
        }

        const { config, params } = match;
        const guildConfig = this.getGuildConfig(interaction.guildId);
        const ctx = new Context(interaction, guildConfig, this.container);

        await this.middlewareChain.execute(ctx, config, async () => {
            const dependencies = config.inject ? this.container.resolve(config.inject) : {};
            await config.handle(ctx, params, dependencies);
        });
    }

    /**
     * 处理选择菜单交互
     * @private
     */
    async handleSelectMenu(interaction) {
        const customId = interaction.customId;
        const match = this.registry.findSelectMenu(customId);

        if (!match) {
            this.logger.warn({
                msg: '未找到选择菜单处理器',
                customId,
                userId: interaction.user.id
            });
            return;
        }

        const { config, params } = match;
        const guildConfig = this.getGuildConfig(interaction.guildId);
        const ctx = new Context(interaction, guildConfig, this.container);
        ctx.selectedValues = interaction.values;

        await this.middlewareChain.execute(ctx, config, async () => {
            const dependencies = config.inject ? this.container.resolve(config.inject) : {};
            await config.handle(ctx, params, dependencies);
        });
    }

    /**
     * 处理模态框提交
     * @private
     */
    async handleModal(interaction) {
        const customId = interaction.customId;
        const match = this.registry.findModal(customId);

        if (!match) {
            this.logger.warn({
                msg: '未找到模态框处理器',
                customId,
                userId: interaction.user.id
            });
            return;
        }

        const { config, params } = match;
        const guildConfig = this.getGuildConfig(interaction.guildId);
        const ctx = new Context(interaction, guildConfig, this.container);

        await this.middlewareChain.execute(ctx, config, async () => {
            const dependencies = config.inject ? this.container.resolve(config.inject) : {};
            await config.handle(ctx, params, dependencies);
        });
    }

    /**
     * 处理自动补全
     * @private
     */
    async handleAutocomplete(interaction) {
        const commandName = interaction.commandName;
        const config = this.registry.findCommand(commandName);

        if (!config || !config.autocomplete) {
            return;
        }

        const guildConfig = this.getGuildConfig(interaction.guildId);
        const ctx = new Context(interaction, guildConfig, this.container);

        try {
            const dependencies = config.inject ? this.container.resolve(config.inject) : {};
            await config.autocomplete(ctx, dependencies);
        } catch (error) {
            this.logger.warn({
                msg: '自动补全失败',
                commandName,
                error: error.message
            });
            try {
                await interaction.respond([]);
            } catch {}
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

export { InteractionListener };

