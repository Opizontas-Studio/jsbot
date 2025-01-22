import { mkdirSync } from 'fs';
import path from 'path';
import winston from 'winston';
import 'winston-daily-rotate-file';

// 创建logs目录（如果不存在）
try {
  mkdirSync('./logs');
} catch (error) {
  if (error.code !== 'EEXIST') {
	    process.stderr.write('创建日志目录失败: ' + error.message + '\n');
  }
}

// 创建统一的日志格式
const logFormat = winston.format.printf(({ message, level, timestamp }) => {
  const prefix = level === 'error' ? '❌ ' : '';
  return `[${timestamp}] ${prefix}${message}`;
});

// 创建控制台传输
const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
	    winston.format.colorize(),
	    winston.format.timestamp({
	        format: 'YYYY/M/D HH:mm:ss',
	    }),
	    logFormat,
  ),
});

// 创建旋转日志文件传输
const dailyRotateFile = new winston.transports.DailyRotateFile({
  filename: path.join('logs', '%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  format: winston.format.combine(
	    winston.format.timestamp({
	        format: 'YYYY/M/D HH:mm:ss',
	    }),
	    logFormat,
  ),
  handleExceptions: true,
  handleRejections: true,
});

// 创建logger实例
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
	    winston.format.timestamp({
	        format: 'YYYY/M/D HH:mm:ss',
	    }),
	    logFormat,
  ),
  transports: [
	    consoleTransport,
	    dailyRotateFile,
  ],
  exitOnError: false,
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

export default logger;