import { SlashCommandBuilder } from 'discord.js';
import { PunishmentModel } from '../db/models/punishmentModel.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { logTime } from '../utils/logger.js';
import { revokePunishmentInGuilds } from '../utils/punishmentHelper.js';

export default {
    cooldown: 5,
    ephemeral: true,
    data: new SlashCommandBuilder()
        .setName('撤销处罚')
        .setDescription('根据数据库情况，撤销指定的处罚')
        .addIntegerOption(option => option.setName('处罚id').setDescription('要撤销的处罚ID').setRequired(true))
        .addStringOption(option => option.setName('原因').setDescription('撤销原因').setRequired(true)),

    async execute(interaction, guildConfig) {
        try {
            // 检查权限
            if (!(await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds))) {
                return;
            }

            const punishmentId = interaction.options.getInteger('处罚id');
            const reason = interaction.options.getString('原因');

            // 获取处罚记录
            const punishment = await PunishmentModel.getPunishmentById(punishmentId);
            if (!punishment) {
                await interaction.editReply({
                    content: '❌ 找不到指定的处罚记录',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 检查处罚状态
            if (punishment.status !== 'active' && !(punishment.type === 'ban' && punishment.status === 'expired')) {
                let message = '❌ 无法撤销处罚：';
                switch (punishment.status) {
                    case 'appealed':
                        message += '该处罚已进入辩诉阶段';
                        break;
                    case 'expired':
                        message += '该处罚已过期';
                        break;
                    case 'revoked':
                        message += '该处罚已被撤销';
                        break;
                    default:
                        message += '处罚状态异常';
                }
                await interaction.editReply({
                    content: message,
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 获取目标用户
            const target = await interaction.client.users.fetch(punishment.userId).catch(() => null);
            if (!target) {
                await interaction.editReply({
                    content: '❌ 无法获取目标用户信息',
                    flags: ['Ephemeral'],
                });
                return;
            }

            // 执行处罚撤销
            const { success, successfulServers, failedServers } = await revokePunishmentInGuilds(
                interaction.client,
                punishment,
                target,
                `管理员撤销 - ${reason}`,
            );

            if (success) {
                // 发送私信通知，但跳过永封类型
                if (punishment.type !== 'ban') {
                    try {
                        const dmEmbed = {
                            color: 0x00ff00,
                            title: '处罚已被撤销',
                            description: [
                                `您的${punishment.type === 'ban' ? '永封' : '禁言'}处罚已被管理员撤销。`,
                                '',
                                '**处罚详情**',
                                `• 处罚ID：${punishment.id}`,
                                `• 原处罚原因：${punishment.reason}`,
                                `• 撤销原因：${reason}`,
                            ].join('\n'),
                            timestamp: new Date(),
                        };

                        await target
                            .send({ embeds: [dmEmbed] })
                            .then(() => logTime(`已向用户 ${target.tag} 发送处罚撤销通知`))
                            .catch(error =>
                                logTime(`向用户 ${target.tag} 发送处罚撤销通知失败: ${error.message}`, true),
                            );
                    } catch (error) {
                        logTime(`创建处罚撤销通知失败: ${error.message}`, true);
                    }
                } else {
                    logTime(`跳过向永封用户 ${target.tag} 发送处罚撤销通知`);
                }
            }

            // 发送管理日志
            const logChannel = await interaction.client.channels
                .fetch(guildConfig.moderationLogThreadId)
                .catch(() => null);
            if (logChannel) {
                const embed = {
                    color: 0x00ff00,
                    title: '处罚已撤销',
                    fields: [
                        {
                            name: '处罚ID',
                            value: `${punishment.id}`,
                            inline: true,
                        },
                        {
                            name: '处罚类型',
                            value: punishment.type === 'ban' ? '永封' : '禁言',
                            inline: true,
                        },
                        {
                            name: '目标用户',
                            value: `<@${target.id}>`,
                            inline: true,
                        },
                        {
                            name: '撤销原因',
                            value: reason,
                        },
                    ],
                    timestamp: new Date(),
                };

                if (successfulServers.length > 0) {
                    embed.fields.push({
                        name: '成功服务器',
                        value: successfulServers.join(', '),
                    });
                }
                if (failedServers.length > 0) {
                    embed.fields.push({
                        name: '失败服务器',
                        value: failedServers.map(s => s.name).join(', '),
                    });
                }

                await logChannel.send({ embeds: [embed] });
            }

            // 返回结果
            await interaction.editReply({
                content: success
                    ? [
                          '✅ 处罚撤销结果：',
                          `成功服务器: ${successfulServers.length > 0 ? successfulServers.join(', ') : '无'}`,
                          failedServers.length > 0 ? `失败服务器: ${failedServers.map(s => s.name).join(', ')}` : null,
                      ]
                          .filter(Boolean)
                          .join('\n')
                    : '❌ 处罚撤销失败',
                flags: ['Ephemeral'],
            });
        } catch (error) {
            await handleCommandError(interaction, error, '撤销处罚');
        }
    },
};
