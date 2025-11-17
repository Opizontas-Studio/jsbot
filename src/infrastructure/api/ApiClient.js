/**
 * Discord API 客户端
 * 统一包装所有 Discord API 调用，集成速率限制和监控
 */
export class ApiClient {
    /**
     * @param {Object} dependencies - 依赖项
     * @param {Object} dependencies.rateLimiter - 速率限制器
     * @param {Object} [dependencies.callTracker] - API调用追踪器
     * @param {Object} [dependencies.logger] - 日志器
     */
    constructor({ rateLimiter, callTracker = null, logger = null }) {
        this.rateLimiter = rateLimiter;
        this.callTracker = callTracker;
        this.logger = logger;

        // API方法映射
        this.apiMethods = this._buildApiMethodMap();
    }

    /**
     * 构建API方法映射
     * @private
     */
    _buildApiMethodMap() {
        return {
            // 消息操作
            sendMessage: {
                method: 'POST',
                endpoint: '/channels/:channelId/messages',
                handler: async (channel, options) => {
                    return await channel.send(options);
                },
                extractParams: (args) => ({ channelId: args[0]?.id })
            },
            editMessage: {
                method: 'PATCH',
                endpoint: '/channels/:channelId/messages/:messageId',
                handler: async (message, options) => {
                    return await message.edit(options);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.channelId || args[0]?.channel?.id,
                    messageId: args[0]?.id
                })
            },
            deleteMessage: {
                method: 'DELETE',
                endpoint: '/channels/:channelId/messages/:messageId',
                handler: async (message) => {
                    return await message.delete();
                },
                extractParams: (args) => ({
                    channelId: args[0]?.channelId || args[0]?.channel?.id,
                    messageId: args[0]?.id
                })
            },
            fetchMessage: {
                method: 'GET',
                endpoint: '/channels/:channelId/messages/:messageId',
                handler: async (channel, messageId) => {
                    return await channel.messages.fetch(messageId);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id,
                    messageId: args[1]
                })
            },
            fetchMessages: {
                method: 'GET',
                endpoint: '/channels/:channelId/messages',
                handler: async (channel, options = {}) => {
                    return await channel.messages.fetch(options);
                },
                extractParams: (args) => ({ channelId: args[0]?.id })
            },

            // 成员操作
            addRole: {
                method: 'PUT',
                endpoint: '/guilds/:guildId/members/:userId/roles/:roleId',
                handler: async (member, role, reason) => {
                    return await member.roles.add(role, reason);
                },
                extractParams: (args) => ({
                    guildId: args[0]?.guild?.id,
                    userId: args[0]?.id,
                    roleId: args[1]?.id
                })
            },
            removeRole: {
                method: 'DELETE',
                endpoint: '/guilds/:guildId/members/:userId/roles/:roleId',
                handler: async (member, role, reason) => {
                    return await member.roles.remove(role, reason);
                },
                extractParams: (args) => ({
                    guildId: args[0]?.guild?.id,
                    userId: args[0]?.id,
                    roleId: args[1]?.id
                })
            },
            kickMember: {
                method: 'DELETE',
                endpoint: '/guilds/:guildId/members/:userId',
                handler: async (member, reason) => {
                    return await member.kick(reason);
                },
                extractParams: (args) => ({
                    guildId: args[0]?.guild?.id,
                    userId: args[0]?.id
                })
            },
            banMember: {
                method: 'PUT',
                endpoint: '/guilds/:guildId/bans/:userId',
                handler: async (guild, userId, options) => {
                    return await guild.members.ban(userId, options);
                },
                extractParams: (args) => ({
                    guildId: args[0]?.id,
                    userId: args[1]
                })
            },
            unbanMember: {
                method: 'DELETE',
                endpoint: '/guilds/:guildId/bans/:userId',
                handler: async (guild, userId, reason) => {
                    return await guild.members.unban(userId, reason);
                },
                extractParams: (args) => ({
                    guildId: args[0]?.id,
                    userId: args[1]
                })
            },

            // 线程操作
            addThreadMember: {
                method: 'PUT',
                endpoint: '/channels/:channelId/thread-members/:userId',
                handler: async (thread, userId) => {
                    return await thread.members.add(userId);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id,
                    userId: args[1]
                })
            },
            removeThreadMember: {
                method: 'DELETE',
                endpoint: '/channels/:channelId/thread-members/:userId',
                handler: async (thread, userId) => {
                    return await thread.members.remove(userId);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id,
                    userId: args[1]
                })
            },
            fetchThreadMembers: {
                method: 'GET',
                endpoint: '/channels/:channelId/thread-members',
                handler: async (thread) => {
                    return await thread.members.fetch();
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id
                })
            },

            // 频道操作
            createChannel: {
                method: 'POST',
                endpoint: '/guilds/:guildId/channels',
                handler: async (guild, options) => {
                    return await guild.channels.create(options);
                },
                extractParams: (args) => ({ guildId: args[0]?.id })
            },
            deleteChannel: {
                method: 'DELETE',
                endpoint: '/channels/:channelId',
                handler: async (channel) => {
                    return await channel.delete();
                },
                extractParams: (args) => ({ channelId: args[0]?.id })
            },

            // 反应操作
            addReaction: {
                method: 'PUT',
                endpoint: '/channels/:channelId/messages/:messageId/reactions/:emoji/@me',
                handler: async (message, emoji) => {
                    return await message.react(emoji);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.channelId || args[0]?.channel?.id,
                    messageId: args[0]?.id
                })
            },
            removeReaction: {
                method: 'DELETE',
                endpoint: '/channels/:channelId/messages/:messageId/reactions/:emoji/@me',
                handler: async (reaction, user) => {
                    return await reaction.users.remove(user);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.message?.channelId,
                    messageId: args[0]?.message?.id
                })
            },

            // 交互操作（这些方法跳过速率限制）
            reply: {
                method: 'POST',
                endpoint: '/interactions/:id/:token/callback',
                skipRateLimit: true,
                handler: async (interaction, options) => {
                    return await interaction.reply(options);
                },
                extractParams: (args) => ({
                    id: args[0]?.id,
                    token: args[0]?.token
                })
            },
            editReply: {
                method: 'PATCH',
                endpoint: '/webhooks/:applicationId/:token/messages/@original',
                skipRateLimit: true,
                handler: async (interaction, options) => {
                    return await interaction.editReply(options);
                },
                extractParams: (args) => ({
                    applicationId: args[0]?.applicationId,
                    token: args[0]?.token
                })
            },
            deferReply: {
                method: 'POST',
                endpoint: '/interactions/:id/:token/callback',
                skipRateLimit: true,
                handler: async (interaction, options) => {
                    return await interaction.deferReply(options);
                },
                extractParams: (args) => ({
                    id: args[0]?.id,
                    token: args[0]?.token
                })
            },
            followUp: {
                method: 'POST',
                endpoint: '/webhooks/:applicationId/:token',
                handler: async (interaction, options) => {
                    return await interaction.followUp(options);
                },
                extractParams: (args) => ({
                    applicationId: args[0]?.applicationId,
                    token: args[0]?.token
                })
            },
            deferUpdate: {
                method: 'POST',
                endpoint: '/interactions/:id/:token/callback',
                skipRateLimit: true,
                handler: async (interaction, options) => {
                    return await interaction.deferUpdate(options);
                },
                extractParams: (args) => ({
                    id: args[0]?.id,
                    token: args[0]?.token
                })
            },
            updateInteraction: {
                method: 'POST',
                endpoint: '/interactions/:id/:token/callback',
                skipRateLimit: true,
                handler: async (interaction, options) => {
                    return await interaction.update(options);
                },
                extractParams: (args) => ({
                    id: args[0]?.id,
                    token: args[0]?.token
                })
            },

            // 线程/频道修改操作
            setArchived: {
                method: 'PATCH',
                endpoint: '/channels/:channelId',
                handler: async (thread, archived, reason) => {
                    return await thread.setArchived(archived, reason);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id
                })
            },
            setLocked: {
                method: 'PATCH',
                endpoint: '/channels/:channelId',
                handler: async (thread, locked, reason) => {
                    return await thread.setLocked(locked, reason);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id
                })
            },
            setName: {
                method: 'PATCH',
                endpoint: '/channels/:channelId',
                handler: async (channel, name, reason) => {
                    return await channel.setName(name, reason);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id
                })
            },
            setTopic: {
                method: 'PATCH',
                endpoint: '/channels/:channelId',
                handler: async (channel, topic, reason) => {
                    return await channel.setTopic(topic, reason);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id
                })
            },
            setRateLimitPerUser: {
                method: 'PATCH',
                endpoint: '/channels/:channelId',
                handler: async (channel, rateLimitPerUser, reason) => {
                    return await channel.setRateLimitPerUser(rateLimitPerUser, reason);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id
                })
            },
            pinThread: {
                method: 'PATCH',
                endpoint: '/channels/:channelId',
                handler: async (thread, reason) => {
                    return await thread.pin(reason);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id
                })
            },
            unpinThread: {
                method: 'PATCH',
                endpoint: '/channels/:channelId',
                handler: async (thread, reason) => {
                    return await thread.unpin(reason);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id
                })
            },
            editChannel: {
                method: 'PATCH',
                endpoint: '/channels/:channelId',
                handler: async (channel, options) => {
                    return await channel.edit(options);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id
                })
            },

            // 用户操作
            fetchUser: {
                method: 'GET',
                endpoint: '/users/:userId',
                handler: async (client, userId) => {
                    return await client.users.fetch(userId);
                },
                extractParams: (args) => ({
                    userId: args[1]
                })
            },
            sendDM: {
                method: 'POST',
                endpoint: '/channels/:channelId/messages',
                handler: async (user, options) => {
                    return await user.send(options);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.dmChannel?.id || 'dm'
                })
            },

            // Guild 操作
            fetchGuild: {
                method: 'GET',
                endpoint: '/guilds/:guildId',
                handler: async (client, guildId, options) => {
                    return await client.guilds.fetch(guildId, options);
                },
                extractParams: (args) => ({
                    guildId: args[1]
                })
            },
            fetchMember: {
                method: 'GET',
                endpoint: '/guilds/:guildId/members/:userId',
                handler: async (guild, userId, options) => {
                    return await guild.members.fetch(userId, options);
                },
                extractParams: (args) => ({
                    guildId: args[0]?.id,
                    userId: args[1]
                })
            },
            fetchBan: {
                method: 'GET',
                endpoint: '/guilds/:guildId/bans/:userId',
                handler: async (guild, userId) => {
                    return await guild.bans.fetch(userId);
                },
                extractParams: (args) => ({
                    guildId: args[0]?.id,
                    userId: args[1]
                })
            },
            fetchBans: {
                method: 'GET',
                endpoint: '/guilds/:guildId/bans',
                handler: async (guild, options) => {
                    return await guild.bans.fetch(options);
                },
                extractParams: (args) => ({
                    guildId: args[0]?.id
                })
            },

            // 频道获取操作
            fetchChannel: {
                method: 'GET',
                endpoint: '/channels/:channelId',
                handler: async (client, channelId) => {
                    return await client.channels.fetch(channelId);
                },
                extractParams: (args) => ({
                    channelId: args[1]
                })
            },
            fetchActiveThreads: {
                method: 'GET',
                endpoint: '/guilds/:guildId/threads/active',
                handler: async (guild) => {
                    return await guild.channels.fetchActiveThreads();
                },
                extractParams: (args) => ({
                    guildId: args[0]?.id
                })
            },

            // 消息批量操作
            bulkDelete: {
                method: 'POST',
                endpoint: '/channels/:channelId/messages/bulk-delete',
                handler: async (channel, messages, filterOld) => {
                    return await channel.bulkDelete(messages, filterOld);
                },
                extractParams: (args) => ({
                    channelId: args[0]?.id
                })
            }
        };
    }

    /**
     * 提取路由参数
     * @private
     */
    _extractParams(apiMethod, args) {
        return apiMethod.extractParams?.(args) || {};
    }

    /**
     * 记录API调用统计
     * @private
     */
    _recordCallStats(methodName, apiMethod, success, duration, error = null) {
        if (!this.callTracker) return;

        const record = {
            methodName,
            httpMethod: apiMethod.method,
            endpoint: apiMethod.endpoint,
            success,
            duration
        };

        if (error) {
            record.error = error;
        }

        this.callTracker.recordCall(record);
    }

    /**
     * 调用API方法
     * @param {string} methodName - API方法名
     * @param {...any} args - 方法参数
     * @returns {Promise<any>} API返回值
     */
    async call(methodName, ...args) {
        const apiMethod = this.apiMethods[methodName];
        if (!apiMethod) {
            throw new Error(`未知的API方法: ${methodName}`);
        }

        const startTime = Date.now();

        try {
            // 提取路由参数
            const params = this._extractParams(apiMethod, args);

            // 等待速率限制（除非明确跳过）
            if (!apiMethod.skipRateLimit) {
                await this.rateLimiter.waitForRateLimit(apiMethod.method, apiMethod.endpoint, params);
            }

            // 执行API调用
            const result = await apiMethod.handler(...args);

            // 记录调用统计
            const duration = Date.now() - startTime;
            this._recordCallStats(methodName, apiMethod, true, duration);

            this.logger?.debug(`[API] ${methodName} - 成功 (${duration}ms)`);

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;

            // 记录调用统计
            this._recordCallStats(methodName, apiMethod, false, duration, error.message);

            this.logger?.error(`[API] ${methodName} - 失败 (${duration}ms):`, error);

            throw error;
        }
    }

    /**
     * 获取可用的API方法列表
     * @returns {Array<string>} 方法名列表
     */
    getAvailableMethods() {
        return Object.keys(this.apiMethods);
    }

    /**
     * 检查方法是否存在
     * @param {string} methodName - 方法名
     * @returns {boolean} 是否存在
     */
    hasMethod(methodName) {
        return methodName in this.apiMethods;
    }
}
