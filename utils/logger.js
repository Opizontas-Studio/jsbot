import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import { mkdirSync } from 'fs';

// 创建logs目录（如果不存在）
try {
    mkdirSync('./logs');
} catch (error) {
    if (error.code !== 'EEXIST') {
        process.stderr.write('创建日志目录失败: ' + error.message + '\n');
    }
}

// 创建基础日志格式
const baseFormat = winston.format.printf(({ message, level }) => {
    const prefix = level === 'error' ? '❌ ' : '';
    return `[${new Date().toLocaleString()}] ${prefix}${message}`;
});

// 创建控制台传输
const consoleTransport = new winston.transports.Console({
    format: winston.format.combine(
        winston.format.colorize(),
        baseFormat
    )
});

// 创建旋转日志文件传输
const dailyRotateFile = new winston.transports.DailyRotateFile({
    filename: path.join('logs', '%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    format: winston.format.combine(
        baseFormat,
        winston.format.printf(info => `${info.message}\n`)
    ),
    handleExceptions: true,
    handleRejections: true
});

// 创建logger实例
const logger = winston.createLogger({
    level: 'info',
    transports: [
        consoleTransport,
        dailyRotateFile
    ],
    exitOnError: false
});

/**
 * 记录时间日志
 * @param {string} message - 日志消息
 * @param {boolean} [error=false] - 是否为错误日志
 */
export const logTime = (message, error = false) => {
    if (error) {
        logger.error(message);
    } else {
        logger.info(message);
    }
};

// 重写console方法
const originalConsole = { ...console };
console.log = (...args) => logger.info(args.join(' '));
console.info = (...args) => logger.info(args.join(' '));
console.warn = (...args) => logger.warn(args.join(' '));
console.error = (...args) => logger.error(args.join(' '));
console.debug = (...args) => logger.debug(args.join(' '));

export default logger;