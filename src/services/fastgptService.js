import axios from 'axios';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { existsSync, promises as fs, mkdirSync } from 'fs';
import { marked } from 'marked';
import nodeHtmlToImage from 'node-html-to-image';
import path from 'path';
import { logTime } from '../utils/logger.js';

// 用于记录每个服务器最近使用的端点 (guildId => endpointUrl)
const lastUsedEndpoints = new Map();

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

        // 按时间顺序（从旧到新）排序消息
        const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp);

        // 添加用户消息和时间戳
        sortedMessages.forEach(msg => {
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
        sortedMessages.forEach(msg => {
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
 * @param {Object} interaction - Discord交互对象，用于进度更新
 * @param {Object} logData - 日志数据，用于请求开始和失败时记录
 * @returns {Object} API响应
 */
export async function sendToFastGPT(requestBody, guildConfig, interaction = null, logData = null) {
    const { endpoints } = guildConfig.fastgpt;
    // 获取服务器ID，如果没有交互对象则使用默认值
    const guildId = interaction?.guildId || 'default';

    if (!endpoints || endpoints.length === 0) {
        throw new Error('FastGPT 未配置或所有端点均无效');
    }

    // 获取上次使用的端点
    const lastUsedEndpoint = lastUsedEndpoints.get(guildId);

    // 保存上次成功的端点以备后用
    let lastSuccessEndpoint = null;
    if (lastUsedEndpoint) {
        lastSuccessEndpoint = endpoints.find(endpoint => endpoint.url === lastUsedEndpoint);
    }

    // 初始化可用端点（排除上次使用的端点）
    let availableEndpoints = [...endpoints];
    if (lastUsedEndpoint && availableEndpoints.length > 1) {
        availableEndpoints = availableEndpoints.filter(endpoint => endpoint.url !== lastUsedEndpoint);
    }

    // 随机打乱端点顺序以实现轮询
    const shuffledEndpoints = availableEndpoints.sort(() => Math.random() - 0.5);

    let lastError = null;

    // 尝试发送请求到端点的辅助函数
    async function tryEndpoint(endpoint, index, totalCount, isLastChance = false) {
        const { url: apiUrl, key: apiKey } = endpoint;

        // 更新交互，通知用户正在尝试的端点
        if (interaction) {
            const statusText = isLastChance
                ? `⏳ 正在尝试上次成功的端点: ${apiUrl.split('/').slice(0, 3).join('/')}...`
                : `⏳ 正在处理请求，使用端点: ${apiUrl.split('/').slice(0, 3).join('/')}... (${index + 1}/${totalCount})`;

            const processingEmbed = new EmbedBuilder()
                .setTitle('正在处理请求')
                .setDescription(statusText)
                .setColor(0xffa500) // 橙色
                .setTimestamp();

            await interaction.editReply({ embeds: [processingEmbed] });
        }

        let completed = false; // 引入状态标志

        try {
            // 创建超时控制器
            const controller = new AbortController();
            const timeoutMs = 100000; // 100秒超时
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            // 启动定时器，每10秒更新一次进度
            let elapsed = 0;
            const progressInterval = 10000; // 10秒
            const updateProgress = async () => {
                if (completed || controller.signal.aborted) { // 检查完成状态或中止信号
                    return;
                }

                elapsed += progressInterval;
                const remaining = Math.max(0, timeoutMs - elapsed);
                if (interaction && !controller.signal.aborted) {
                    try {
                        const progressEmbed = new EmbedBuilder()
                            .setTitle('正在处理请求')
                            .setDescription(`⏳ 正在处理请求，使用端点: ${apiUrl.split('/').slice(0, 3).join('/')}... (${index + 1}/${
                                totalCount
                            })\n剩余超时时间: ${Math.ceil(remaining / 1000)}秒`)
                            .setColor(0xffa500) // 橙色
                            .setTimestamp();

                        await interaction.editReply({ embeds: [progressEmbed] });
                    } catch (e) {
                        // 忽略更新失败的错误
                    }
                }

                if (remaining > 0 && !controller.signal.aborted && !completed) { // 检查完成状态
                    setTimeout(updateProgress, progressInterval);
                }
            };

            const progressTimer = setTimeout(updateProgress, progressInterval);

            const response = await axios.post(apiUrl, requestBody, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: timeoutMs,
                signal: controller.signal,
            });

            completed = true; // 请求成功时设置标志
            clearTimeout(timeout);
            clearTimeout(progressTimer); // 虽然可能不是完全必要，但保留无害

            logTime(`FastGPT API 请求成功 (来自: ${apiUrl})`);
            const responseData = response.data;
            // 添加端点信息到响应对象，便于记录日志
            responseData.endpoint = apiUrl;

            // 记录成功的端点，用于下次请求
            lastUsedEndpoints.set(guildId, apiUrl);

            return responseData; // 成功则直接返回
        } catch (error) {
            completed = true; // 请求失败时设置标志
            let errorType = '未知错误';
            let errorMessage = error.message;

            if (error.name === 'AbortError' || error.code === 'ECONNABORTED') {
                errorType = '请求超时';
            } else if (error.response) {
                errorType = `API错误 (${error.response.status})`;
                if (error.response.data) {
                    errorMessage = `${errorMessage} - ${JSON.stringify(error.response.data)}`;
                }
            } else if (error.request) {
                errorType = '网络错误';
            }

            logTime(`FastGPT API 请求失败 (端点: ${apiUrl}): ${errorType} - ${errorMessage}`, true);

            // 更新交互，通知用户请求失败
            if (interaction) {
                try {
                    const nextStepDesc = isLastChance ?
                        '' : // 如果是最后一个尝试，不提示下一步
                        ((index < totalCount - 1) ?
                            `，10秒后将继续显示下一个端点的处理进度...` :
                            (lastSuccessEndpoint ? '，10秒后将继续显示上次成功端点的处理进度...' : ''));

                    const errorEmbed = new EmbedBuilder()
                        .setTitle('请求失败')
                        .setDescription(`⚠️ 端点 ${apiUrl.split('/').slice(0, 3).join('/')} 请求失败 (${errorType}): ${errorMessage}${nextStepDesc}`)
                        .setColor(0xf44336) // 红色
                        .setTimestamp();

                    await interaction.editReply({ embeds: [errorEmbed] });

                    // 在失败后显示10秒错误原因
                    if (index < totalCount - 1 || (lastSuccessEndpoint && !isLastChance)) {
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    }
                } catch (e) {
                    // 忽略更新失败的错误
                }
            }

            // 记录失败日志
            if (logData) {
                const timestamp = new Date().toLocaleString('zh-CN');
                logData.timestamp = timestamp; // 更新时间戳
                await logQAResult(logData, null, null, null, 'failed', apiUrl, `${errorType} - ${errorMessage}`);
            }

            lastError = error; // 记录错误

            // 如果是客户端错误 (4xx)，停止尝试其他端点
            if (error.response && error.response.status >= 400 && error.response.status < 500) {
                logTime(`客户端错误 (${error.response.status})，停止尝试其他端点。`, true);
                throw error; // 直接抛出错误，不再尝试其他端点
            }

            return null; // 返回null表示当前端点失败
        }
    }

    // 第1阶段：尝试随机排序的端点
    for (let i = 0; i < shuffledEndpoints.length; i++) {
        const result = await tryEndpoint(shuffledEndpoints[i], i, shuffledEndpoints.length);
        if (result) return result; // 如果成功，直接返回结果
    }

    // 第2阶段：如果所有随机端点都尝试失败，但存在上次成功过的端点，则尝试该端点
    if (lastSuccessEndpoint && !shuffledEndpoints.some(e => e.url === lastSuccessEndpoint.url)) {
        const result = await tryEndpoint(lastSuccessEndpoint, 0, 1, true);
        if (result) return result; // 如果成功，直接返回结果
    }

    // 所有端点都尝试失败
    throw new Error('所有 FastGPT 端点请求失败');
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
                // logTime(`找到Chrome可执行文件: ${path}`);
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
        const imageBuffer = await nodeHtmlToImage({
            html: htmlTemplate,
            quality: 90,
            type: 'png',
            puppeteerArgs: puppeteerConfig,
            encoding: 'buffer',
        });

        // 获取图片尺寸信息
        const sizeKB = Math.round(imageBuffer.length / 1024);
        // logTime(`图片生成完成，大小: ${sizeKB}KB`);

        // 返回图片信息
        return {
            buffer: imageBuffer,
            width: 1000, // 固定宽度，可通过puppeteer获取实际尺寸
            height: 800, // 近似高度，可通过puppeteer获取实际尺寸
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
 * 提取文本中的超链接
 * @param {String} text - 包含可能超链接的文本
 * @returns {Array} 提取的超链接数组，每个元素为 {text, url} 对象或单独的 url 字符串
 */
export function extractLinks(text) {
    if (!text) return [];

    // 匹配Markdown格式的链接 [text](url) 和普通URL
    const markdownLinkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    const urlPattern = /(https?:\/\/[^\s\]()]+)/g;

    const links = new Set();
    const linksWithText = [];
    let match;

    // 提取Markdown格式链接
    while ((match = markdownLinkPattern.exec(text)) !== null) {
        const linkText = match[1];
        const url = match[2];
        linksWithText.push({ text: linkText, url });
        links.add(url); // 添加URL到集合中，用于后续去重
    }

    // 提取普通URL
    while ((match = urlPattern.exec(text)) !== null) {
        const url = match[1];
        // 确保不是已经作为Markdown链接的一部分提取过的
        if (!links.has(url) && !text.includes(`](${url})`) && !text.includes(`](${url}?`)) {
            linksWithText.push(url); // 普通URL没有链接文本，直接添加URL字符串
            links.add(url);
        }
    }

    return linksWithText;
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

        // 提取所有超链接
        const links = extractLinks(responseText);

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
                links, // 返回提取的链接
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
                links, // 返回提取的链接
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
 * @param {String} responseText - API响应文本，可为null表示请求失败
 * @param {Object} imageInfo - 图片信息（宽度、高度、大小），可为null
 * @param {Array} links - 提取的超链接数组，可为null
 * @param {String} status - 状态，可以是 'start'、'success'、'failed'
 * @param {String} endpoint - 使用的端点URL
 * @param {String} errorMessage - 错误信息，仅在status为'failed'时使用
 * @returns {Promise<void>}
 */
export async function logQAResult(
    logData,
    responseText = null,
    imageInfo = null,
    links = null,
    status = 'success',
    endpoint = null,
    errorMessage = null,
) {
    try {
        const { timestamp, executor, target, prompt, messageCount, channelName } = logData;

        // 生成当前日期作为文件名 (YYYY-MM-DD.log)
        const date = new Date();
        const fileName = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
            date.getDate(),
        ).padStart(2, '0')}.log`;
        const filePath = path.join(process.cwd(), 'data', 'qalog', fileName);

        // 如果是开始请求状态，直接返回，等待后续记录
        if (status === 'start') {
            return;
        }

        // 构建各部分信息
        const statusText = status === 'failed' ? '请求失败' : '请求成功';
        const endpointInfo = endpoint ? `| 端点: ${endpoint} ` : '';
        const imageInfoText = imageInfo
            ? (imageInfo.isTextFallback
                ? `| 纯文本 (${imageInfo.sizeKB}KB)`
                : `| 尺寸: ${imageInfo.width}x${imageInfo.height}px (${imageInfo.sizeKB}KB)`)
            : '';
        const linksInfo = links?.length > 0 ? ` | 包含${links.length}个链接` : '';

        // 构建日志头部
        const logHeader = `[${timestamp}] 执行人: ${executor} | 答疑对象: ${target} | 提示词: ${
            prompt || '默认'
        } | 消息数: ${messageCount} | 频道: ${channelName} ${endpointInfo}| 状态: ${statusText} ${imageInfoText}${linksInfo}\n`;

        // 构建各部分内容
        const linksSection = links?.length > 0
            ? `\n链接列表:\n${links
                .map((link, index) => {
                    if (typeof link === 'object' && link.text && link.url) {
                        return `${index + 1}. ${link.text} (${link.url})`;
                    }
                    return `${index + 1}. ${link}`;
                })
                .join('\n')}\n`
            : '';

        const errorSection = (status === 'failed' && errorMessage) ? `\n错误详情:\n${errorMessage}\n` : '';
        const contentSection = responseText ? `\n${responseText}\n` : '';
        const separator = status === 'success' ? `${'='.repeat(80)}\n\n` : `${'-'.repeat(80)}\n\n`;

        // 构建完整日志内容
        const logContent = `${logHeader}${'-'.repeat(80)}${linksSection}${errorSection}${contentSection}${separator}`;

        // 追加写入日志文件
        await fs.appendFile(filePath, logContent, 'utf8');
    } catch (error) {
        logTime(`记录答疑结果失败: ${error.message}`, true);
    }
}

/**
 * 分析指定日期的FastGPT日志
 * @param {Date} [date] - 要分析的日期，默认为当天
 * @param {Object} [endpointNames] - 端点名称映射，默认为空对象
 * @returns {Promise<Object>} 日志统计数据
 */
export async function analyzeFastGPTLogs(date = new Date(), endpointNames = {}) {
    try {
        // 格式化日期为文件名格式 (YYYY-MM-DD.log)
        const fileName = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
            date.getDate(),
        ).padStart(2, '0')}.log`;

        const filePath = path.join(process.cwd(), 'data', 'qalog', fileName);

        // 检查日志文件是否存在
        if (!existsSync(filePath)) {
            return {
                date: fileName.replace('.log', ''),
                totalRequests: 0,
                successRequests: 0,
                failedRequests: 0,
                endpointStats: {},
                error: '没有找到当天的日志文件',
            };
        }

        // 读取日志文件内容
        const logContent = await fs.readFile(filePath, 'utf8');

        // 如果日志为空，返回空统计
        if (!logContent.trim()) {
            return {
                date: fileName.replace('.log', ''),
                totalRequests: 0,
                successRequests: 0,
                failedRequests: 0,
                endpointStats: {},
                error: '日志文件为空',
            };
        }

        // 初始化统计对象
        const stats = {
            date: fileName.replace('.log', ''),
            totalRequests: 0,
            successRequests: 0,
            failedRequests: 0,
            endpointStats: {}, // 按端点分类的统计
            endpointToNameMap: {}, // 端点URL到名称的映射
        };

        // 通过查找日期格式的标记 [YYYY/M/D HH:MM:SS] 来分割日志条目
        const logEntries = logContent.split(/\[\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{1,2}:\d{1,2}\]/);

        // 遍历每个日志条目（第一个可能是空的）
        for (let i = 1; i < logEntries.length; i++) {
            const entry = logEntries[i];

            // 只处理包含"状态:"的条目
            if (!entry.includes('状态:')) continue;

            // 提取状态
            const statusMatch = entry.match(/状态:\s*([^|]+)/);
            if (!statusMatch) continue;

            const status = statusMatch[1].trim();

            // 提取端点
            let endpointKey = '未知端点'; // 默认为系统总结，而不是未知端点

            const endpointMatch = entry.match(/端点:\s*([^|]+)/);
            if (endpointMatch) {
                const endpoint = endpointMatch[1].trim();
                // 提取域名部分 (http(s)://domain.tld)
                try {
                    const url = new URL(endpoint);
                    endpointKey = `${url.protocol}//${url.hostname}`;
                } catch (e) {
                    // 如果URL解析失败，使用简单的分割方法
                    endpointKey = endpoint.split('/').slice(0, 3).join('/');
                }
            }

            // 映射端点名称
            if (endpointNames[endpointKey]) {
                stats.endpointToNameMap[endpointKey] = endpointNames[endpointKey];
            } else {
                // 使用域名作为默认名称
                stats.endpointToNameMap[endpointKey] = endpointKey;
            }

            // 总请求数+1
            stats.totalRequests++;

            // 按状态分类
            if (status === '请求成功') {
                stats.successRequests++;

                // 按端点统计成功
                if (!stats.endpointStats[endpointKey]) {
                    stats.endpointStats[endpointKey] = { total: 0, success: 0, failed: 0 };
                }
                stats.endpointStats[endpointKey].total++;
                stats.endpointStats[endpointKey].success++;
            } else {
                stats.failedRequests++;

                // 按端点统计失败
                if (!stats.endpointStats[endpointKey]) {
                    stats.endpointStats[endpointKey] = { total: 0, success: 0, failed: 0 };
                }
                stats.endpointStats[endpointKey].total++;
                stats.endpointStats[endpointKey].failed++;
            }
        }

        return stats;
    } catch (error) {
        logTime(`分析FastGPT日志失败: ${error.message}`, true);
        return {
            date: date.toISOString().split('T')[0],
            totalRequests: 0,
            successRequests: 0,
            failedRequests: 0,
            endpointStats: {},
            error: `分析日志时出错: ${error.message}`,
        };
    }
}

/**
 * 创建FastGPT日志统计的Discord嵌入消息
 * @param {Object} stats - 日志统计数据
 * @returns {EmbedBuilder} 嵌入消息构建器
 */
export function createFastGPTStatsEmbed(stats) {
    const successRate = stats.totalRequests > 0 ? Math.round((stats.successRequests / stats.totalRequests) * 100) : 0;

    // 选择成功率对应的色块
    let rateEmoji = '🟢'; // 90-100%
    if (successRate < 90) rateEmoji = '🔵'; // 70-89%
    if (successRate < 70) rateEmoji = '🟡'; // 40-69%
    if (successRate < 40) rateEmoji = '🔴'; // 0-39%

    const embed = new EmbedBuilder()
        .setColor(successRate >= 70 ? 0x00cc66 : successRate >= 40 ? 0xffcc00 : 0xff3333)
        .setTitle('FastGPT 答疑统计')
        .setDescription(`**📅 日期**: ${stats.date}`)
        .addFields({
            name: '📊 请求总览',
            value: [
                `📝 总请求数: **${stats.totalRequests}**`,
                `✅ 成功: **${stats.successRequests}**`,
                `❌ 失败: **${stats.failedRequests}**`,
                `${rateEmoji} 成功率: **${successRate}%**`,
            ].join('\n'),
            inline: false,
        })
        .setTimestamp()
        .setFooter({ text: '每日FastGPT统计' });

    // 如果有错误，添加错误信息
    if (stats.error) {
        embed.addFields({
            name: '⚠️ 注意',
            value: stats.error,
            inline: false,
        });
        return embed; // 如果有错误，直接返回
    }

    // 如果有端点统计，添加端点详情
    if (Object.keys(stats.endpointStats).length > 0) {
        // 按成功率排序端点
        const sortedEndpoints = Object.entries(stats.endpointStats).sort(([, a], [, b]) => {
            const aRate = a.total > 0 ? a.success / a.total : 0;
            const bRate = b.total > 0 ? b.success / b.total : 0;
            return bRate - aRate; // 降序排列
        });

        const endpointDetails = sortedEndpoints
            .map(([endpointKey, { total, success, failed }]) => {
                const endpointSuccessRate = total > 0 ? Math.round((success / total) * 100) : 0;
                let statusEmoji = '🟢'; // 成功率高
                if (endpointSuccessRate < 70) statusEmoji = '🟡'; // 成功率中
                if (endpointSuccessRate < 40) statusEmoji = '🔴'; // 成功率低

                // 使用映射的名称显示端点
                let displayName = stats.endpointToNameMap && stats.endpointToNameMap[endpointKey]
                                ? stats.endpointToNameMap[endpointKey]
                                : endpointKey;

                return `${statusEmoji} **${displayName}**\n总数: ${total} | 成功: ${success} | 失败: ${failed} | 成功率: ${endpointSuccessRate}%`;
            })
            .join('\n\n');

        embed.addFields({
            name: `🔌 端点统计`,
            value: endpointDetails || '无端点数据',
            inline: false,
        });
    }

    return embed;
}
