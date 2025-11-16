import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    SectionBuilder,
    SeparatorBuilder,
    TextDisplayBuilder,
    ThumbnailBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} from 'discord.js';

/**
 * Component V2 工厂类
 * 提供构建 Discord Component V2 消息的工具函数
 * 参考：test_bot.js 的实现模式
 */
export class ComponentV2Factory {
    /**
     * 创建基础容器
     * @param {Array<number>} accentColor - RGB颜色数组 [r, g, b]
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
     * 添加标题（使用Markdown标题语法）
     * @param {ContainerBuilder} container - 容器
     * @param {string} text - 标题文本
     * @param {number} level - 标题级别 (1-6)
     */
    static addHeading(container, text, level = 1) {
        const prefix = '#'.repeat(Math.max(1, Math.min(6, level)));
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`${prefix} ${text}`)
        );
    }

    /**
     * 添加普通文本
     * @param {ContainerBuilder} container - 容器
     * @param {string} content - 文本内容（支持Markdown）
     */
    static addText(container, content) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(content)
        );
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
     * @param {Object} accessory - 附件配置
     * @param {string} accessory.type - 附件类型: 'thumbnail' | 'button'
     * @param {string} [accessory.url] - 缩略图URL（type=thumbnail时）
     * @param {Object} [accessory.button] - 按钮配置（type=button时）
     */
    static addSection(container, content, accessory) {
        const section = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

        if (accessory.type === 'button' && accessory.button) {
            section.setButtonAccessory(accessory.button);
        } else if (accessory.type === 'thumbnail' && accessory.url) {
            section.setThumbnailAccessory(new ThumbnailBuilder().setURL(accessory.url));
        }

        container.addSectionComponents(section);
    }

    /**
     * 添加时间戳
     * @param {ContainerBuilder} container - 容器
     */
    static addTimestamp(container) {
        const timestamp = Math.floor(Date.now() / 1000);
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`*⏰ <t:${timestamp}:F>*`)
        );
    }

    /**
     * 创建按钮
     * @param {Object} config - 按钮配置
     * @param {string} config.customId - 自定义ID
     * @param {string} config.label - 按钮标签
     * @param {string} config.style - 按钮样式: 'primary' | 'secondary' | 'success' | 'danger' | 'link'
     * @param {string} [config.emoji] - 表情符号
     * @param {boolean} [config.disabled] - 是否禁用
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
        } else {
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
     * 创建分页选择菜单（添加到Container中）
     * @param {ContainerBuilder} container - 容器
     * @param {Object} config - 分页配置
     * @param {string} config.baseId - 基础ID前缀
     * @param {number} config.currentPage - 当前页码
     * @param {number} config.totalPages - 总页数
     * @param {number} [config.totalRecords] - 总记录数（可选，用于显示在placeholder中）
     * @param {number} [config.currentGroup] - 当前分组（可选，用于超过25页的情况）
     */
    static addPaginationSelectMenu(container, { baseId, currentPage, totalPages, totalRecords, currentGroup }) {
        // 如果只有1页，不添加分页菜单
        if (totalPages <= 1) return;

        const MAX_OPTIONS = 25; // Discord选择菜单最多25个选项
        
        // 计算当前分组（如果未提供）
        // 每组最多显示25页，分组从0开始
        const group = currentGroup !== undefined ? currentGroup : Math.floor((currentPage - 1) / MAX_OPTIONS);
        const totalGroups = Math.ceil(totalPages / MAX_OPTIONS);
        
        // 计算当前分组的页码范围
        const groupStartPage = group * MAX_OPTIONS + 1;
        const groupEndPage = Math.min((group + 1) * MAX_OPTIONS, totalPages);

        // 生成当前分组的页码选项
        const options = [];
        for (let i = groupStartPage; i <= groupEndPage; i++) {
            const option = new StringSelectMenuOptionBuilder()
                .setLabel(`第 ${i} 页`)
                .setValue(String(i));
            
            // 当前页添加描述和emoji
            if (i === currentPage) {
                option.setDescription('当前页')
                      .setEmoji('📍');
            }
            
            options.push(option);
        }

        // 构建placeholder，包含统计信息
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
            this.addPaginationGroupButtons(container, baseId, group, totalGroups, groupStartPage, groupEndPage, totalPages);
        }
    }

    /**
     * 添加分组导航按钮
     * @param {ContainerBuilder} container - 容器
     * @param {string} baseId - 基础ID前缀
     * @param {number} currentGroup - 当前分组（从0开始）
     * @param {number} totalGroups - 总分组数
     * @param {number} groupStartPage - 当前分组起始页
     * @param {number} groupEndPage - 当前分组结束页
     * @param {number} totalPages - 总页数
     */
    static addPaginationGroupButtons(container, baseId, currentGroup, totalGroups, groupStartPage, groupEndPage, totalPages) {
        const buttons = [];
        
        // 显示当前分组范围
        const rangeLabel = `${groupStartPage}-${groupEndPage}页`;
        buttons.push(this.createButton({
            customId: `${baseId}_group_info`,
            label: rangeLabel,
            style: 'secondary',
            disabled: true
        }));
        
        // 下一组按钮（循环：最后一组时切换回第一组）
        // 在customId中包含当前分组，方便计算下一组
        const nextGroup = (currentGroup + 1) % totalGroups;
        buttons.push(this.createButton({
            customId: `${baseId}_group_${currentGroup}_next`,
            label: `下一组 (${nextGroup + 1}/${totalGroups})`,
            style: 'primary',
            emoji: '➡️'
        }));
        
        const actionRow = new ActionRowBuilder().addComponents(...buttons);
        container.addActionRowComponents(actionRow);
    }

    /**
     * 创建选择菜单
     * @param {Object} config - 选择菜单配置
     * @param {string} config.customId - 自定义ID
     * @param {string} config.placeholder - 占位符文本
     * @param {Array<Object>} config.options - 选项数组
     * @param {number} [config.minValues] - 最小选择数
     * @param {number} [config.maxValues] - 最大选择数
     * @returns {ActionRowBuilder}
     */
    static createSelectMenuRow({ customId, placeholder, options, minValues = 1, maxValues = 1 }) {
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(placeholder)
            .setMinValues(minValues)
            .setMaxValues(maxValues)
            .addOptions(options.map(opt => {
                const option = new StringSelectMenuOptionBuilder()
                    .setLabel(opt.label)
                    .setValue(opt.value);
                if (opt.description) option.setDescription(opt.description);
                if (opt.emoji) option.setEmoji(opt.emoji);
                return option;
            }));

        return new ActionRowBuilder().addComponents(selectMenu);
    }

    /**
     * 构建空状态消息
     * @param {string} message - 消息文本
     * @param {Array<number>} [color] - 容器颜色（默认为SUCCESS绿色）
     * @returns {Array<ContainerBuilder>} 包含单个容器的数组
     */
    static buildEmptyStateMessage(message, color = null) {
        const container = this.createContainer(color || this.Colors.SUCCESS);
        this.addText(container, message);
        return [container];
    }

    /**
     * 常用颜色配置
     */
    static Colors = {
        DISCORD_BLUE: [88, 101, 242],
        SUCCESS: [87, 242, 135],
        WARNING: [254, 231, 92],
        ERROR: [237, 66, 69],
        INFO: [0, 170, 255],
        PURPLE: [155, 89, 182],
        PINK: [235, 69, 158]
    };

    /**
     * 常用表情符号
     */
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
}

