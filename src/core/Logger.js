import { mkdirSync } from 'fs';
import { join } from 'path';
import pino from 'pino';

/**
 * 统一日志器（基于pino）
 * 提供结构化日志和高性能输出
 */
export class Logger {
    constructor(options = {}) {
        const {
            level = process.env.LOG_LEVEL || 'info',
            prettyPrint = process.env.NODE_ENV !== 'production',
            logDir = './logs'
        } = options;

        // 创建日志目录
        try {
            mkdirSync(logDir, { recursive: true });
        } catch (error) {
            if (error.code !== 'EEXIST') {
                console.error(`创建日志目录失败: ${error.message}`);
            }
        }

        // pino配置
        const pinoOptions = {
            level,
            timestamp: pino.stdTimeFunctions.isoTime,
            formatters: {
                level: label => ({ level: label }),
                bindings: bindings => ({
                    pid: bindings.pid,
                    hostname: bindings.hostname
                })
            }
        };

        // 开发环境使用pretty格式
        const transport = prettyPrint
            ? {
                  target: 'pino-pretty',
                  options: {
                      colorize: true,
                      translateTime: 'yyyy/mm/dd HH:MM:ss',
                      ignore: 'pid,hostname',
                      singleLine: false
                  }
              }
            : undefined;

        // 创建logger实例
        this.logger = pino(pinoOptions, transport ? pino.transport(transport) : undefined);

        // 文件日志（生产环境）
        if (!prettyPrint) {
            const fileLogger = pino(
                pinoOptions,
                pino.destination(join(logDir, `${new Date().toISOString().split('T')[0]}.log`))
            );
            this.fileLogger = fileLogger;
        }
    }

    /**
     * 记录info级别日志
     * @param {string|Object} msgOrObj - 消息或对象
     * @param {string} [msg] - 当第一个参数为对象时的消息
     */
    info(msgOrObj, msg) {
        this.logger.info(msgOrObj, msg);
        this.fileLogger?.info(msgOrObj, msg);
    }

    /**
     * 记录error级别日志
     */
    error(msgOrObj, msg) {
        this.logger.error(msgOrObj, msg);
        this.fileLogger?.error(msgOrObj, msg);
    }

    /**
     * 记录warn级别日志
     */
    warn(msgOrObj, msg) {
        this.logger.warn(msgOrObj, msg);
        this.fileLogger?.warn(msgOrObj, msg);
    }

    /**
     * 记录debug级别日志
     */
    debug(msgOrObj, msg) {
        this.logger.debug(msgOrObj, msg);
        this.fileLogger?.debug(msgOrObj, msg);
    }

    /**
     * 记录trace级别日志
     */
    trace(msgOrObj, msg) {
        this.logger.trace(msgOrObj, msg);
        this.fileLogger?.trace(msgOrObj, msg);
    }

    /**
     * 创建子logger（带额外上下文）
     * @param {Object} bindings - 绑定的上下文
     * @returns {Logger}
     */
    child(bindings) {
        const childLogger = new Logger({ level: this.logger.level });
        childLogger.logger = this.logger.child(bindings);
        childLogger.fileLogger = this.fileLogger?.child(bindings);
        return childLogger;
    }

    /**
     * 刷新日志缓冲（优雅关闭时调用）
     */
    async flush() {
        return new Promise(resolve => {
            this.logger.flush(() => {
                this.fileLogger?.flush(resolve) || resolve();
            });
        });
    }
}
