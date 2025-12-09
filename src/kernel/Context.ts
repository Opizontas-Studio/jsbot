/**
 * 最小核心上下文，便捷方法通过服务提供
 * @module kernel/Context
 */

import type {
    AnySelectMenuInteraction,
    AutocompleteInteraction,
    ButtonInteraction,
    ChatInputCommandInteraction,
    Guild,
    GuildMember,
    Interaction,
    MessageContextMenuCommandInteraction,
    ModalSubmitInteraction,
    TextBasedChannel,
    User,
    UserContextMenuCommandInteraction
} from 'discord.js';
import type { DependencyContainer, InjectionToken } from 'tsyringe';
import type { GuildConfig } from '../types/config.js';

// Context 基类
export class Context<T extends Interaction = Interaction> {
    constructor(
        public readonly interaction: T,
        public readonly config: GuildConfig,
        private readonly container: DependencyContainer
    ) {}

    // 服务解析
    resolve<S>(token: InjectionToken<S>): S {
        return this.container.resolve(token);
    }

    // 快捷访问器
    get user(): User {
        return this.interaction.user;
    }

    get userId(): string {
        return this.interaction.user.id;
    }

    get guild(): Guild | null {
        return this.interaction.guild;
    }

    get guildId(): string | null {
        return this.interaction.guildId;
    }

    get member(): GuildMember | null {
        return this.interaction.member as GuildMember | null;
    }

    get channel(): TextBasedChannel | null {
        return this.interaction.channel;
    }

    get channelId(): string | null {
        return this.interaction.channelId;
    }

    get inGuild(): boolean {
        return this.interaction.inGuild();
    }

    get isRepliable(): boolean {
        return this.interaction.isRepliable();
    }
}

// 命令上下文
export class CommandContext extends Context<ChatInputCommandInteraction> {
    get options() {
        return this.interaction.options;
    }
}

// 按钮上下文
export class ButtonContext extends Context<ButtonInteraction> {
    get customId(): string {
        return this.interaction.customId;
    }

    get message() {
        return this.interaction.message;
    }
}

// 选择菜单上下文
export class SelectMenuContext extends Context<AnySelectMenuInteraction> {
    get customId(): string {
        return this.interaction.customId;
    }

    get values(): string[] {
        return this.interaction.values;
    }

    get message() {
        return this.interaction.message;
    }
}

// 模态框上下文
export class ModalContext extends Context<ModalSubmitInteraction> {
    get customId(): string {
        return this.interaction.customId;
    }

    getTextInputValue(customId: string): string {
        return this.interaction.fields.getTextInputValue(customId);
    }

    getField(customId: string) {
        return this.interaction.fields.getField(customId);
    }
}

// 自动补全上下文
export class AutocompleteContext extends Context<AutocompleteInteraction> {
    get options() {
        return this.interaction.options;
    }

    get focused() {
        return this.interaction.options.getFocused(true);
    }
}

// 上下文菜单上下文
export class UserContextMenuContext extends Context<UserContextMenuCommandInteraction> {
    get targetUser(): User {
        return this.interaction.targetUser;
    }

    get targetMember(): GuildMember | null {
        return this.interaction.targetMember as GuildMember | null;
    }
}

export class MessageContextMenuContext extends Context<MessageContextMenuCommandInteraction> {
    get targetMessage() {
        return this.interaction.targetMessage;
    }
}

// 类型导出

export type AnyContext =
    | Context
    | CommandContext
    | ButtonContext
    | SelectMenuContext
    | ModalContext
    | AutocompleteContext
    | UserContextMenuContext
    | MessageContextMenuContext;
