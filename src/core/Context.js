import { ComponentV2Factory } from '../shared/factories/ComponentV2Factory.js';

/**
 * 统一的上下文对象
 * 提供快捷访问和方法
 */
export class Context {
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
        this.apiClient = container?.has?.('apiClient') ? container.get('apiClient') : null;
        this.queueManager = container?.has?.('queueManager') ? container.get('queueManager') : null;
        this.lockManager = container?.has?.('lockManager') ? container.get('lockManager') : null;

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

        return await this.reply(
            ComponentV2Factory.createStandardMessage('error', {
                title: '错误',
                message,
                additionalFlags: ['Ephemeral']
            })
        );
    }

    /**
     * 提示回复（使用ComponentV2）
     * @param {string} message - 提示消息
     * @param {boolean} [useText=false] - 是否使用纯文本
     * @returns {Promise<import('discord.js').Message>}
     */
    async info(message, useText = false) {
        if (useText) {
            return await this.reply({
                content: `ℹ️ ${message}`,
                flags: ['Ephemeral']
            });
        }

        return await this.reply(
            ComponentV2Factory.createStandardMessage('info', {
                title: '提示',
                message,
                additionalFlags: ['Ephemeral']
            })
        );
    }

    /**
     * 成功回复（使用ComponentV2）
     * @param {string|Object} messageOrConfig - 成功消息或配置对象
     * @param {boolean} [useText=false] - 是否使用纯文本
     * @returns {Promise<import('discord.js').Message>}
     */
    async success(messageOrConfig, useText = false) {
        if (useText) {
            const message = typeof messageOrConfig === 'string' ? messageOrConfig : messageOrConfig.message;
            return await this.reply({
                content: `✅ ${message}`
            });
        }

        if (typeof messageOrConfig === 'string') {
            return await this.reply(
                ComponentV2Factory.createStandardMessage('success', {
                    title: '成功',
                    message: messageOrConfig
                })
            );
        }

        return await this.reply(ComponentV2Factory.createStandardMessage('success', messageOrConfig));
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

    /**
     * 使用 ApiClient 发送消息（经过速率限制和监控）
     * @param {import('discord.js').TextChannel} channel - 目标频道
     * @param {Object} options - 消息选项
     * @returns {Promise<import('discord.js').Message>}
     */
    async sendMessage(channel, options) {
        if (this.apiClient) {
            return await this.apiClient.call('sendMessage', channel, options);
        }
        // 降级到直接调用
        return await channel.send(options);
    }

    /**
     * 使用 ApiClient 编辑消息
     * @param {import('discord.js').Message} message - 消息对象
     * @param {Object} options - 编辑选项
     * @returns {Promise<import('discord.js').Message>}
     */
    async editMessage(message, options) {
        if (this.apiClient) {
            return await this.apiClient.call('editMessage', message, options);
        }
        return await message.edit(options);
    }

    /**
     * 使用 ApiClient 删除消息
     * @param {import('discord.js').Message} message - 消息对象
     * @returns {Promise<void>}
     */
    async deleteMessage(message) {
        if (this.apiClient) {
            return await this.apiClient.call('deleteMessage', message);
        }
        return await message.delete();
    }

    /**
     * 使用 ApiClient 添加角色
     * @param {import('discord.js').GuildMember} member - 成员对象
     * @param {import('discord.js').Role} role - 角色对象
     * @param {string} reason - 原因
     * @returns {Promise<import('discord.js').GuildMember>}
     */
    async addRole(member, role, reason) {
        if (this.apiClient) {
            return await this.apiClient.call('addRole', member, role, reason);
        }
        return await member.roles.add(role, reason);
    }

    /**
     * 使用 ApiClient 移除角色
     * @param {import('discord.js').GuildMember} member - 成员对象
     * @param {import('discord.js').Role} role - 角色对象
     * @param {string} reason - 原因
     * @returns {Promise<import('discord.js').GuildMember>}
     */
    async removeRole(member, role, reason) {
        if (this.apiClient) {
            return await this.apiClient.call('removeRole', member, role, reason);
        }
        return await member.roles.remove(role, reason);
    }

    /**
     * 使用 ApiClient 归档线程
     * @param {import('discord.js').ThreadChannel} thread - 线程对象
     * @param {boolean} archived - 是否归档
     * @param {string} reason - 原因
     * @returns {Promise<import('discord.js').ThreadChannel>}
     */
    async setArchived(thread, archived, reason) {
        if (this.apiClient) {
            return await this.apiClient.call('setArchived', thread, archived, reason);
        }
        return await thread.setArchived(archived, reason);
    }

    /**
     * 使用 ApiClient 锁定线程
     * @param {import('discord.js').ThreadChannel} thread - 线程对象
     * @param {boolean} locked - 是否锁定
     * @param {string} reason - 原因
     * @returns {Promise<import('discord.js').ThreadChannel>}
     */
    async setLocked(thread, locked, reason) {
        if (this.apiClient) {
            return await this.apiClient.call('setLocked', thread, locked, reason);
        }
        return await thread.setLocked(locked, reason);
    }
}

/**
 * 命令上下文
 */
export class CommandContext extends Context {
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
