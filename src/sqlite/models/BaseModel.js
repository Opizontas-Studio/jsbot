import { logTime } from '../../utils/logger.js';
import { dbManager } from '../dbManager.js';

/**
 * 基础模型类
 * 提供通用的数据库操作和缓存管理
 */
class BaseModel {
    /**
     * 获取表名（子类必须重写）
     * @returns {string} 表名
     */
    static get tableName() {
        throw new Error('子类必须实现 tableName getter');
    }

    /**
     * 获取缓存键前缀（子类可重写）
     * @returns {string} 缓存键前缀
     */
    static get cachePrefix() {
        return this.tableName;
    }

    /**
     * 获取需要解析为JSON的字段列表（子类可重写）
     * @returns {Array<string>} JSON字段列表
     */
    static get jsonFields() {
        return [];
    }

    /**
     * 获取需要解析为数组的字段列表（子类可重写）
     * @returns {Array<string>} 数组字段列表
     */
    static get arrayFields() {
        return [];
    }

    /**
     * 获取需要转换为布尔值的字段列表（子类可重写）
     * @returns {Array<string>} 布尔字段列表
     */
    static get booleanFields() {
        return [];
    }

    /**
     * 获取需要转换为数字的字段列表（子类可重写）
     * @returns {Array<string>} 数字字段列表
     */
    static get numberFields() {
        return [];
    }

    /**
     * 生成缓存键
     * @param {string} suffix - 缓存键后缀
     * @returns {string} 完整缓存键
     */
    static getCacheKey(suffix) {
        return `${this.cachePrefix}_${suffix}`;
    }

    /**
     * 从缓存获取数据
     * @param {string} key - 缓存键
     * @returns {any|null} 缓存数据
     */
    static getCache(key) {
        return dbManager.getCache(key);
    }

    /**
     * 设置缓存
     * @param {string} key - 缓存键
     * @param {any} data - 要缓存的数据
     */
    static setCache(key, data) {
        dbManager.setCache(key, data);
    }

    /**
     * 清除缓存
     * @param {string} key - 缓存键
     */
    static clearCache(key) {
        dbManager.clearCache(key);
    }

    /**
     * 尝试解析JSON字符串
     * @param {string|Object|Array} data - 要解析的数据
     * @param {string|Array|Object} defaultValue - 默认值
     * @param {string} context - 错误上下文
     * @returns {Object|Array} 解析结果
     */
    static tryParseJSON(data, defaultValue = '{}', context = 'unknown') {
        try {
            if (typeof data === 'string') {
                return JSON.parse(data || JSON.stringify(defaultValue));
            }
            return data || (typeof defaultValue === 'string' ? JSON.parse(defaultValue) : defaultValue);
        } catch (error) {
            logTime(`[${this.tableName}] JSON解析失败 [${context}]: ${error.message}`, true);
            return typeof defaultValue === 'string' ? JSON.parse(defaultValue) : defaultValue;
        }
    }

    /**
     * 解析记录的特殊字段
     * @param {Object} record - 数据库记录
     * @returns {Object} 解析后的记录
     */
    static parseRecord(record) {
        if (!record) {
            return null;
        }

        const parsed = { ...record };

        // 解析JSON字段
        for (const field of this.jsonFields) {
            if (record[field] !== undefined) {
                parsed[field] = this.tryParseJSON(record[field], '{}', field);
            }
        }

        // 解析数组字段
        for (const field of this.arrayFields) {
            if (record[field] !== undefined) {
                parsed[field] = this.tryParseJSON(record[field], '[]', field);
            }
        }

        // 转换布尔字段
        for (const field of this.booleanFields) {
            if (record[field] !== undefined) {
                parsed[field] = Boolean(record[field]);
            }
        }

        // 转换数字字段
        for (const field of this.numberFields) {
            if (record[field] !== undefined && record[field] !== null) {
                parsed[field] = Number(record[field]);
            }
        }

        return parsed;
    }

    /**
     * 通过ID获取记录
     * @param {number} id - 记录ID
     * @returns {Promise<Object|null>} 记录对象
     */
    static async findById(id) {
        const cacheKey = this.getCacheKey(id);
        const cached = this.getCache(cacheKey);
        if (cached) {
            return cached;
        }

        const record = await dbManager.safeExecute('get', `SELECT * FROM ${this.tableName} WHERE id = ?`, [id]);

        if (record) {
            const parsed = this.parseRecord(record);
            this.setCache(cacheKey, parsed);
            return parsed;
        }

        return null;
    }

    /**
     * 通用查询方法
     * @param {string} where - WHERE子句
     * @param {Array} params - 查询参数
     * @param {Object} options - 查询选项
     * @param {string} options.orderBy - 排序字段
     * @param {number} options.limit - 限制数量
     * @param {string} options.cacheKey - 缓存键
     * @returns {Promise<Array>} 记录列表
     */
    static async findAll(where = '', params = [], options = {}) {
        const { orderBy = 'createdAt DESC', limit, cacheKey } = options;

        // 如果提供了缓存键，先尝试从缓存获取
        if (cacheKey) {
            const cached = this.getCache(cacheKey);
            if (cached) {
                return cached;
            }
        }

        let query = `SELECT * FROM ${this.tableName}`;
        if (where) {
            query += ` WHERE ${where}`;
        }
        if (orderBy) {
            query += ` ORDER BY ${orderBy}`;
        }
        if (limit) {
            query += ` LIMIT ${limit}`;
        }

        const records = await dbManager.safeExecute('all', query, params);
        const parsed = records.map(r => this.parseRecord(r));

        // 如果提供了缓存键，缓存结果
        if (cacheKey) {
            this.setCache(cacheKey, parsed);
        }

        return parsed;
    }

    /**
     * 通用查询单条记录
     * @param {string} where - WHERE子句
     * @param {Array} params - 查询参数
     * @param {string} cacheKey - 缓存键
     * @returns {Promise<Object|null>} 记录对象
     */
    static async findOne(where, params = [], cacheKey = null) {
        // 如果提供了缓存键，先尝试从缓存获取
        if (cacheKey) {
            const cached = this.getCache(cacheKey);
            if (cached) {
                return cached;
            }
        }

        const query = `SELECT * FROM ${this.tableName} WHERE ${where}`;
        const record = await dbManager.safeExecute('get', query, params);

        if (record) {
            const parsed = this.parseRecord(record);
            if (cacheKey) {
                this.setCache(cacheKey, parsed);
            }
            return parsed;
        }

        return null;
    }

    /**
     * 创建记录
     * @param {Object} data - 记录数据
     * @returns {Promise<Object>} 创建的记录
     */
    static async create(data) {
        const fields = Object.keys(data);
        const values = Object.values(data);
        const placeholders = fields.map(() => '?').join(', ');

        // 处理JSON和数组字段
        const processedValues = values.map((value, index) => {
            const field = fields[index];
            if (this.jsonFields.includes(field) || this.arrayFields.includes(field)) {
                return typeof value === 'string' ? value : JSON.stringify(value);
            }
            return value;
        });

        const query = `INSERT INTO ${this.tableName} (${fields.join(', ')}) VALUES (${placeholders})`;

        try {
            const result = await dbManager.safeExecute('run', query, processedValues);
            return this.findById(result.lastID);
        } catch (error) {
            logTime(`[${this.tableName}] 创建记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 更新记录
     * @param {number} id - 记录ID
     * @param {Object} updates - 更新数据
     * @returns {Promise<Object>} 更新后的记录
     */
    static async update(id, updates) {
        const fields = Object.keys(updates);
        const values = Object.values(updates);

        // 处理JSON和数组字段
        const processedValues = values.map((value, index) => {
            const field = fields[index];
            if (this.jsonFields.includes(field) || this.arrayFields.includes(field)) {
                return typeof value === 'string' ? value : JSON.stringify(value);
            }
            return value;
        });

        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const query = `UPDATE ${this.tableName} SET ${setClause}, updatedAt = ? WHERE id = ?`;

        try {
            await dbManager.safeExecute('run', query, [...processedValues, Date.now(), id]);
            return this.findById(id);
        } catch (error) {
            logTime(`[${this.tableName}] 更新记录失败: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * 删除记录
     * @param {number} id - 记录ID
     * @returns {Promise<boolean>} 是否成功删除
     */
    static async delete(id) {
        try {
            await dbManager.safeExecute('run', `DELETE FROM ${this.tableName} WHERE id = ?`, [id]);
            return true;
        } catch (error) {
            logTime(`[${this.tableName}] 删除记录失败: ${error.message}`, true);
            return false;
        }
    }

    /**
     * 构建WHERE子句和参数
     * @param {Object} conditions - 条件对象
     * @returns {Object} { where: string, params: Array }
     */
    static buildWhere(conditions) {
        const keys = Object.keys(conditions);
        if (keys.length === 0) {
            return { where: '', params: [] };
        }

        const where = keys.map(key => `${key} = ?`).join(' AND ');
        const params = Object.values(conditions);

        return { where, params };
    }
}

export { BaseModel };

