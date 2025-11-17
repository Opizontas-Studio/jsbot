import { REST, Routes } from 'discord.js';

/**
 * 命令部署器
 * 负责将命令部署到Discord服务器
 */
class CommandDeployer {
    constructor(container, logger) {
        this.container = container;
        this.logger = logger;
        this.config = container.get('config');
        this.client = container.get('client');
        this.registry = container.get('registry');
    }

    /**
     * 部署命令到所有服务器
     * 只部署有配置文件且未标记commandsDeployed的服务器
     * @returns {Promise<Object>} 部署统计信息
     */
    async deployToAllGuilds() {
        try {
            const commands = this.registry.getCommandsForDeploy();
            if (commands.length === 0) {
                this.logger.info('[CommandDeploy] 没有需要部署的命令');
                return { deployed: 0, skipped: 0, failed: 0, total: 0, noConfig: 0 };
            }

            this.logger.info({
                msg: '[CommandDeploy] 准备部署命令',
                count: commands.length
            });

            // 构建命令数据
            const commandData = this._buildCommandData(commands);

            // 创建REST客户端
            const rest = new REST({ version: '10' }).setToken(this.config.token);

            // 遍历所有服务器，只处理有配置文件的
            const guilds = this.client.guilds.cache;
            const configManager = this.container.get('configManager');
            const stats = {
                deployed: 0,
                skipped: 0,
                failed: 0,
                noConfig: 0,
                total: guilds.size
            };

            for (const [guildId, guild] of guilds) {
                // 检查是否有配置文件
                const guildConfig = configManager.getGuild(guildId);
                if (!guildConfig) {
                    this.logger.debug({
                        msg: '[CommandDeploy] 服务器无配置文件，跳过部署',
                        guildId,
                        guildName: guild.name
                    });
                    stats.noConfig++;
                    continue;
                }

                const result = await this._deployToGuild(rest, guildId, guild.name, commandData, guildConfig);
                stats[result]++;

                // 避免速率限制
                if (result === 'deployed') {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            // 记录部署摘要
            this.logger.info({
                msg: '[CommandDeploy] 命令部署完成',
                deployed: stats.deployed,
                skipped: stats.skipped,
                failed: stats.failed,
                noConfig: stats.noConfig,
                total: stats.total
            });

            if (stats.noConfig > 0) {
                this.logger.debug({
                    msg: '[CommandDeploy] 提示：部分服务器无配置文件，已跳过部署',
                    count: stats.noConfig
                });
            }

            if (stats.deployed > 0) {
                this.logger.warn({
                    msg: '[CommandDeploy] 提示：将 commandsDeployed: true 添加到服务器配置以跳过下次部署'
                });
            }

            return stats;
        } catch (error) {
            this.logger.error({
                msg: '[CommandDeploy] 命令部署过程出错',
                error: error.message,
                stack: error.stack
            });
            // 不抛出错误，继续启动
            return { deployed: 0, skipped: 0, failed: 0, total: 0, noConfig: 0, error: error.message };
        }
    }

    /**
     * 同步命令到指定服务器（运行时调用）
     * 会检测差异并执行增量同步：删除、更新、添加
     * @param {string} guildId - 服务器ID
     * @param {string} clientToken - 客户端Token（可选，默认使用config中的token）
     * @returns {Promise<Object>} 同步结果
     */
    async syncCommandsToGuild(guildId, clientToken = null) {
        const startTime = Date.now();

        try {
            // 获取本地命令数据
            const localCommandData = this._buildCommandData(this.registry.getCommandsForDeploy());

            // 创建 REST 实例并获取已部署的命令
            const rest = new REST({ version: '10' }).setToken(clientToken || this.config.token);
            const deployedCommands = await rest.get(
                Routes.applicationGuildCommands(
                    this.config.bot.clientId,
                    guildId
                )
            );

            // 分析差异
            const diff = this._analyzeCommandDiff(localCommandData, deployedCommands);

            // 如果没有变化
            if (diff.noChanges) {
                return {
                    unchanged: true,
                    localTotal: localCommandData.length,
                    deployedTotal: deployedCommands.length
                };
            }

            // 执行同步
            await this._executeSyncToGuild(rest, guildId, localCommandData, diff);

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);

            return {
                unchanged: false,
                duration,
                localTotal: localCommandData.length,
                deleted: diff.toDelete.map(cmd => cmd.name),
                updated: diff.toUpdate.map(cmd => cmd.name),
                added: diff.toAdd.map(cmd => cmd.name)
            };
        } catch (error) {
            this.logger.error({
                msg: '[CommandDeploy] 命令同步失败',
                guildId,
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * 构建命令数据
     * @param {Array} commands - 命令配置数组
     * @returns {Array} 命令数据数组
     * @private
     */
    _buildCommandData(commands) {
        const commandData = [];
        for (const config of commands) {
            try {
                const data = config.builder ?
                    config.builder().toJSON() :
                    { name: config.name, description: config.description || '命令' };
                commandData.push(data);
            } catch (error) {
                this.logger.error({
                    msg: '[CommandDeploy] 命令构建失败',
                    command: config.id,
                    error: error.message
                });
            }
        }
        return commandData;
    }

    /**
     * 分析命令差异
     * @param {Array} localCommandData - 本地命令数据
     * @param {Array} deployedCommands - 已部署的命令
     * @returns {Object} 差异信息
     * @private
     */
    _analyzeCommandDiff(localCommandData, deployedCommands) {
        const toDelete = [];
        const toUpdate = [];
        const toAdd = [];

        // 检查已部署的命令
        for (const deployedCmd of deployedCommands) {
            const localCmd = localCommandData.find(cmd => cmd.name === deployedCmd.name);
            if (!localCmd) {
                toDelete.push(deployedCmd);
            } else if (JSON.stringify(deployedCmd) !== JSON.stringify(localCmd)) {
                toUpdate.push(localCmd);
            }
        }

        // 检查本地新增的命令
        for (const localCmd of localCommandData) {
            if (!deployedCommands.some(cmd => cmd.name === localCmd.name)) {
                toAdd.push(localCmd);
            }
        }

        return {
            toDelete,
            toUpdate,
            toAdd,
            noChanges: toDelete.length === 0 && toUpdate.length === 0 && toAdd.length === 0
        };
    }

    /**
     * 执行同步操作到指定服务器
     * @param {REST} rest - Discord REST客户端
     * @param {string} guildId - 服务器ID
     * @param {Array} localCommandData - 本地命令数据
     * @param {Object} diff - 差异信息
     * @private
     */
    async _executeSyncToGuild(rest, guildId, localCommandData, diff) {
        // 执行删除
        for (const cmd of diff.toDelete) {
            await rest.delete(
                Routes.applicationGuildCommand(
                    this.config.bot.clientId,
                    guildId,
                    cmd.id
                )
            );
            this.logger.info({
                msg: '[CommandDeploy] 已删除命令',
                command: cmd.name,
                guildId
            });
        }

        // 执行更新和添加（通过 PUT 整体替换）
        if (diff.toUpdate.length > 0 || diff.toAdd.length > 0) {
            await rest.put(
                Routes.applicationGuildCommands(
                    this.config.bot.clientId,
                    guildId
                ),
                { body: localCommandData }
            );
            this.logger.info({
                msg: '[CommandDeploy] 命令同步完成',
                updated: diff.toUpdate.length,
                added: diff.toAdd.length,
                guildId
            });
        }
    }

    /**
     * 部署到指定服务器
     * @param {REST} rest - Discord REST客户端
     * @param {string} guildId - 服务器ID
     * @param {string} guildName - 服务器名称
     * @param {Array} commandData - 命令数据
     * @param {Object} guildConfig - 服务器配置
     * @returns {Promise<string>} 'deployed' | 'skipped' | 'failed'
     * @private
     */
    async _deployToGuild(rest, guildId, guildName, commandData, guildConfig) {
        // 检查是否已部署
        if (guildConfig.commandsDeployed === true) {
            this.logger.debug({
                msg: '[CommandDeploy] 服务器已部署，跳过',
                guildId,
                guildName
            });
            return 'skipped';
        }

        try {
            this.logger.debug({
                msg: '[CommandDeploy] 正在部署命令到服务器',
                guildId,
                guildName
            });

            const result = await rest.put(
                Routes.applicationGuildCommands(this.config.bot.clientId, guildId),
                { body: commandData }
            );

            this.logger.info({
                msg: '[CommandDeploy] 命令部署成功',
                guildId,
                guildName,
                count: result.length
            });

            return 'deployed';
        } catch (error) {
            this.logger.error({
                msg: '[CommandDeploy] 命令部署失败',
                guildId,
                guildName,
                error: error.message
            });
            return 'failed';
        }
    }
}

export { CommandDeployer };

