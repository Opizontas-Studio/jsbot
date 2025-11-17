import { defineService } from '../core/Container.js';

/**
 * 活跃操作追踪器
 * 用于追踪正在执行的操作，防止重载时出现问题
 */
export class ActiveOperationTracker {
    static dependencies = ['logger'];

    constructor(deps) {
        Object.assign(this, deps);
        // 存储活跃操作: Map<operationId, { moduleName, commandName, userId, startTime }>
        this.activeOperations = new Map();
    }

    /**
     * 开始追踪操作
     * @param {string} operationId - 操作ID（通常是 interaction.id）
     * @param {Object} info - 操作信息
     * @param {string} info.moduleName - 模块名称
     * @param {string} info.commandName - 命令名称
     * @param {string} info.userId - 用户ID
     */
    startTracking(operationId, { moduleName, commandName, userId }) {
        this.activeOperations.set(operationId, {
            moduleName,
            commandName,
            userId,
            startTime: Date.now()
        });

        this.logger.debug({
            msg: '[ActiveOperationTracker] 开始追踪操作',
            operationId,
            moduleName,
            commandName
        });
    }

    /**
     * 停止追踪操作
     * @param {string} operationId - 操作ID
     */
    stopTracking(operationId) {
        const operation = this.activeOperations.get(operationId);
        if (operation) {
            const duration = Date.now() - operation.startTime;
            this.logger.debug({
                msg: '[ActiveOperationTracker] 停止追踪操作',
                operationId,
                duration: `${duration}ms`
            });
            this.activeOperations.delete(operationId);
        }
    }

    /**
     * 检查模块是否有活跃操作
     * @param {string} moduleName - 模块名称
     * @returns {Array<Object>} 活跃操作列表
     */
    getActiveOperations(moduleName) {
        const operations = [];
        for (const [operationId, operation] of this.activeOperations) {
            if (operation.moduleName === moduleName) {
                operations.push({
                    operationId,
                    ...operation,
                    duration: Date.now() - operation.startTime
                });
            }
        }
        return operations;
    }

    /**
     * 检查是否有任何活跃操作
     * @returns {boolean}
     */
    hasActiveOperations() {
        return this.activeOperations.size > 0;
    }

    /**
     * 获取所有活跃操作
     * @returns {Array<Object>}
     */
    getAllActiveOperations() {
        const operations = [];
        for (const [operationId, operation] of this.activeOperations) {
            operations.push({
                operationId,
                ...operation,
                duration: Date.now() - operation.startTime
            });
        }
        return operations;
    }

    /**
     * 清理超时的操作（超过10分钟）
     */
    cleanupStaleOperations() {
        const timeout = 10 * 60 * 1000; // 10分钟
        const now = Date.now();
        let cleaned = 0;

        for (const [operationId, operation] of this.activeOperations) {
            if (now - operation.startTime > timeout) {
                this.activeOperations.delete(operationId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.logger.info({
                msg: '[ActiveOperationTracker] 清理超时操作',
                cleaned
            });
        }
    }
}

// 服务注册配置
export const serviceConfig = defineService('activeOperationTracker', ActiveOperationTracker);

