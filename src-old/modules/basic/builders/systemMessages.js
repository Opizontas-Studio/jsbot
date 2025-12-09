import { ComponentV2Factory } from '../../../shared/factories/ComponentV2Factory.js';

/**
 * 系统消息构建器
 * 包含消息文本定义和消息构建逻辑
 */
export class SystemMessageBuilder {
    // ==================== 消息文本定义 ====================

    static MESSAGES = {
        // 命令同步
        sync: {
            checking: {
                title: '正在检查命令同步状态...'
            },
            error: error => ({
                title: '同步失败',
                message: `**错误**: ${error}`
            })
        },

        // 模块重载
        reload: {
            progress: (moduleName, scope) => ({
                title: '正在重载模块...',
                message: `模块: \`${moduleName}\`\n范围: ${scope === 'all' ? '完全重载' : '仅重载 Builders'}`
            }),
            error: (moduleName, error) => ({
                title: '重载失败',
                message: `**模块**: \`${moduleName}\`\n**错误**: ${error}`
            }),
            confirmation: (moduleName, scope, hasActiveOps = false) => {
                let message = `**你确定要重载 \`${moduleName}\` 模块吗？**\n\n`;
                message += `**重载范围**: ${scope === 'all' ? '完全重载（服务+配置）' : '仅重载 Builders'}\n\n`;

                if (hasActiveOps) {
                    message += '❌ **警告：检测到活跃操作！**\n';
                    message += '该模块当前有正在执行的命令。\n';
                    message += '强制重载可能导致这些操作失败。\n\n';
                }

                message += '⚠️ 这将导致：\n';
                if (scope === 'all') {
                    message += '• 清除该模块的所有服务实例\n';
                    message += '• 清除该模块的所有注册信息\n';
                }
                message += '• 重新加载该模块的代码\n';
                message += '• 旧代码的引用可能导致内存泄漏\n\n';
                message += '✅ 适用场景：\n';
                message += '• 修复了模块的 bug\n';
                message += '• 更新了消息文本/UI\n';
                message += '• 调整了命令逻辑\n\n';
                message += '*⚠️ 如有命令变更，重载后需执行 `/系统 同步指令`*';

                return message;
            }
        },

        // 重启
        restart: {
            progress: {
                title: 'Bot 正在重启...',
                message: '预计 5-10 秒后恢复在线'
            },
            confirmation: () =>
                '**你确定要重启 Bot 吗？**\n\n' +
                '⚠️ 这将导致：\n' +
                '• Bot 短暂离线（约 5-10 秒）\n' +
                '• 所有运行中的操作被中断\n' +
                '• 内存状态完全重置\n\n' +
                '✅ 适用场景：\n' +
                '• 更新了核心代码\n' +
                '• 内存泄漏需要清理\n' +
                '• 严重错误需要重启\n\n' +
                '*请在确认前通知其他管理员*'
        },

        // 配置重载
        config: {
            progress: guildId => ({
                title: '正在重载配置...',
                message: `服务器 ID: \`${guildId}\``
            }),
            error: (guildId, error) => ({
                title: '配置重载失败',
                message: `**服务器 ID**: \`${guildId}\`\n**错误**: ${error}`
            }),
            confirmation: guildId =>
                `**你确定要重载当前服务器的配置文件吗？**\n\n` +
                `**服务器 ID**: \`${guildId}\`\n` +
                `**配置文件**: \`config/guilds/${guildId}.json\`\n\n` +
                `⚠️ 这将导致：\n` +
                `• 从磁盘重新读取配置文件\n` +
                `• 清除该服务器的配置缓存\n` +
                `• 新的交互立即使用新配置\n\n` +
                `✅ 适用场景：\n` +
                `• 手动修改了配置文件\n` +
                `• 更新了角色/频道 ID\n` +
                `• 调整了服务器设置\n\n` +
                `📝 **注意**: 正在执行中的命令不会受影响（它们持有旧配置的引用）`
        }
    };

    // ==================== 消息构建方法 ====================
    /**
     * 格式化统计信息
     * @private
     */
    static _formatStats(stats, labels) {
        const items = [];
        for (const [key, value] of Object.entries(stats)) {
            if (value > 0) {
                const label = labels[key] || key;
                items.push(`${label} ${value}`);
            }
        }
        return items.join(', ');
    }

    // ==================== 命令同步消息 ====================

    /**
     * 创建命令已是最新状态消息
     * 保留此方法因为有语义清晰的参数结构
     */
    static createSyncUpToDate({ localTotal, deployedTotal }) {
        return ComponentV2Factory.createStandardMessage('success', {
            title: '命令已是最新状态',
            message: [`本地命令数: ${localTotal}`, `已部署命令数: ${deployedTotal}`, '', '无需同步。']
        });
    }

    /**
     * 创建同步完成消息
     * 保留此方法因为有复杂的条件拼接逻辑
     */
    static createSyncCompleted({ duration, localTotal, deleted = [], updated = [], added = [] }) {
        const details = [`**执行时长**: ${duration}秒`, `**本地命令数**: ${localTotal}`];

        if (deleted.length > 0) {
            details.push(`\n**已删除 ${deleted.length} 个命令**:`);
            details.push(deleted.map(name => `• ${name}`).join('\n'));
        }

        if (added.length > 0) {
            details.push(`\n**已添加 ${added.length} 个命令**:`);
            details.push(added.map(name => `• ${name}`).join('\n'));
        }

        if (updated.length > 0) {
            details.push(`\n**已更新 ${updated.length} 个命令**:`);
            details.push(updated.map(name => `• ${name}`).join('\n'));
        }

        return ComponentV2Factory.createStandardMessage('success', {
            title: '命令同步完成',
            message: details
        });
    }

    // ==================== 模块重载消息 ====================

    /**
     * 创建重载成功消息
     * 保留此方法因为有复杂的统计格式化逻辑
     */
    static createReloadSuccess({ module, scope, duration, cleared, loaded }) {
        const details = [
            `**模块**: \`${module}\``,
            `**范围**: ${scope === 'all' ? '完全重载' : '仅重载 Builders'}`,
            `**耗时**: ${duration}秒`
        ];

        // 格式化清除统计
        const clearedStats = this._formatStats(cleared, {
            services: '服务',
            commands: '命令',
            buttons: '按钮',
            selectMenus: '选择菜单',
            modals: '模态框',
            events: '事件',
            tasks: '任务'
        });

        if (clearedStats) {
            details.push(`\n**已清除**: ${clearedStats}`);
        }

        // 格式化加载统计
        const loadedStats = this._formatStats(loaded, {
            services: '服务',
            commands: '命令',
            buttons: '按钮',
            selectMenus: '选择菜单',
            modals: '模态框',
            events: '事件',
            tasks: '任务'
        });

        if (loadedStats) {
            details.push(`**已加载**: ${loadedStats}`);
        }

        return ComponentV2Factory.createStandardMessage('success', {
            title: '模块重载成功',
            message: details
        });
    }

    // ==================== 配置重载消息 ====================

    /**
     * 创建配置重载成功消息
     * 保留此方法因为有条件分支逻辑
     */
    static createConfigReloadSuccess(guildId, hasConfig) {
        const details = [
            `**服务器 ID**: \`${guildId}\``,
            `**配置文件**: \`config/guilds/${guildId}.json\``,
            `**状态**: ${hasConfig ? '✅ 已加载' : '⚠️ 文件不存在（使用默认配置）'}`
        ];

        if (hasConfig) {
            details.push('', '配置已成功重载，新的交互将使用更新后的配置。');
        } else {
            details.push('', '⚠️ 配置文件不存在，服务器将使用默认配置（如有）。');
        }

        return ComponentV2Factory.createStandardMessage('success', {
            title: '配置重载成功',
            message: details
        });
    }
}
