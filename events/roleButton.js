const { Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder } = require('discord.js');
const { logTime } = require('../utils/helper');
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        // 读取消息ID配置
        const messageIdsPath = path.join(__dirname, '..', 'data', 'messageIds.json');
        let messageIds;
        try {
            messageIds = JSON.parse(fs.readFileSync(messageIdsPath, 'utf8'));
            if (!messageIds.roleApplicationMessages) {
                messageIds.roleApplicationMessages = {};
            }
        } catch (error) {
            logTime(`读取消息ID配置失败: ${error}`, true);
            return;
        }

        // 为每个配置了 addRoleThread 的服务器创建申请消息
        for (const [guildId, guildConfig] of client.guildManager.guilds) {
            if (!guildConfig.addRoleThread || !guildConfig.creatorRoleId) continue;

            try {
                const channel = await client.channels.fetch(guildConfig.addRoleThread);
                if (!channel) continue;

                // 删除旧的申请消息
                const oldMessageId = messageIds.roleApplicationMessages[guildId];
                if (oldMessageId) {
                    try {
                        const oldMessage = await channel.messages.fetch(oldMessageId);
                        if (oldMessage) {
                            await oldMessage.delete();
                            logTime(`已删除服务器 ${guildId} 的旧申请消息`);
                        }
                    } catch (error) {
                        logTime(`删除旧申请消息失败: ${error}`, true);
                    }
                }

                // 创建申请按钮
                const button = new ButtonBuilder()
                    .setCustomId('apply_creator_role')
                    .setLabel('申请')
                    .setStyle(ButtonStyle.Primary);

                const row = new ActionRowBuilder().addComponents(button);

                // 创建嵌入消息
                const embed = new EmbedBuilder()
                    .setTitle('创作者身份组自助申请')
                    .setDescription('请您点击下方按钮输入您的达到5个正面反应的作品帖子链接，bot会自动审核，通过则为您添加创作者身份组。')
                    .setColor(0x0099FF);

                // 发送新消息并保存消息ID
                const newMessage = await channel.send({
                    embeds: [embed],
                    components: [row]
                });

                messageIds.roleApplicationMessages[guildId] = newMessage.id;
                
                // 保存更新后的消息ID配置
                fs.writeFileSync(messageIdsPath, JSON.stringify(messageIds, null, 2));
                
                logTime(`已在服务器 ${guildId} 创建新的身份组申请消息`);
            } catch (error) {
                logTime(`在服务器 ${guildId} 创建身份组申请消息时出错: ${error}`, true);
            }
        }
    }
}; 