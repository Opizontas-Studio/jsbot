import { AttachmentBuilder, SlashCommandBuilder } from 'discord.js';
import { promises as fs } from 'fs';
import path from 'path';
import { handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';

// 脚本目录路径
const SCRIPT_DIR = path.join(process.cwd(), 'data', 'script');

/**
 * 获取所有可用的脚本文件
 * @returns {Promise<string[]>} 脚本文件名数组
 */
async function getAvailableScripts() {
    try {
        await fs.mkdir(SCRIPT_DIR, { recursive: true });
        const files = await fs.readdir(SCRIPT_DIR);
        return files
            .filter(file => file.endsWith('.js'))
            .map(file => file.replace('.js', ''));
    } catch (error) {
        logTime(`获取脚本列表失败: ${error.message}`, true);
        return [];
    }
}

/**
 * 执行指定的脚本文件
 * @param {string} scriptName - 脚本名称（不含扩展名）
 * @param {Object} context - 执行上下文
 * @returns {Promise<any>} 脚本执行结果
 */
async function executeScript(scriptName, context) {
    const scriptPath = path.join(SCRIPT_DIR, `${scriptName}.js`);

    try {
        // 检查脚本文件是否存在
        await fs.access(scriptPath);

        // 动态导入脚本
        const scriptModule = await import(`file://${scriptPath}?timestamp=${Date.now()}`);

        // 确保脚本导出了执行函数
        if (typeof scriptModule.default !== 'function' && typeof scriptModule.execute !== 'function') {
            throw new Error('脚本必须导出 default 函数或 execute 函数');
        }

        const executeFunction = scriptModule.default || scriptModule.execute;

        // 执行脚本并返回结果
        return await executeFunction(context);
    } catch (error) {
        logTime(`执行脚本 ${scriptName} 失败: ${error.message}`, true);
        throw error;
    }
}

/**
 * 格式化脚本执行结果为文本内容
 * @param {any} result - 脚本执行结果
 * @param {string} scriptName - 脚本名称
 * @param {number} executionTime - 执行时间（毫秒）
 * @returns {string} 格式化后的文本内容
 */
function formatResultAsText(result, scriptName, executionTime) {
    const timestamp = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    let content = `脚本执行结果报告\n`;
    content += `=====================\n`;
    content += `脚本名称: ${scriptName}\n`;
    content += `执行时间: ${timestamp}\n`;
    content += `耗时: ${executionTime}ms\n`;
    content += `=====================\n\n`;

    if (!result) {
        content += '脚本执行完成，无返回结果\n';
        return content;
    }

    if (typeof result === 'string') {
        content += result;
        return content;
    }

    if (typeof result === 'object') {
        try {
            content += JSON.stringify(result, null, 2);
            return content;
        } catch (error) {
            content += `结果格式化失败: ${error.message}\n`;
            content += `原始结果: ${String(result)}`;
            return content;
        }
    }

    // 其他类型转换为字符串
    content += String(result);
    return content;
}

/**
 * 创建结果文本附件
 * @param {string} content - 文本内容
 * @param {string} scriptName - 脚本名称
 * @returns {AttachmentBuilder} Discord附件对象
 */
function createResultAttachment(content, scriptName) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${scriptName}_result_${timestamp}.txt`;

    const buffer = Buffer.from(content, 'utf8');
    return new AttachmentBuilder(buffer, { name: filename });
}

export default {
    cooldown: 10,
    ephemeral: false, // 改为非ephemeral以便附件能正常显示
    data: new SlashCommandBuilder()
        .setName('运行脚本')
        .setDescription('执行指定的临时脚本文件')
        .addStringOption(option =>
            option
                .setName('脚本名称')
                .setDescription('要执行的脚本文件名（不含.js扩展名）')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction) {
        try {
            const focusedValue = interaction.options.getFocused();
            const availableScripts = await getAvailableScripts();

            const filtered = availableScripts
                .filter(script => script.toLowerCase().includes(focusedValue.toLowerCase()))
                .slice(0, 25); // Discord限制最多25个选项

            await interaction.respond(
                filtered.map(script => ({
                    name: script,
                    value: script
                }))
            );
        } catch (error) {
            logTime(`脚本自动完成失败: ${error.message}`, true);
            await interaction.respond([]);
        }
    },

    async execute(interaction, guildConfig) {
        try {
            const scriptName = interaction.options.getString('脚本名称');

            // 验证脚本名称（安全检查）
            if (!/^[a-zA-Z0-9_-]+$/.test(scriptName)) {
                await interaction.editReply({
                    content: '❌ 脚本名称只能包含字母、数字、下划线和短横线',
                });
                return;
            }

            // 准备执行上下文
            const context = {
                client: interaction.client,
                guild: interaction.guild,
                user: interaction.user,
                interaction,
                guildConfig,
                logTime
            };

            // 发送执行开始消息
            await interaction.editReply({
                content: `🔄 正在执行脚本: \`${scriptName}\`...`,
            });

            // 执行脚本
            const startTime = Date.now();
            const result = await executeScript(scriptName, context);
            const executionTime = Date.now() - startTime;

            // 格式化结果为文本并创建附件
            const resultText = formatResultAsText(result, scriptName, executionTime);
            const attachment = createResultAttachment(resultText, scriptName);

            // 准备回复消息
            const replyContent = `✅ 脚本执行完成 (耗时: ${executionTime}ms)\n📄 详细结果请查看附件`;

            await interaction.editReply({
                content: replyContent,
                files: [attachment]
            });

            logTime(`管理员 ${interaction.user.tag} 执行脚本 ${scriptName}，耗时 ${executionTime}ms`);

        } catch (error) {
            await handleCommandError(interaction, error, '脚本执行失败');
        }
    },
};
