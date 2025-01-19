import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { checkAndHandlePermission, handleCommandError } from '../utils/helper.js';
import { formatPunishmentDuration } from '../utils/punishment_helper.js';
import { PunishmentModel, ProcessModel } from '../db/models/index.js';

export default {
    cooldown: 3,
    data: new SlashCommandBuilder()
        .setName('查询记录')
        .setDescription('查询数据库记录')
        .addStringOption(option =>
            option.setName('类型')
                .setDescription('要查询的记录类型')
                .setRequired(true)
                .addChoices(
                    { name: '处罚记录', value: 'punishment' },
                    { name: '流程记录', value: 'process' }
                )
        )
        .addUserOption(option =>
            option.setName('用户')
                .setDescription('筛选特定用户（可选）')
                .setRequired(false)
        ),

    async execute(interaction, guildConfig) {
        try {
            // 检查管理员权限
            if (!await checkAndHandlePermission(interaction, guildConfig.AdministratorRoleIds)) return;

            const type = interaction.options.getString('类型');
            const targetUser = interaction.options.getUser('用户');

            if (type === 'punishment') {
                // 查询处罚记录
                const punishments = targetUser ?
                    await PunishmentModel.getUserPunishments(targetUser.id, interaction.guildId) :
                    await PunishmentModel.getAllPunishments();
                
                if (!punishments || punishments.length === 0) {
                    await interaction.editReply({
                        content: targetUser ? 
                            `✅ 用户 ${targetUser.tag} 在此服务器没有处罚记录` :
                            '✅ 数据库中没有处罚记录',
                        flags: ['Ephemeral']
                    });
                    return;
                }

                // 分页处理（每页10条记录）
                const pages = [];
                const pageSize = 10;
                for (let i = 0; i < punishments.length; i += pageSize) {
                    const pageRecords = punishments.slice(i, i + pageSize);
                    const fields = await Promise.all(pageRecords.map(async (p, index) => {
                        const executor = await interaction.client.users.fetch(p.executorId).catch(() => null);
                        const target = await interaction.client.users.fetch(p.userId).catch(() => null);
                        
                        const typeText = {
                            ban: '永封',
                            mute: '禁言',
                            warn: '警告'
                        };

                        const statusText = {
                            active: '生效中',
                            expired: '已到期',
                            appealed: '已上诉',
                            revoked: '已撤销'
                        };

                        return {
                            name: `#${i + index + 1} ${typeText[p.type]} (ID: ${p.id})`,
                            value: [
                                `目标: ${target ? target.tag : '未知'} (${p.userId})`,
                                `服务器: ${p.guildId}`,
                                `状态: ${statusText[p.status]}`,
                                `原因: ${p.reason}`,
                                `时长: ${formatPunishmentDuration(p.duration)}`,
                                `执行人: ${executor ? executor.tag : '未知'} (${p.executorId})`,
                                `执行时间: ${new Date(p.createdAt).toLocaleString()}`,
                                p.status === 'active' ? 
                                    `到期时间: ${p.expireAt === -1 ? '永久' : new Date(p.expireAt).toLocaleString()}` : 
                                    `结束时间: ${new Date(p.updatedAt).toLocaleString()}`
                            ].join('\n'),
                            inline: false
                        };
                    }));

                    pages.push({
                        embeds: [{
                            color: 0x0099ff,
                            title: `处罚记录查询结果`,
                            description: targetUser ? 
                                `用户 ${targetUser.tag} (${targetUser.id}) 的处罚记录` :
                                '全库处罚记录',
                            fields,
                            timestamp: new Date(),
                            footer: {
                                text: `第 ${pages.length + 1} 页 | 共 ${Math.ceil(punishments.length / pageSize)} 页 | 总计 ${punishments.length} 条记录`
                            }
                        }]
                    });
                }

                // 发送第一页
                const addPaginationButtons = (page) => {
                    const row = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('page_prev')
                                .setLabel('上一页')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('page_next')
                                .setLabel('下一页')
                                .setStyle(ButtonStyle.Primary)
                        );
                    return { ...page, components: [row] };
                };

                const message = await interaction.editReply(addPaginationButtons(pages[0]));
                
                // 缓存页面数据（5分钟后自动清除）
                interaction.client.pageCache = interaction.client.pageCache || new Map();
                interaction.client.pageCache.set(message.id, pages);
                setTimeout(() => interaction.client.pageCache.delete(message.id), 5 * 60 * 1000);

            } else {
                // 查询流程记录
                const processes = targetUser ?
                    await ProcessModel.getUserProcesses(targetUser.id) :
                    await ProcessModel.getAllProcesses();
                
                if (!processes || processes.length === 0) {
                    await interaction.editReply({
                        content: targetUser ? 
                            `✅ 用户 ${targetUser.tag} 没有相关流程记录` :
                            '✅ 数据库中没有流程记录',
                        flags: ['Ephemeral']
                    });
                    return;
                }

                // 分页处理（每页10条记录）
                const pages = [];
                const pageSize = 10;
                for (let i = 0; i < processes.length; i += pageSize) {
                    const pageRecords = processes.slice(i, i + pageSize);
                    const fields = await Promise.all(pageRecords.map(async (p, index) => {
                        const punishment = await PunishmentModel.getPunishmentById(p.punishmentId);
                        
                        const typeText = {
                            appeal: '上诉',
                            vote: '投票',
                            debate: '辩诉'
                        };

                        const statusText = {
                            pending: '待处理',
                            in_progress: '进行中',
                            completed: '已完成',
                            rejected: '已拒绝',
                            cancelled: '已取消'
                        };

                        return {
                            name: `#${i + index + 1} ${typeText[p.type]} (ID: ${p.id})`,
                            value: [
                                `关联处罚ID: ${p.punishmentId}`,
                                punishment ? [
                                    `处罚类型: ${punishment.type}`,
                                    `处罚目标: ${punishment.userId}`,
                                    `处罚服务器: ${punishment.guildId}`
                                ].join('\n') : '关联处罚已删除',
                                `状态: ${statusText[p.status]}`,
                                p.redClaim ? `红方诉求: ${p.redClaim}` : null,
                                p.blueClaim ? `蓝方诉求: ${p.blueClaim}` : null,
                                `开始时间: ${new Date(p.createdAt).toLocaleString()}`,
                                p.status === 'completed' ? 
                                    `结果: ${p.result || '无'}\n原因: ${p.reason || '无'}` : 
                                    `到期时间: ${new Date(p.expireAt).toLocaleString()}`
                            ].filter(Boolean).join('\n'),
                            inline: false
                        };
                    }));

                    pages.push({
                        embeds: [{
                            color: 0x0099ff,
                            title: `流程记录查询结果`,
                            description: targetUser ? 
                                `用户 ${targetUser.tag} (${targetUser.id}) 的流程记录` :
                                '全库流程记录',
                            fields,
                            timestamp: new Date(),
                            footer: {
                                text: `第 ${pages.length + 1} 页 | 共 ${Math.ceil(processes.length / pageSize)} 页 | 总计 ${processes.length} 条记录`
                            }
                        }]
                    });
                }

                // 发送第一页
                const addPaginationButtons = (page) => {
                    const row = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('page_prev')
                                .setLabel('上一页')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('page_next')
                                .setLabel('下一页')
                                .setStyle(ButtonStyle.Primary)
                        );
                    return { ...page, components: [row] };
                };

                const message = await interaction.editReply(addPaginationButtons(pages[0]));
                
                // 缓存页面数据（5分钟后自动清除）
                interaction.client.pageCache = interaction.client.pageCache || new Map();
                interaction.client.pageCache.set(message.id, pages);
                setTimeout(() => interaction.client.pageCache.delete(message.id), 5 * 60 * 1000);
            }

        } catch (error) {
            await handleCommandError(interaction, error, '查询记录');
        }
    }
}; 