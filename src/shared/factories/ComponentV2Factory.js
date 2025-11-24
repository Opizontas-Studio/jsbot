import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    SectionBuilder,
    SeparatorBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextDisplayBuilder,
    ThumbnailBuilder
} from 'discord.js';

/**
 * Component V2 工厂类
 * 提供构建 Discord Component V2 消息的工具函数
 */
export class ComponentV2Factory {
    static Colors = {
        DISCORD_BLUE: [88, 101, 242],
        SUCCESS: [87, 242, 135],
        WARNING: [254, 231, 92],
        ERROR: [237, 66, 69],
        INFO: [0, 170, 255],
        PURPLE: [155, 89, 182],
        PINK: [235, 69, 158]
    };

    static Emojis = {
        SUCCESS: '✅',
        ERROR: '❌',
        WARNING: '⚠️',
        INFO: 'ℹ️',
        LOADING: '⏳',
        LINK: '🔗',
        USER: '👤',
        CLOCK: '⏰',
        STAR: '⭐',
        FIRE: '🔥',
        HEART: '❤️',
        LEAVE: '🚪'
    };

    /**
     * 创建基础容器
     * @param {Array<number>} [accentColor] - RGB颜色数组 [r, g, b]
     * @returns {ContainerBuilder}
     */
    static createContainer(accentColor = null) {
        const container = new ContainerBuilder();
        if (accentColor) {
            container.setAccentColor(accentColor);
        }
        return container;
    }

    /**
     * 创建 Component V2 消息对象（自动添加必需的标志）
     * @param {ContainerBuilder|Array<ContainerBuilder>} containers - 容器或容器数组
     * @param {Object} [options] - 额外选项
     * @param {Array<string>} [options.additionalFlags] - 额外的消息标志（如 'Ephemeral'）
     * @param {Array<ActionRowBuilder>} [options.actionRows] - 额外的 ActionRow（按钮等）
     * @returns {Object} Discord 消息对象，包含 components 和 flags
     */
    static createMessage(containers, options = {}) {
        const { additionalFlags = [], actionRows = [] } = options;

        // 统一处理容器格式
        const componentArray = Array.isArray(containers) ? containers : [containers];

        // 添加 ActionRows（如果有）
        if (actionRows.length > 0) {
            componentArray.push(...actionRows);
        }

        // 合并标志：始终包含 IsComponentsV2，加上额外的标志
        const flags = [MessageFlags.IsComponentsV2, ...additionalFlags];

        return {
            components: componentArray,
            flags
        };
    }

    /**
     * 添加标题
     * @param {ContainerBuilder} container - 容器
     * @param {string} text - 标题文本
     * @param {number} [level=1] - 标题级别 (1-6)
     */
    static addHeading(container, text, level = 1) {
        const prefix = '#'.repeat(Math.max(1, Math.min(6, level)));
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${prefix} ${text}`));
    }

    /**
     * 添加普通文本
     * @param {ContainerBuilder} container - 容器
     * @param {string} content - 文本内容（支持Markdown）
     */
    static addText(container, content) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
    }

    /**
     * 添加分隔线
     * @param {ContainerBuilder} container - 容器
     */
    static addSeparator(container) {
        container.addSeparatorComponents(new SeparatorBuilder());
    }

    /**
     * 添加Section（带缩略图或按钮附件）
     * @param {ContainerBuilder} container - 容器
     * @param {string} content - 内容文本
     * @param {Object} [accessory] - 附件配置
     * @param {string} accessory.type - 附件类型: 'thumbnail' | 'button'
     * @param {string} [accessory.url] - 缩略图URL（type=thumbnail时）
     * @param {ButtonBuilder} [accessory.button] - 按钮（type=button时）
     */
    static addSection(container, content, accessory = null) {
        const section = new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

        if (accessory) {
            if (accessory.type === 'button' && accessory.button) {
                section.setButtonAccessory(accessory.button);
            } else if (accessory.type === 'thumbnail' && accessory.url) {
                section.setThumbnailAccessory(new ThumbnailBuilder().setURL(accessory.url));
            }
        }

        container.addSectionComponents(section);
    }

    /**
     * 添加时间戳
     * @param {ContainerBuilder} container - 容器
     * @param {number} [timestamp] - Unix时间戳（秒），默认为当前时间
     */
    static addTimestamp(container, timestamp = null) {
        const ts = timestamp || Math.floor(Date.now() / 1000);
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`*⏰ <t:${ts}:F>*`));
    }

    /**
     * 创建按钮
     * @param {Object} config - 按钮配置
     * @param {string} config.customId - 自定义ID
     * @param {string} config.label - 按钮标签
     * @param {string} [config.style='primary'] - 按钮样式: 'primary' | 'secondary' | 'success' | 'danger' | 'link'
     * @param {string} [config.emoji] - 表情符号
     * @param {boolean} [config.disabled=false] - 是否禁用
     * @param {string} [config.url] - URL（仅link样式）
     * @returns {ButtonBuilder}
     */
    static createButton({ customId, label, style = 'primary', emoji, disabled = false, url }) {
        const styleMap = {
            primary: ButtonStyle.Primary,
            secondary: ButtonStyle.Secondary,
            success: ButtonStyle.Success,
            danger: ButtonStyle.Danger,
            link: ButtonStyle.Link
        };

        const button = new ButtonBuilder()
            .setLabel(label)
            .setStyle(styleMap[style] || ButtonStyle.Primary)
            .setDisabled(disabled);

        if (style === 'link' && url) {
            button.setURL(url);
        } else if (customId) {
            button.setCustomId(customId);
        }

        if (emoji) {
            button.setEmoji(emoji);
        }

        return button;
    }

    /**
     * 创建按钮行
     * @param {Array<ButtonBuilder>} buttons - 按钮数组（最多5个）
     * @returns {ActionRowBuilder}
     */
    static createButtonRow(buttons) {
        if (buttons.length > 5) {
            throw new Error('ActionRow最多支持5个按钮');
        }
        return new ActionRowBuilder().addComponents(...buttons);
    }

    /**
     * 添加分页选择菜单
     * @param {ContainerBuilder} container - 容器
     * @param {Object} config - 分页配置
     * @param {string} config.baseId - 基础ID前缀
     * @param {number} config.currentPage - 当前页码
     * @param {number} config.totalPages - 总页数
     * @param {number} [config.totalRecords] - 总记录数（可选）
     * @param {number} [config.currentGroup] - 当前分组（可选）
     */
    static addPaginationSelectMenu(container, { baseId, currentPage, totalPages, totalRecords, currentGroup }) {
        // 只有1页时不添加分页菜单
        if (totalPages <= 1) return;

        const MAX_OPTIONS = 25; // Discord选择菜单最多25个选项

        // 计算当前分组
        const group = currentGroup !== undefined ? currentGroup : Math.floor((currentPage - 1) / MAX_OPTIONS);
        const totalGroups = Math.ceil(totalPages / MAX_OPTIONS);

        // 计算当前分组的页码范围
        const groupStartPage = group * MAX_OPTIONS + 1;
        const groupEndPage = Math.min((group + 1) * MAX_OPTIONS, totalPages);

        // 生成页码选项
        const options = [];
        for (let i = groupStartPage; i <= groupEndPage; i++) {
            const option = new StringSelectMenuOptionBuilder().setLabel(`第 ${i} 页`).setValue(String(i));

            if (i === currentPage) {
                option.setDescription('当前页').setEmoji('📍');
            }

            options.push(option);
        }

        // 构建placeholder
        let placeholder = `📄 第 ${currentPage}/${totalPages} 页`;
        if (totalRecords !== undefined) {
            placeholder += ` · 共 ${totalRecords} 项`;
        }
        if (totalGroups > 1) {
            placeholder += ` · 分组 ${group + 1}/${totalGroups}`;
        }
        placeholder += ' - 点击跳转';

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`${baseId}_select`)
            .setPlaceholder(placeholder)
            .addOptions(options);

        const actionRow = new ActionRowBuilder().addComponents(selectMenu);
        container.addActionRowComponents(actionRow);

        // 如果有多个分组，添加分组导航按钮
        if (totalGroups > 1) {
            this.addPaginationGroupButtons(
                container,
                baseId,
                group,
                totalGroups,
                groupStartPage,
                groupEndPage,
                totalPages
            );
        }
    }

    /**
     * 添加分组导航按钮
     * @private
     */
    static addPaginationGroupButtons(
        container,
        baseId,
        currentGroup,
        totalGroups,
        groupStartPage,
        groupEndPage,
        totalPages
    ) {
        const buttons = [];

        // 显示当前分组范围
        const rangeLabel = `${groupStartPage}-${groupEndPage}页`;
        buttons.push(
            this.createButton({
                customId: `${baseId}_group_info`,
                label: rangeLabel,
                style: 'secondary',
                disabled: true
            })
        );

        // 下一组按钮（循环）
        const nextGroup = (currentGroup + 1) % totalGroups;
        buttons.push(
            this.createButton({
                customId: `${baseId}_group_${currentGroup}_next`,
                label: `下一组 (${nextGroup + 1}/${totalGroups})`,
                style: 'primary',
                emoji: '➡️'
            })
        );

        const actionRow = new ActionRowBuilder().addComponents(...buttons);
        container.addActionRowComponents(actionRow);
    }

    /**
     * 创建选择菜单行
     * @param {Object} config - 选择菜单配置
     * @param {string} config.customId - 自定义ID
     * @param {string} config.placeholder - 占位符文本
     * @param {Array<Object>} config.options - 选项数组
     * @param {number} [config.minValues=1] - 最小选择数
     * @param {number} [config.maxValues=1] - 最大选择数
     * @returns {ActionRowBuilder}
     */
    static createSelectMenuRow({ customId, placeholder, options, minValues = 1, maxValues = 1 }) {
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(placeholder)
            .setMinValues(minValues)
            .setMaxValues(maxValues)
            .addOptions(
                options.map(opt => {
                    const option = new StringSelectMenuOptionBuilder().setLabel(opt.label).setValue(opt.value);
                    if (opt.description) option.setDescription(opt.description);
                    if (opt.emoji) option.setEmoji(opt.emoji);
                    if (opt.default) option.setDefault(true);
                    return option;
                })
            );

        return new ActionRowBuilder().addComponents(selectMenu);
    }

    /**
     * 构建空状态消息
     * @param {string} message - 消息文本
     * @param {Array<number>} [color] - 容器颜色
     * @returns {Array<ContainerBuilder>}
     */
    static buildEmptyStateMessage(message, color = null) {
        const container = this.createContainer(color || this.Colors.INFO);
        this.addText(container, message);
        return [container];
    }

    /**
     * 统一的标准消息构建器
     *
     * @param {string} type - 消息类型: 'error' | 'success' | 'warning' | 'info' | 'progress' | 'timeout'
     * @param {string|Object} titleOrConfig - 标题文本或完整配置对象
     * @param {string} [messageText] - 消息内容（仅快捷调用时）
     *
     * @example
     * // 快捷调用
     * ComponentV2Factory.createStandardMessage('error', '操作失败', '请稍后重试')
     * ComponentV2Factory.createStandardMessage('success', '操作成功')
     *
     * @example
     * // 对象配置调用（更多控制）
     * ComponentV2Factory.createStandardMessage('error', {
     *   title: '操作失败',
     *   message: ['错误详情', '请联系管理员'],
     *   emoji: '❌',
     *   headingLevel: 2,
     *   addSeparator: true,
     *   additionalFlags: ['Ephemeral']
     * })
     *
     * @returns {Object} 完整的Discord消息对象（包含 components 和 flags）
     */
    static createStandardMessage(type, titleOrConfig, messageText) {
        // 类型配置映射
        const typeConfig = {
            error: { color: this.Colors.ERROR, defaultEmoji: '❌' },
            success: { color: this.Colors.SUCCESS, defaultEmoji: '✅' },
            warning: { color: this.Colors.WARNING, defaultEmoji: '⚠️' },
            info: { color: this.Colors.INFO, defaultEmoji: 'ℹ️' },
            progress: { color: this.Colors.INFO, defaultEmoji: '⏳' },
            timeout: { color: this.Colors.WARNING, defaultEmoji: '⏰' }
        };

        const config = typeConfig[type];
        if (!config) {
            throw new Error(`Unknown message type: ${type}. Valid types: ${Object.keys(typeConfig).join(', ')}`);
        }

        // 解析参数：支持两种调用方式
        let options;
        if (typeof titleOrConfig === 'string') {
            // 快捷调用：(type, title, message)
            options = {
                title: titleOrConfig,
                message: messageText || '',
                emoji: config.defaultEmoji,
                headingLevel: 2,
                addSeparator: false,
                additionalFlags: []
            };
        } else {
            // 对象配置调用：(type, { title, message, ... })
            options = {
                emoji: config.defaultEmoji,
                headingLevel: 2,
                addSeparator: false,
                additionalFlags: [],
                ...titleOrConfig
            };
        }

        // 构建消息
        const container = this.createContainer(config.color);

        // 添加标题（如果有）
        if (options.title) {
            const titleText = options.emoji ? `${options.emoji} ${options.title}` : options.title;
            this.addHeading(container, titleText, options.headingLevel);
        }

        // 添加分隔符（如果需要）
        if (options.addSeparator && options.title) {
            this.addSeparator(container);
        }

        // 添加消息内容
        if (options.message) {
            // 支持字符串或字符串数组
            const messageContent = Array.isArray(options.message) ? options.message.join('\n') : options.message;
            this.addText(container, messageContent);
        }

        // 使用统一的 createMessage 方法返回完整消息对象
        return this.createMessage(container, {
            additionalFlags: options.additionalFlags
        });
    }
}
