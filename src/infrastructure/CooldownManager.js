/**
 * 冷却管理器
 * 用于控制命令和组件的执行频率
 */
class CooldownManager {
    constructor() {
        // 存储冷却记录：key -> timestamp
        this.cooldowns = new Map();
    }

    /**
     * 检查是否在冷却期内
     * @param {string} key - 冷却键（通常是 type:id:userId）
     * @param {number} duration - 冷却时长（毫秒）
     * @returns {number} 剩余冷却时间（毫秒），0表示不在冷却期
     */
    check(key, duration) {
        const lastTime = this.cooldowns.get(key);
        if (!lastTime) {
            return 0;
        }

        const elapsed = Date.now() - lastTime;
        return elapsed < duration ? duration - elapsed : 0;
    }

    /**
     * 设置冷却记录
     * @param {string} key - 冷却键
     * @param {number} [timestamp] - 时间戳（默认为当前时间）
     */
    set(key, timestamp = Date.now()) {
        this.cooldowns.set(key, timestamp);
    }

    /**
     * 清除指定键的冷却记录
     * @param {string} key - 冷却键
     * @returns {boolean} 是否成功清除
     */
    clear(key) {
        return this.cooldowns.delete(key);
    }

    /**
     * 清除所有冷却记录
     */
    clearAll() {
        this.cooldowns.clear();
    }

    /**
     * 清除过期的冷却记录（节省内存）
     * @param {number} maxAge - 最大保留时间（毫秒，默认1小时）
     */
    cleanupExpired(maxAge = 3600000) {
        const now = Date.now();
        const keysToDelete = [];

        for (const [key, timestamp] of this.cooldowns.entries()) {
            if (now - timestamp > maxAge) {
                keysToDelete.push(key);
            }
        }

        keysToDelete.forEach(key => this.cooldowns.delete(key));

        return keysToDelete.length;
    }

    /**
     * 获取当前冷却记录数量
     * @returns {number}
     */
    get size() {
        return this.cooldowns.size;
    }
}

export { CooldownManager };

