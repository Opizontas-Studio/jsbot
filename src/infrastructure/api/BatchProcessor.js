/**
 * 批量操作处理器
 * 提供高级批量处理功能，支持分组、重试、进度追踪
 */
export class BatchProcessor {
    /**
     * @param {Object} dependencies - 依赖项
     * @param {Object} dependencies.apiClient - API客户端
     * @param {Object} [dependencies.queueManager] - 队列管理器（可选）
     * @param {Object} [dependencies.logger] - 日志器
     */
    constructor({ apiClient, queueManager = null, logger = null }) {
        this.apiClient = apiClient;
        this.queueManager = queueManager;
        this.logger = logger;
    }

    /**
     * 处理批量操作
     * @param {Object} options - 选项
     * @param {string} options.methodName - API方法名
     * @param {Array} options.items - 要处理的项目数组
     * @param {Function} options.extractor - 参数提取器函数 (item) => [arg1, arg2, ...]
     * @param {Function} [options.progressCallback] - 进度回调 (current, total, result) => {}
     * @param {Function} [options.filter] - 过滤器函数 (item) => boolean
     * @param {number} [options.batchSize=50] - 批次大小
     * @param {number} [options.concurrency=1] - 并发数
     * @param {number} [options.retries=0] - 重试次数
     * @param {number} [options.retryDelay=1000] - 重试延迟（毫秒）
     * @param {boolean} [options.continueOnError=true] - 遇到错误是否继续
     * @returns {Promise<Object>} 处理结果 {success: Array, failed: Array, stats: Object}
     */
    async process(options) {
        const {
            methodName,
            items,
            extractor,
            progressCallback,
            filter,
            batchSize = 50,
            concurrency = 1,
            retries = 0,
            retryDelay = 1000,
            continueOnError = true
        } = options;

        // 过滤项目
        const filteredItems = filter ? items.filter(filter) : items;

        this.logger?.info(`[批量处理] 开始处理 ${filteredItems.length} 个项目 (${methodName})`);

        const results = {
            success: [],
            failed: [],
            stats: {
                total: filteredItems.length,
                processed: 0,
                succeeded: 0,
                failed: 0,
                startTime: Date.now(),
                endTime: null
            }
        };

        // 分批处理
        const batches = this._createBatches(filteredItems, batchSize);

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];

            this.logger?.debug(`[批量处理] 处理第 ${i + 1}/${batches.length} 批 (${batch.length} 个项目)`);

            try {
                const batchResults = await this._processBatch({
                    methodName,
                    batch,
                    extractor,
                    concurrency,
                    retries,
                    retryDelay,
                    continueOnError
                });

                // 记录结果
                for (const result of batchResults) {
                    results.stats.processed++;

                    if (result.success) {
                        results.success.push(result);
                        results.stats.succeeded++;
                    } else {
                        results.failed.push(result);
                        results.stats.failed++;
                    }

                    // 进度回调
                    if (progressCallback) {
                        await progressCallback(
                            results.stats.processed,
                            results.stats.total,
                            result
                        );
                    }
                }
            } catch (error) {
                this.logger?.error(`[批量处理] 批次 ${i + 1} 处理失败:`, error);

                if (!continueOnError) {
                    throw error;
                }
            }
        }

        results.stats.endTime = Date.now();
        results.stats.duration = results.stats.endTime - results.stats.startTime;

        this.logger?.info(`[批量处理] 完成 - 成功: ${results.stats.succeeded}, 失败: ${results.stats.failed}, 耗时: ${results.stats.duration}ms`);

        return results;
    }

    /**
     * 处理单个批次
     * @private
     */
    async _processBatch(options) {
        const {
            methodName,
            batch,
            extractor,
            concurrency,
            retries,
            retryDelay,
            continueOnError
        } = options;

        const results = [];

        // 分组并发处理
        for (let i = 0; i < batch.length; i += concurrency) {
            const group = batch.slice(i, i + concurrency);

            const groupPromises = group.map(async (item) => {
                return await this._processItem({
                    methodName,
                    item,
                    extractor,
                    retries,
                    retryDelay
                });
            });

            const groupResults = await Promise.all(groupPromises);
            results.push(...groupResults);

            // 检查是否需要中断
            if (!continueOnError && groupResults.some(r => !r.success)) {
                break;
            }
        }

        return results;
    }

    /**
     * 处理单个项目（带重试）
     * @private
     */
    async _processItem(options) {
        const { methodName, item, extractor, retries, retryDelay } = options;

        let lastError = null;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const args = extractor(item);
                const result = await this.apiClient.call(methodName, ...args);

                return {
                    success: true,
                    item,
                    result,
                    attempts: attempt + 1
                };
            } catch (error) {
                lastError = error;

                if (attempt < retries) {
                    this.logger?.debug(`[批量处理] 重试 ${attempt + 1}/${retries} - ${error.message}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                }
            }
        }

        return {
            success: false,
            item,
            error: lastError?.message || '未知错误',
            attempts: retries + 1
        };
    }

    /**
     * 创建批次
     * @private
     */
    _createBatches(items, batchSize) {
        const batches = [];
        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }
        return batches;
    }
}
