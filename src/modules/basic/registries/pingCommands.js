import { SlashCommandBuilder } from 'discord.js';
import { ComponentV2Factory } from '../../../shared/factories/ComponentV2Factory.js';
import { PingMessageBuilder } from '../builders/pingMessages.js';

/**
 * Ping 命令配置
 * 测试 Bot 响应速度
 */
export default [
    {
        id: 'basic.ping',
        type: 'command',
        commandKind: 'slash',
        name: 'ping',
        description: '测试Bot响应速度',
        defer: false, // Ping命令不需要defer，立即响应
        cooldown: 3000, // 3秒冷却

        /**
         * 构建命令
         */
        builder() {
            return new SlashCommandBuilder().setName(this.name).setDescription(this.description);
        },

        /**
         * 执行命令
         */
        async execute(ctx) {
            const start = Date.now();
            const apiLatency = Math.round(ctx.client.ws.ping);

            // 发送初始回复以测量往返延迟
            await ctx.reply(
                ComponentV2Factory.createStandardMessage('progress', {
                    ...PingMessageBuilder.MESSAGES.measuring,
                    additionalFlags: ['Ephemeral']
                })
            );

            const roundTripLatency = Date.now() - start;

            // 更新回复
            await ctx.interaction.editReply(
                PingMessageBuilder.createPong(
                    {
                        apiLatency,
                        roundTripLatency,
                        botTag: ctx.client.user.tag,
                        guildCount: ctx.client.guilds.cache.size
                    },
                    { additionalFlags: ['Ephemeral'] }
                )
            );
        }
    }
];
