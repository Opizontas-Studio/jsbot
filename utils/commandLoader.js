const fs = require('node:fs');
const path = require('node:path');
const { logTime } = require('./common');

/**
 * 加载命令文件
 * @returns {Map} 命令集合
 */
function loadCommandFiles() {
    const commands = new Map();
    const commandsPath = path.join(__dirname, '..', 'commands');
    
    fs.readdirSync(commandsPath)
        .filter(file => file.endsWith('.js'))
        .forEach(file => {
            try {
                const command = require(path.join(commandsPath, file));
                if (!command.data?.name || !command.execute) {
                    logTime(`⚠️ ${file} 缺少必要属性`);
                    return;
                }
                
                if (commands.has(command.data.name)) {
                    logTime(`⚠️ 重复命令名称 "${command.data.name}"`);
                    return;
                }

                commands.set(command.data.name, command);
                logTime(`已加载命令: ${command.data.name}`);
            } catch (error) {
                logTime(`❌ 加载 ${file} 失败: ${error}`, true);
            }
        });
        
    return commands;
}

module.exports = { loadCommandFiles }; 