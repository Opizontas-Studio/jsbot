import axios from 'axios';
import { AttachmentBuilder } from 'discord.js';
import { existsSync, promises as fs, mkdirSync } from 'fs';
import { marked } from 'marked';
import nodeHtmlToImage from 'node-html-to-image';
import path from 'path';
import { logTime } from '../utils/logger.js';

// 确保日志目录存在
try {
    mkdirSync('./data/qalog', { recursive: true });
} catch (error) {
    if (error.code !== 'EEXIST') {
        logTime(`创建答疑日志目录失败: ${error.message}`, true);
    }
}

/**
 * 获取用户最近的消息，包括文本和图片
 * @param {Object} channel - Discord频道对象
 * @param {String} userId - 目标用户ID
 * @param {Number} messageCount - 获取消息数量
 * @returns {Array} 消息数组，包含文本、图片URL和时间戳
 */
export async function fetchUserMessages(channel, userId, messageCount = 5) {
    try {
        // 消息数量限制在1-10之间
        const limit = Math.min(Math.max(messageCount, 1), 10);

        // 获取频道中的所有消息
        const messages = await channel.messages.fetch({ limit: 100 });

        // 获取当前时间戳
        const currentTime = new Date();
        // 一小时的毫秒数
        const ONE_HOUR_MS = 3600000;

        // 过滤出目标用户的消息，且仅保留1小时内的消息
        const userMessages = messages.filter(msg => {
            // 检查消息作者
            if (msg.author.id !== userId) return false;

            // 检查消息时间是否在1小时内
            const messageTime = msg.createdAt;
            const timeDifference = currentTime - messageTime;
            return timeDifference <= ONE_HOUR_MS;
        });

        // 取最近的n条消息
        const recentMessages = Array.from(userMessages.values()).slice(0, limit);

        // 提取消息内容、图片URL和时间戳
        const processedMessages = recentMessages.map(msg => {
            const content = msg.content;
            const images = msg.attachments
                .filter(attachment => attachment.contentType?.startsWith('image/'))
                .map(img => img.url);
            const timestamp = msg.createdAt;
            const messageId = msg.id;

            return { content, images, timestamp, messageId };
        });

        logTime(`成功获取用户 ${userId} 的 ${processedMessages.length} 条消息（仅1小时内）`);
        return processedMessages;
    } catch (error) {
        logTime(`获取用户消息失败: ${error.message}`, true);
        throw new Error(`获取用户消息失败: ${error.message}`);
    }
}

/**
 * 构建FastGPT请求体
 * @param {Array} messages - 用户消息数组
 * @param {String} prompt - 自定义提示词
 * @param {Object} targetUser - 答疑对象用户
 * @param {Object} executorUser - 执行命令的用户
 * @returns {Object} 请求体对象
 */
export function buildFastGPTRequestBody(messages, prompt, targetUser, executorUser) {
    try {
        // 构建消息内容数组
        const contentItems = [];

        // 构建新格式的提示词文本
        let formattedText = `### 需要答疑的用户${targetUser.username}发送了以下消息：\n`;

        // 添加用户消息和时间戳
        messages.forEach(msg => {
            if (msg.content && msg.content.trim()) {
                const timestampStr = msg.timestamp.toLocaleString('zh-CN', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                });
                formattedText += `${timestampStr} - ${targetUser.username}: ${msg.content}\n`;
            }
        });

        // 添加答疑员要求
        formattedText += `### 答疑员${executorUser.username}要求：${prompt || '请为这位用户解答。'}`;

        // 将格式化文本作为单个文本项添加
        contentItems.push({
            type: 'text',
            text: formattedText,
        });

        // 添加图片
        messages.forEach(msg => {
            msg.images.forEach(imageUrl => {
                contentItems.push({
                    type: 'image_url',
                    image_url: {
                        url: imageUrl,
                    },
                });
            });
        });

        // 构建完整请求体
        const requestBody = {
            chatId: `qa-${Date.now()}`, // 生成唯一会话ID
            stream: false, // 不使用流式响应
            messages: [
                {
                    role: 'user',
                    content: contentItems,
                },
            ],
        };

        return requestBody;
    } catch (error) {
        logTime(`构建FastGPT请求体失败: ${error.message}`, true);
        throw new Error(`构建FastGPT请求体失败: ${error.message}`);
    }
}

/**
 * 发送请求到FastGPT API，支持随机轮询和失败重试
 * @param {Object} requestBody - 请求体
 * @param {Object} guildConfig - 服务器配置
 * @returns {Object} API响应
 */
export async function sendToFastGPT(requestBody, guildConfig) {
    const { endpoints } = guildConfig.fastgpt;

    if (!endpoints || endpoints.length === 0) {
        throw new Error('FastGPT 未配置或所有端点均无效');
    }

    // 随机打乱端点顺序以实现轮询
    const shuffledEndpoints = [...endpoints].sort(() => Math.random() - 0.5);

    let lastError = null;

    for (const endpoint of shuffledEndpoints) {
        const { url: apiUrl, key: apiKey } = endpoint;
        logTime(`尝试发送请求到 FastGPT API: ${apiUrl}`);

        try {
            const response = await axios.post(apiUrl, requestBody, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 120000, // 120秒超时
            });

            logTime(`FastGPT API 请求成功 (来自: ${apiUrl})`);
            return response.data; // 成功则直接返回

        } catch (error) {
            lastError = error; // 记录错误
            logTime(`FastGPT API 请求失败 (端点: ${apiUrl}): ${error.message}`, true);
            if (error.response && error.response.status >= 400 && error.response.status < 500) {
                 logTime(`客户端错误 (${error.response.status})，停止尝试其他端点。`, true);
                 break; // 不再尝试其他端点
            }
            // 如果是网络错误或服务器错误 (5xx)，则继续尝试下一个
        }
    }

    // 如果所有端点都尝试失败，则抛出最后一个遇到的错误
    logTime('所有 FastGPT 端点均请求失败', true);
    if (lastError) {
        const errorMessage = lastError.response
            ? `状态码 ${lastError.response.status}, 响应: ${JSON.stringify(lastError.response.data)}`
            : lastError.message;
        throw new Error(`FastGPT API 请求失败: ${errorMessage}`);
    } else {
        throw new Error('无法连接到任何 FastGPT 端点');
    }
}

/**
 * 检测Chrome可执行文件路径
 * @returns {string|null} Chrome可执行文件路径或null
 */
function detectChromePath() {
    // 常见的Chrome安装路径
    const commonPaths = {
        win32: [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', // Edge作为备选
            process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
            process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        ],
        linux: [
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium',
            '/usr/bin/chromium-browser',
        ],
        darwin: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ],
    };

    // 根据操作系统选择路径列表
    const platform = process.platform;
    const paths = commonPaths[platform] || [];

    // 检查文件是否存在
    for (const path of paths) {
        try {
            if (existsSync(path)) {
                logTime(`找到Chrome可执行文件: ${path}`);
                return path;
            }
        } catch (err) {
            // 忽略错误，继续检查下一个路径
        }
    }

    logTime('未找到本地Chrome/Edge浏览器，将尝试使用node-html-to-image内置的Chromium');
    return null;
}

/**
 * 将文本转换为图片
 * @param {String} text - 要转换的文本
 * @returns {Object} 包含图片Buffer和尺寸信息的对象
 */
export async function textToImage(text) {
    try {
        // 将文本转换为Markdown HTML
        const html = marked(text);

        // 构建完整HTML
        const htmlTemplate = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                    line-height: 1.6;
                    color: #fff;
                    background-color: #36393f;
                    padding: 20px;
                    margin: 0;
                    width: auto;
                    height: auto;
                }

                pre {
                    background-color: #2f3136;
                    padding: 10px;
                    border-radius: 5px;
                    overflow-x: auto;
                }

                code {
                    font-family: Consolas, Monaco, 'Andale Mono', 'Ubuntu Mono', monospace;
                    background-color: #2f3136;
                    padding: 2px 4px;
                    border-radius: 3px;
                }

                img {
                    max-width: 100%;
                }

                table {
                    border-collapse: collapse;
                    width: 100%;
                }

                th, td {
                    border: 1px solid #4f545c;
                    padding: 8px;
                }

                th {
                    background-color: #2f3136;
                }

                h1, h2, h3, h4, h5, h6 {
                    color: #ffffff;
                }

                a {
                    color: #00b0f4;
                    text-decoration: none;
                }

                blockquote {
                    border-left: 4px solid #4f545c;
                    padding-left: 15px;
                    margin-left: 0;
                    color: #dcddde;
                }

                hr {
                    border: none;
                    border-top: 1px solid #4f545c;
                    margin: 20px 0;
                }

                .content {
                    max-width: 800px;
                    margin: 0 auto;
                }
            </style>
        </head>
        <body>
            <div class="content">${html}</div>
        </body>
        </html>`;

        // 检测Chrome可执行文件路径
        const chromePath = detectChromePath();

        // 配置puppeteer参数
        const puppeteerConfig = {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            defaultViewport: { width: 800, height: 600, deviceScaleFactor: 1 },
            timeout: 30000, // 30秒超时
        };

        // 如果找到了Chrome可执行文件，添加到配置中
        if (chromePath) {
            puppeteerConfig.executablePath = chromePath;
        }

        // 使用node-html-to-image生成图片
        logTime(`开始生成图片...`);
        const imageBuffer = await nodeHtmlToImage({
            html: htmlTemplate,
            quality: 90,
            type: 'png',
            puppeteerArgs: puppeteerConfig,
            encoding: 'buffer',
        });

        // 获取图片尺寸信息
        const sizeKB = Math.round(imageBuffer.length / 1024);
        logTime(`图片生成完成，大小: ${sizeKB}KB`);

        // 返回图片信息
        return {
            buffer: imageBuffer,
            width: 800, // 固定宽度，可通过puppeteer获取实际尺寸
            height: 600, // 近似高度，可通过puppeteer获取实际尺寸
            sizeKB: sizeKB,
        };
    } catch (error) {
        logTime(`文本转图片失败: ${error.message}`, true);

        // 如果puppeteer失败，尝试使用简单的文本转换方式作为后备方案
        try {
            logTime(`尝试使用备用方案...`);

            // 使用Buffer直接创建一个文本文件作为附件
            const textBuffer = Buffer.from(text, 'utf8');

            return {
                buffer: textBuffer,
                width: 0,
                height: 0,
                sizeKB: Math.round(textBuffer.length / 1024),
                isTextFallback: true, // 标记为文本后备方案
            };
        } catch (fallbackError) {
            logTime(`备用方案也失败了: ${fallbackError.message}`, true);
            throw new Error(`文本转换失败: ${error.message} (备用方案也失败: ${fallbackError.message})`);
        }
    }
}

/**
 * 处理FastGPT响应并转换为Discord附件
 * @param {Object} response - FastGPT API响应
 * @param {String} format - 响应格式，'text'为文本文件，'image'为图片
 * @returns {Object} 包含附件和图片信息的对象
 */
export async function processResponseToAttachment(response, format = 'text') {
    try {
        // 从响应中提取文本内容
        const responseText = response.choices[0]?.message?.content;

        if (!responseText) {
            throw new Error('FastGPT响应内容为空');
        }

        // 根据格式处理响应
        if (format === 'image') {
            // 将文本转换为图片
            const imageResult = await textToImage(responseText);

            // 创建Discord附件
            const attachmentName = imageResult.isTextFallback ? 'response.txt' : 'response.png';
            const attachment = new AttachmentBuilder(imageResult.buffer, { name: attachmentName });

            // 返回附件和图片信息
            return {
                attachment,
                imageInfo: {
                    width: imageResult.width,
                    height: imageResult.height,
                    sizeKB: imageResult.sizeKB,
                    isTextFallback: imageResult.isTextFallback || false,
                },
            };
        } else {
            // 使用纯文本格式
            const textBuffer = Buffer.from(responseText, 'utf8');
            const sizeKB = Math.round(textBuffer.length / 1024);

            // 创建Discord附件
            const attachment = new AttachmentBuilder(textBuffer, { name: 'response.txt' });

            // 返回附件和文本信息
            return {
                attachment,
                imageInfo: {
                    width: 0,
                    height: 0,
                    sizeKB: sizeKB,
                    isTextFallback: true,
                },
            };
        }
    } catch (error) {
        logTime(`处理FastGPT响应失败: ${error.message}`, true);
        throw new Error(`处理FastGPT响应失败: ${error.message}`);
    }
}

/**
 * 将答疑结果记录到日志文件
 * @param {Object} logData - 日志数据
 * @param {String} responseText - API响应文本
 * @param {Object} imageInfo - 图片信息（宽度、高度、大小）
 * @returns {Promise<void>}
 */
export async function logQAResult(logData, responseText, imageInfo) {
    try {
        const { timestamp, executor, target, prompt, messageCount, channelName } = logData;

        // 生成当前日期作为文件名 (YYYY-MM-DD.log)
        const date = new Date();
        const fileName = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
            date.getDate(),
        ).padStart(2, '0')}.log`;
        const filePath = path.join(process.cwd(), 'data', 'qalog', fileName);

        // 添加图片信息
        let imageInfoText = '';
        if (imageInfo) {
            if (imageInfo.isTextFallback) {
                imageInfoText = `| 图片生成失败，使用纯文本 (${imageInfo.sizeKB}KB)`;
            } else {
                imageInfoText = `| 图片尺寸: ${imageInfo.width}x${imageInfo.height}px (${imageInfo.sizeKB}KB)`;
            }
        }

        // 构建日志头部
        const logHeader = `[${timestamp}] 执行人: ${executor} | 答疑对象: ${target} | 提示词: ${
            prompt || '默认'
        } | 消息数: ${messageCount} | 频道: ${channelName} ${imageInfoText}\n`;
        const logContent = `${logHeader}${'-'.repeat(80)}\n${responseText}\n${'='.repeat(80)}\n\n`;

        // 追加写入日志文件
        await fs.appendFile(filePath, logContent, 'utf8');

        logTime(`答疑结果已记录到日志文件: ${fileName}`);
    } catch (error) {
        logTime(`记录答疑结果失败: ${error.message}`, true);
    }
}
