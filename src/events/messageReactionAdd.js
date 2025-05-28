import { Events } from 'discord.js';
import { handleOpinionReaction } from '../services/opinionMonitorService.js';
import { logTime } from '../utils/logger.js';

export default {
    name: Events.MessageReactionAdd,
    async execute(reaction, user) {
        try {

            // 忽略机器人的反应
            if (user.bot) {
                return;
            }

            // 确保消息已完全加载
            if (reaction.partial) {
                try {
                    await reaction.fetch();
                } catch (error) {
                    logTime(`[反应监控] 无法获取完整反应信息: ${error.message}`, true);
                    return;
                }
            }

            // 确保消息已完全加载
            if (reaction.message.partial) {
                try {
                    await reaction.message.fetch();
                } catch (error) {
                    logTime(`[反应监控] 无法获取完整消息信息: ${error.message}`, true);
                    return;
                }
            }

            // 处理意见信箱的反应监控
            await handleOpinionReaction(reaction, user, reaction.message.client);

        } catch (error) {
            logTime(`[反应监控] 处理消息反应时出错: ${error.message}`, true);
            console.error('[反应监控] 错误堆栈:', error);
        }
    },
};
