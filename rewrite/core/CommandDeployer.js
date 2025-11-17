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
                this.logger.info({
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
            this.logger.info({
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

