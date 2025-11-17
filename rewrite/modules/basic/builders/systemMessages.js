import { ComponentV2Factory } from '../../../shared/factories/ComponentV2Factory.js';

/**
 * 系统消息构建器
 * 统一管理所有系统相关的消息（同步、重载、重启）
 */
export class SystemMessageBuilder {
    // ==================== 通用消息构建方法 ====================

    /**
     * 创建进行中消息
     * @private
     */
    static _createProgressMessage(title, details) {
        const container = ComponentV2Factory.createContainer(
            ComponentV2Factory.Colors.INFO
        );
        ComponentV2Factory.addText(container, `⏳ **${title}**\n\n${details}`);
        return ComponentV2Factory.createMessage(container);
    }

    /**
     * 创建成功消息
     * @private
     */
    static _createSuccessMessage(title, details) {
        const container = ComponentV2Factory.createContainer(
            ComponentV2Factory.Colors.SUCCESS
        );
        ComponentV2Factory.addHeading(container, `✅ ${title}`, 2);
        ComponentV2Factory.addText(container, details.join('\n'));
        return ComponentV2Factory.createMessage(container);
    }

    /**
     * 创建错误消息
     * @private
     */
    static _createErrorMessage(title, error, context = null) {
        const container = ComponentV2Factory.createContainer(
            ComponentV2Factory.Colors.ERROR
        );
        ComponentV2Factory.addHeading(container, `❌ ${title}`, 2);

        let message = '';
        if (context) {
            message += `**${context}**\n`;
        }
        message += `**错误**: ${error}`;

        ComponentV2Factory.addText(container, message);
        return ComponentV2Factory.createMessage(container);
    }

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
     * 创建同步检查中消息
     */
    static createSyncChecking() {
        return this._createProgressMessage(
            '正在检查命令同步状态...',
            ''
        );
    }

    /**
     * 创建命令已是最新状态消息
     */
    static createSyncUpToDate({ localTotal, deployedTotal }) {
        return this._createSuccessMessage(
            '命令已是最新状态',
            [
                `本地命令数: ${localTotal}`,
                `已部署命令数: ${deployedTotal}`,
                '',
                '无需同步。'
            ]
        );
    }

    /**
     * 创建同步完成消息
     */
    static createSyncCompleted({ duration, localTotal, deleted = [], updated = [], added = [] }) {
        const details = [
            `**执行时长**: ${duration}秒`,
            `**本地命令数**: ${localTotal}`
        ];

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

        return this._createSuccessMessage('命令同步完成', details);
    }

    /**
     * 创建同步错误消息
     */
    static createSyncError(error) {
        return this._createErrorMessage('同步失败', error);
    }

    // ==================== 模块重载消息 ====================

    /**
     * 创建重载中消息
     */
    static createReloadProgress(moduleName, scope) {
        return this._createProgressMessage(
            '正在重载模块...',
            `模块: \`${moduleName}\`\n` +
            `范围: ${scope === 'all' ? '完全重载' : '仅重载 Builders'}`
        );
    }

    /**
     * 创建重载成功消息
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

        return this._createSuccessMessage('模块重载成功', details);
    }

    /**
     * 创建重载错误消息
     */
    static createReloadError(moduleName, error) {
        return this._createErrorMessage('重载失败', error, `模块: \`${moduleName}\``);
    }

    /**
     * 创建重载确认消息文本
     * @returns {string} 确认消息文本
     */
    static createReloadConfirmation(moduleName, scope, hasActiveOps = false) {
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

    // ==================== 重启消息 ====================

    /**
     * 创建重启确认消息文本
     * @returns {string} 确认消息文本
     */
    static createRestartConfirmation() {
        const message =
            '**你确定要重启 Bot 吗？**\n\n' +
            '⚠️ 这将导致：\n' +
            '• Bot 短暂离线（约 5-10 秒）\n' +
            '• 所有运行中的操作被中断\n' +
            '• 内存状态完全重置\n\n' +
            '✅ 适用场景：\n' +
            '• 更新了核心代码\n' +
            '• 内存泄漏需要清理\n' +
            '• 严重错误需要重启\n\n' +
            '*请在确认前通知其他管理员*';

        return message;
    }

    /**
     * 创建重启中消息
     */
    static createRestarting() {
        return this._createProgressMessage(
            'Bot 正在重启...',
            '预计 5-10 秒后恢复在线'
        );
    }

    // ==================== 配置重载消息 ====================

    /**
     * 创建配置重载确认消息文本
     * @returns {string} 确认消息文本
     */
    static createConfigReloadConfirmation(guildId) {
        const message =
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
            `📝 **注意**: 正在执行中的命令不会受影响（它们持有旧配置的引用）`;

        return message;
    }

    /**
     * 创建配置重载中消息
     */
    static createConfigReloadProgress(guildId) {
        return this._createProgressMessage(
            '正在重载配置...',
            `服务器 ID: \`${guildId}\``
        );
    }

    /**
     * 创建配置重载成功消息
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

        return this._createSuccessMessage('配置重载成功', details);
    }

    /**
     * 创建配置重载错误消息
     */
    static createConfigReloadError(guildId, error) {
        return this._createErrorMessage(
            '配置重载失败',
            error,
            `服务器 ID: \`${guildId}\``
        );
    }
}
