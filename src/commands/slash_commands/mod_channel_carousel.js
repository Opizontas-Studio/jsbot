import { SlashCommandBuilder } from 'discord.js';
import { ModalFactory } from '../../factories/modalFactory.js';
import { carouselServiceManager } from '../../services/carousel/carouselManager.js';
import { checkAndHandlePermission, handleCommandError } from '../../utils/helper.js';
import { logTime } from '../../utils/logger.js';

// 颜色常量
const COLOR_OPTIONS = [
    { name: '蓝色', value: '0x0099ff' },
    { name: '绿色', value: '0x00ff00' },
    { name: '黄色', value: '0xffff00' },
    { name: '紫色', value: '0x9b59b6' },
    { name: '橙色', value: '0xe67e22' },
    { name: '自定义', value: 'custom' },
];

// 排版选项
const LAYOUT_OPTIONS = [
    { name: 'Markdown数字编号', value: 'md-numbered' },
    { name: 'Markdown无编号', value: 'md-plain' },
    { name: 'Field数字编号', value: 'field-numbered' },
    { name: 'Field无编号', value: 'field-plain' },
    { name: 'FieldEmoji数字', value: 'field-emoji' },
];

export default {
    cooldown: 5,
    ephemeral: true,
    shouldDefer: (interaction) => {
        const subcommand = interaction.options.getSubcommand();

        // 删除条目子命令需要 defer
        if (subcommand === '删除条目') {
            return true;
        }

        // 配置子命令的删除操作也需要 defer
        if (subcommand === '配置') {
            const operationType = interaction.options.getString('操作类型');
            return operationType === 'delete';
        }

        // 其他情况（配置的创建/编辑、新增条目、编辑条目）都会显示 modal，不需要 defer
        return false;
    },
    data: new SlashCommandBuilder()
        .setName('管理频道轮播')
        .setDescription('管理频道轮播配置和条目')
        .addSubcommand(subcommand =>
            subcommand
                .setName('配置')
                .setDescription('创建、编辑或删除频道轮播配置')
                .addStringOption(option =>
                    option
                        .setName('操作类型')
                        .setDescription('选择操作类型')
                        .setRequired(true)
                        .addChoices(
                            { name: '创建', value: 'create' },
                            { name: '编辑', value: 'edit' },
                            { name: '删除', value: 'delete' }
                        )
                )
                .addIntegerOption(option =>
                    option
                        .setName('单页项目')
                        .setDescription('每页显示的条目数量（1-20）')
                        .setMinValue(1)
                        .setMaxValue(20)
                        .setRequired(false)
                )
                .addIntegerOption(option =>
                    option
                        .setName('轮播间隔')
                        .setDescription('每页更新间隔，单位秒（最短10秒）')
                        .setMinValue(10)
                        .setRequired(false)
                )
                .addIntegerOption(option =>
                    option
                        .setName('检查周期')
                        .setDescription('检查轮播消息是否为最新的周期，单位秒（最短120秒，-1不检查）')
                        .setMinValue(-1)
                        .setRequired(false)
                )
                .addIntegerOption(option =>
                    option
                        .setName('检查范围')
                        .setDescription('检查最近N条消息（1-100）')
                        .setMinValue(1)
                        .setMaxValue(100)
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName('颜色')
                        .setDescription('轮播消息的颜色')
                        .setRequired(false)
                        .addChoices(...COLOR_OPTIONS)
                )
                .addStringOption(option =>
                    option
                        .setName('自定义颜色')
                        .setDescription('自定义颜色hex码（例如：0xff5733）')
                        .setRequired(false)
                )
                .addStringOption(option =>
                    option
                        .setName('排版')
                        .setDescription('轮播消息的排版方式')
                        .setRequired(false)
                        .addChoices(...LAYOUT_OPTIONS)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('新增条目')
                .setDescription('向当前频道的轮播添加新条目')
                .addIntegerOption(option =>
                    option
                        .setName('id')
                        .setDescription('指定条目ID（可选，不指定则自动生成）')
                        .setMinValue(1)
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('编辑条目')
                .setDescription('编辑当前频道轮播的某个条目')
                .addIntegerOption(option =>
                    option
                        .setName('id')
                        .setDescription('条目ID')
                        .setMinValue(1)
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('删除条目')
                .setDescription('删除当前频道轮播的某个条目')
                .addIntegerOption(option =>
                    option
                        .setName('id')
                        .setDescription('条目ID')
                        .setMinValue(1)
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        ),

    async autocomplete(interaction) {
        const channelCarousel = carouselServiceManager.getChannelCarousel();
        const config = await channelCarousel.getChannelCarouselConfig(interaction.guildId, interaction.channelId);

        if (!config || !config.items || config.items.length === 0) {
            await interaction.respond([]);
            return;
        }

        // 返回条目列表供自动补全
        const choices = config.items.map(item => {
            const preview = item.content.split('\n')[0].substring(0, 80);
            return {
                name: `ID ${item.id}: ${preview}`,
                value: item.id,
            };
        });

        await interaction.respond(choices.slice(0, 25)); // Discord限制最多25个选项
    },

    async execute(interaction, guildConfig) {
        const subcommand = interaction.options.getSubcommand();
        const channelCarousel = carouselServiceManager.getChannelCarousel();
        const channelId = interaction.channelId;
        const guildId = interaction.guildId;

        // 根据子命令类型检查权限
        let allowedRoles;
        if (subcommand === '配置') {
            // 配置子命令只允许管理员执行
            allowedRoles = guildConfig.ModeratorRoleIds || [];
        } else {
            // 条目相关子命令也允许QAer执行
            allowedRoles = [...(guildConfig.ModeratorRoleIds || []), ...(guildConfig.QAerRoleIds || [])];
        }

        if (!(await checkAndHandlePermission(interaction, allowedRoles))) {
            return;
        }

        try {
            switch (subcommand) {
                case '配置':
                    await handleConfigSubcommand(interaction, channelCarousel, guildId, channelId);
                    break;

                case '新增条目':
                    await handleAddItemSubcommand(interaction, channelCarousel, guildId, channelId);
                    break;

                case '编辑条目':
                    await handleEditItemSubcommand(interaction, channelCarousel, guildId, channelId);
                    break;

                case '删除条目':
                    await handleDeleteItemSubcommand(interaction, channelCarousel, guildId, channelId);
                    break;
            }
        } catch (error) {
            await handleCommandError(interaction, error, '管理频道轮播');
        }
    },
};

/**
 * 处理配置子命令
 */
async function handleConfigSubcommand(interaction, channelCarousel, guildId, channelId) {
    const operationType = interaction.options.getString('操作类型');
    const existingConfig = await channelCarousel.getChannelCarouselConfig(guildId, channelId);

    if (operationType === 'delete') {
        // 删除配置
        if (!existingConfig) {
            await interaction.editReply({
                content: '❌ 当前频道没有轮播配置',
            });
            return;
        }

        // 停止轮播
        channelCarousel.stopChannelCarousel(guildId, channelId);

        // 删除配置
        await channelCarousel.deleteChannelCarouselConfig(guildId, channelId);

        await interaction.editReply({
            content: '✅ 已删除当前频道的轮播配置',
        });

        logTime(`[频道轮播] 用户 ${interaction.user.tag} 删除了频道 ${channelId} 的轮播配置`);
        return;
    }

    if (operationType === 'edit' && !existingConfig) {
        await interaction.reply({
            content: '❌ 当前频道没有轮播配置，请先创建',
            ephemeral: true,
        });
        return;
    }

    if (operationType === 'create' && existingConfig) {
        await interaction.reply({
            content: '❌ 当前频道已有轮播配置，请使用编辑功能或先删除现有配置',
            ephemeral: true,
        });
        return;
    }

    // 获取配置参数
    const itemsPerPage = interaction.options.getInteger('单页项目') || existingConfig?.itemsPerPage || 10;
    const updateInterval = interaction.options.getInteger('轮播间隔') || existingConfig?.updateInterval || 10;
    let checkInterval = interaction.options.getInteger('检查周期');
    if (checkInterval === null) {
        checkInterval = existingConfig?.checkInterval ?? -1;
    }
    if (checkInterval !== -1 && checkInterval < 120) {
        await interaction.reply({
            content: '❌ 检查周期最短为120秒',
            ephemeral: true,
        });
        return;
    }
    const checkRecentMessages = interaction.options.getInteger('检查范围') || existingConfig?.checkRecentMessages || 10;

    // 处理颜色
    let color;
    const colorOption = interaction.options.getString('颜色');
    const customColorOption = interaction.options.getString('自定义颜色');

    if (colorOption === 'custom' && customColorOption) {
        // 验证hex颜色格式
        if (!/^0x[0-9A-Fa-f]{6}$/.test(customColorOption)) {
            await interaction.reply({
                content: '❌ 自定义颜色格式错误，应为hex码（例如：0xff5733）',
                ephemeral: true,
            });
            return;
        }
        color = parseInt(customColorOption, 16);
    } else if (colorOption && colorOption !== 'custom') {
        color = parseInt(colorOption, 16);
    } else {
        color = existingConfig?.color || 0x0099ff;
    }

    const layout = interaction.options.getString('排版') || existingConfig?.layout || 'md-numbered';

    // 存储临时配置到interaction的customId中，用于modal回调
    const tempConfig = {
        itemsPerPage,
        updateInterval,
        checkInterval,
        checkRecentMessages,
        color,
        layout,
        items: existingConfig?.items || [],
    };

    // 将临时配置存储到内存中（简化处理）
    if (!interaction.client.tempCarouselConfigs) {
        interaction.client.tempCarouselConfigs = new Map();
    }
    const tempKey = `${guildId}-${channelId}-${Date.now()}`;
    interaction.client.tempCarouselConfigs.set(tempKey, tempConfig);

    // 显示modal让用户填写标题、描述、页脚
    const modal = ModalFactory.createChannelCarouselConfigModal(tempKey, operationType, existingConfig);
    await interaction.showModal(modal);
}

/**
 * 处理新增条目子命令
 */
async function handleAddItemSubcommand(interaction, channelCarousel, guildId, channelId) {
    const config = await channelCarousel.getChannelCarouselConfig(guildId, channelId);
    if (!config) {
        await interaction.reply({
            content: '❌ 当前频道没有轮播配置，请先创建配置',
            ephemeral: true,
        });
        return;
    }

    const customId = interaction.options.getInteger('id');

    // 如果指定了ID，检查是否已存在
    if (customId && config.items.some(item => item.id === customId)) {
        await interaction.reply({
            content: `❌ ID ${customId} 已存在，请选择其他ID或不指定ID自动生成`,
            ephemeral: true,
        });
        return;
    }

    // 显示modal让用户填写条目内容
    const modalId = customId ? `${channelId}_${customId}` : channelId;
    const modal = ModalFactory.createChannelCarouselItemModal(modalId, 'add');
    await interaction.showModal(modal);
}

/**
 * 处理编辑条目子命令
 */
async function handleEditItemSubcommand(interaction, channelCarousel, guildId, channelId) {
    const config = await channelCarousel.getChannelCarouselConfig(guildId, channelId);
    if (!config) {
        await interaction.reply({
            content: '❌ 当前频道没有轮播配置',
            ephemeral: true,
        });
        return;
    }

    const itemId = interaction.options.getInteger('id');
    const item = config.items.find(i => i.id === itemId);
    if (!item) {
        await interaction.reply({
            content: '❌ 找不到指定的条目',
            ephemeral: true,
        });
        return;
    }

    // 显示modal让用户编辑条目内容
    const modal = ModalFactory.createChannelCarouselItemModal(channelId, 'edit', itemId, item.content);
    await interaction.showModal(modal);
}

/**
 * 处理删除条目子命令
 */
async function handleDeleteItemSubcommand(interaction, channelCarousel, guildId, channelId) {
    const config = await channelCarousel.getChannelCarouselConfig(guildId, channelId);
    if (!config) {
        await interaction.editReply({
            content: '❌ 当前频道没有轮播配置',
        });
        return;
    }

    const itemId = interaction.options.getInteger('id');
    const itemIndex = config.items.findIndex(i => i.id === itemId);
    if (itemIndex === -1) {
        await interaction.editReply({
            content: '❌ 找不到指定的条目',
        });
        return;
    }

    // 删除条目
    const deletedItem = config.items.splice(itemIndex, 1)[0];
    await channelCarousel.saveChannelCarouselConfig(guildId, channelId, config);

    await interaction.editReply({
        content: `✅ 已删除条目 ID ${deletedItem.id}：${deletedItem.content.split('\n')[0].substring(0, 50)}...`,
    });

    logTime(`[频道轮播] 用户 ${interaction.user.tag} 删除了频道 ${channelId} 的条目 ID ${deletedItem.id}`);

    // 如果还有条目，重启轮播
    if (config.items.length > 0) {
        const channel = await interaction.client.channels.fetch(channelId);
        await channelCarousel.startChannelCarousel(channel, guildId, channelId);
    } else {
        // 没有条目了，停止轮播
        channelCarousel.stopChannelCarousel(guildId, channelId);
    }
}

