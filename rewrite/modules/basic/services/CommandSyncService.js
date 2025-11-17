import { REST, Routes } from 'discord.js';

// 服务注册配置（供 Registry 自动扫描）
export const serviceConfig = {
    name: 'basic.commandSyncService',
    factory: (container) => new CommandSyncService({
        logger: container.get('logger')
    })
};

/**
 * 命令同步服务
 * 负责检查和同步Discord命令
 */
export class CommandSyncService {
    constructor({ logger }) {
        this.logger = logger;
    }

    /**
     * 同步命令到指定服务器
     * @param {Object} ctx - 命令上下文
     * @returns {Promise<Object>} 同步结果
     */
    async syncCommands(ctx) {
        const startTime = Date.now();

        // 获取本地命令数据
        const localCommandData = this._buildLocalCommands(ctx.registry);

        // 创建 REST 实例并获取已部署的命令
        const rest = new REST({ version: '10' }).setToken(ctx.client.token);
        const deployedCommands = await rest.get(
            Routes.applicationGuildCommands(
                ctx.client.application.id,
                ctx.interaction.guildId
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
        await this._executeSync(rest, ctx, localCommandData, diff);

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        return {
            unchanged: false,
            duration,
            localTotal: localCommandData.length,
            deleted: diff.toDelete.map(cmd => cmd.name),
            updated: diff.toUpdate.map(cmd => cmd.name),
            added: diff.toAdd.map(cmd => cmd.name)
        };
    }

    /**
     * 构建本地命令数据
     * @private
     */
    _buildLocalCommands(registry) {
        const localCommands = registry.getCommandsForDeploy();
        return localCommands
            .map(config => {
                try {
                    return config.builder ?
                        config.builder().toJSON() :
                        { name: config.name, description: config.description || '命令' };
                } catch (error) {
                    this.logger.error({
                        msg: '命令构建失败',
                        command: config.id,
                        error: error.message
                    });
                    return null;
                }
            })
            .filter(cmd => cmd !== null);
    }

    /**
     * 分析命令差异
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
     * 执行同步操作
     * @private
     */
    async _executeSync(rest, ctx, localCommandData, diff) {
        // 执行删除
        for (const cmd of diff.toDelete) {
            await rest.delete(
                Routes.applicationGuildCommand(
                    ctx.client.application.id,
                    ctx.interaction.guildId,
                    cmd.id
                )
            );
            this.logger.info({
                msg: '已删除命令',
                command: cmd.name,
                guildId: ctx.interaction.guildId
            });
        }

        // 执行更新和添加（通过 PUT 整体替换）
        if (diff.toUpdate.length > 0 || diff.toAdd.length > 0) {
            await rest.put(
                Routes.applicationGuildCommands(
                    ctx.client.application.id,
                    ctx.interaction.guildId
                ),
                { body: localCommandData }
            );
            this.logger.info({
                msg: '命令同步完成',
                updated: diff.toUpdate.length,
                added: diff.toAdd.length,
                guildId: ctx.interaction.guildId
            });
        }
    }
}

