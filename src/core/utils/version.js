/**
 * 版本信息工具
 * 提供获取应用程序版本、Git提交信息等功能
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 获取应用程序版本信息
 * @param {Logger} [logger] - 可选的日志器，用于输出错误信息
 * @returns {Object|null} 包含版本号、提交哈希和提交日期的对象，如果获取失败则返回null
 */
export function getVersionInfo(logger = null) {
    try {
        const packagePath = join(process.cwd(), 'package.json');
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
        const version = 'v' + packageJson.version;
        const commitHash = execSync('git rev-parse --short HEAD').toString().trim();
        const commitDate = execSync('git log -1 --format=%cd --date=format:"%Y-%m-%d %H:%M:%S"').toString().trim();

        return {
            version,
            commitHash,
            commitDate,
        };
    } catch (error) {
        const errorMsg = '[Version] 获取版本信息失败';
        if (logger) {
            logger.error({ msg: errorMsg, error: error.message });
        } else {
            console.error(errorMsg + ':', error.message);
        }
        return null;
    }
}

