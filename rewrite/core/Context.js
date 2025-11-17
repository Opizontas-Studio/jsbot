import { ComponentV2Factory } from '../shared/factories/ComponentV2Factory.js';

/**
 * 统一的上下文对象
 * 提供快捷访问和方法
 */
class Context {
    /**
     * @param {import('discord.js').Interaction} interaction - Discord交互对象
     * @param {Object} config - 服务器配置
     * @param {import('./Container.js').Container} container - 依赖注入容器
     */
    constructor(interaction, config, container = null) {
        // 核心对象
        this.interaction = interaction;
        this.client = interaction.client;
        this.config = config;
        this.container = container;

        // Discord快捷访问
        this.user = interaction.user;
        this.guild = interaction.guild;
        this.member = interaction.member;
        this.channel = interaction.channel;

        // 容器服务快捷访问
        this.logger = container?.has?.('logger') ? container.get('logger') : null;
        this.registry = container?.has?.('registry') ? container.get('registry') : null;

        // 交互特殊字段
        this.selectedValues = null;
        this.useUpdate = false;

        // 上下文菜单额外字段
        if (interaction?.isUserContextMenuCommand?.()) {
            this.targetUser = interaction.targetUser;
        }
        if (interaction?.isMessageContextMenuCommand?.()) {
            this.targetMessage = interaction.targetMessage;
        }
    }

    /**
     * 快捷回复（自动判断defer状态和update模式）
     * @param {string|Object} content - 回复内容
     * @returns {Promise<import('discord.js').Message>}
     */
    async reply(content) {
        const replyData = typeof content === 'string' ? { content } : content;

        // 选择菜单可能使用update模式
        if (this.useUpdate && !this.interaction.replied && !this.interaction.deferred) {
            return await this.interaction.update(replyData);
        }

        if (this.interaction.deferred || this.interaction.replied) {
            return await this.interaction.editReply(replyData);
        }

        return await this.interaction.reply(replyData);
    }

    /**
     * 错误回复（使用ComponentV2）
     * @param {string} message - 错误消息
     * @param {boolean} [useText=false] - 是否使用纯文本
     * @returns {Promise<import('discord.js').Message>}
     */
    async error(message, useText = false) {
        if (useText) {
            return await this.reply({
                content: `❌ ${message}`,
                flags: ['Ephemeral']
            });
        }

        // 使用预加载的ComponentV2Factory
        const container = ComponentV2Factory.createContainer(ComponentV2Factory.Colors.ERROR);
        ComponentV2Factory.addHeading(container, '❌ 错误', 2);
        ComponentV2Factory.addText(container, message);

        return await this.reply({
            components: [container],
            flags: ['Ephemeral', 'IsComponentsV2']
        });
    }

    /**
     * 成功回复（使用ComponentV2）
     * @param {string} message - 成功消息
     * @param {boolean} [useText=false] - 是否使用纯文本
     * @returns {Promise<import('discord.js').Message>}
     */
    async success(message, useText = false) {
        if (useText) {
            return await this.reply({
                content: `✅ ${message}`
            });
        }

        // 使用预加载的ComponentV2Factory
        const container = ComponentV2Factory.createContainer(ComponentV2Factory.Colors.SUCCESS);
        ComponentV2Factory.addHeading(container, '✅ 成功', 2);
        ComponentV2Factory.addText(container, message);

        return await this.reply({
            components: [container],
            flags: ['IsComponentsV2']
        });
    }

    /**
     * Defer回复
     * @param {boolean} ephemeral - 是否私密
     * @returns {Promise<void>}
     */
    async defer(ephemeral = true) {
        // 如果使用update模式，不需要defer
        if (this.useUpdate) {
            return;
        }

        if (!this.interaction.deferred && !this.interaction.replied) {
            await this.interaction.deferReply({
                flags: ephemeral ? ['Ephemeral'] : undefined
            });
        }
    }
}

/**
 * 命令上下文
 */
class CommandContext extends Context {
    /**
     * 获取命令选项值
     * @param {string} name - 选项名称
     * @param {boolean} [required=false] - 是否必需
     * @returns {any}
     */
    getOption(name, required = false) {
        const option = this.interaction.options.get(name);
        if (required && !option) {
            throw new Error(`Required option ${name} not found`);
        }
        return option?.value;
    }

    /**
     * 获取子命令
     * @returns {string|null}
     */
    getSubcommand() {
        try {
            return this.interaction.options.getSubcommand(false);
        } catch {
            return null;
        }
    }

    /**
     * 获取子命令组
     * @returns {string|null}
     */
    getSubcommandGroup() {
        try {
            return this.interaction.options.getSubcommandGroup(false);
        } catch {
            return null;
        }
    }
}

export { CommandContext, Context };

