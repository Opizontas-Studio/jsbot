import { ChannelType } from 'discord.js';

/**
 * Usage 验证器集合
 * 每个验证器函数返回 { valid: boolean, reason: string }
 */

// ==================== 环境相关验证器 ====================

/**
 * 验证是否在服务器内
 */
export function validateInGuild(ctx) {
    return {
        valid: !!ctx.guild,
        reason: '此功能只能在服务器中使用'
    };
}

/**
 * 验证是否在私信中
 */
export function validateInDM(ctx) {
    return {
        valid: !ctx.guild && ctx.channel?.type === ChannelType.DM,
        reason: '此功能只能在私信中使用'
    };
}

/**
 * 验证是否在线程内
 */
export function validateInThread(ctx) {
    const isThread =
        ctx.channel?.isThread?.() ||
        [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(
            ctx.channel?.type
        );

    return {
        valid: isThread,
        reason: '此功能只能在帖子中使用'
    };
}

/**
 * 验证是否在公共线程
 */
export function validateInPublicThread(ctx) {
    return {
        valid: ctx.channel?.type === ChannelType.PublicThread,
        reason: '此功能只能在公开子区中使用'
    };
}

/**
 * 验证是否在私密线程
 */
export function validateInPrivateThread(ctx) {
    return {
        valid: ctx.channel?.type === ChannelType.PrivateThread,
        reason: '此功能只能在私密子区中使用'
    };
}

/**
 * 验证是否在论坛帖子中
 */
export function validateInForumPost(ctx) {
    const isForumPost =
        ctx.channel?.type === ChannelType.PublicThread && ctx.channel?.parent?.type === ChannelType.GuildForum;

    return {
        valid: isForumPost,
        reason: '此功能只能在论坛帖子中使用'
    };
}

/**
 * 验证是否在公共频道（非线程）
 */
export function validateInPublicChannel(ctx) {
    const publicChannelTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];

    return {
        valid: publicChannelTypes.includes(ctx.channel?.type),
        reason: '此功能只能在文字频道中使用'
    };
}

/**
 * 验证是否在语音频道
 */
export function validateInVoiceChannel(ctx) {
    return {
        valid: ctx.member?.voice?.channel != null,
        reason: '此功能只能在语音频道中使用'
    };
}

// ==================== 身份相关验证器 ====================

/**
 * 验证是否是线程所有者
 */
export function validateIsThreadOwner(ctx) {
    if (!ctx.channel?.isThread?.()) {
        return {
            valid: false,
            reason: '此功能只能在帖子中使用'
        };
    }

    return {
        valid: ctx.channel.ownerId === ctx.user.id,
        reason: '只有帖子创建者可以使用此功能'
    };
}

/**
 * 验证是否是频道/线程创建者
 */
export function validateIsChannelOwner(ctx) {
    // 线程有 ownerId
    if (ctx.channel?.ownerId) {
        return {
            valid: ctx.channel.ownerId === ctx.user.id,
            reason: '只有子区创建者可以使用此功能'
        };
    }

    // 普通频道检查服务器所有者
    return {
        valid: ctx.guild?.ownerId === ctx.user.id,
        reason: '只有服务器所有者可以使用此功能'
    };
}

/**
 * 验证是否是服务器所有者
 */
export function validateIsServerOwner(ctx) {
    return {
        valid: ctx.guild?.ownerId === ctx.user.id,
        reason: '只有服务器所有者可以使用此功能'
    };
}

/**
 * 验证是否是消息作者（用于消息上下文菜单）
 */
export function validateIsMessageAuthor(ctx) {
    if (!ctx.targetMessage) {
        return {
            valid: false,
            reason: '此功能只能在消息上下文菜单中使用'
        };
    }

    return {
        valid: ctx.targetMessage.author.id === ctx.user.id,
        reason: '只能对自己发送的消息执行此操作'
    };
}

/**
 * 验证目标不是自己（用于用户上下文菜单）
 */
export function validateIsNotSelf(ctx) {
    if (!ctx.targetUser) {
        return {
            valid: true, // 非用户上下文菜单，跳过验证
            reason: ''
        };
    }

    return {
        valid: ctx.targetUser.id !== ctx.user.id,
        reason: '不能对自己发送的消息执行此操作'
    };
}

/**
 * 验证目标是自己（用于用户上下文菜单）
 */
export function validateIsTargetSelf(ctx) {
    if (!ctx.targetUser) {
        return {
            valid: false,
            reason: '此功能只能在用户上下文菜单中使用'
        };
    }

    return {
        valid: ctx.targetUser.id === ctx.user.id,
        reason: '只能对自己执行此操作'
    };
}

/**
 * 验证目标不是机器人
 */
export function validateTargetNotBot(ctx) {
    if (ctx.targetUser) {
        return {
            valid: !ctx.targetUser.bot,
            reason: '不能对机器人执行此操作'
        };
    }

    if (ctx.targetMessage) {
        return {
            valid: !ctx.targetMessage.author.bot,
            reason: '不能对机器人发送的消息执行此操作'
        };
    }

    return { valid: true, reason: '' };
}

/**
 * 验证目标是机器人
 */
export function validateTargetIsBot(ctx) {
    if (ctx.targetUser) {
        return {
            valid: ctx.targetUser.bot,
            reason: '只能对机器人执行此操作'
        };
    }

    if (ctx.targetMessage) {
        return {
            valid: ctx.targetMessage.author.bot,
            reason: '只能对机器人的消息执行此操作'
        };
    }

    return {
        valid: false,
        reason: '此功能需要目标为机器人'
    };
}

/**
 * 验证用户是否可以管理目标用户（角色层级检查）
 */
export function validateCanModerateTarget(ctx) {
    if (!ctx.targetUser || !ctx.guild) {
        return {
            valid: false,
            reason: '此功能只能在服务器的用户上下文菜单中使用'
        };
    }

    // Bot 所有者可以管理任何人
    const targetMember = ctx.guild.members.cache.get(ctx.targetUser.id);
    if (!targetMember) {
        return {
            valid: false,
            reason: '目标用户不在此服务器'
        };
    }

    // 服务器所有者可以管理任何人
    if (ctx.guild.ownerId === ctx.user.id) {
        return { valid: true, reason: '' };
    }

    // 不能管理服务器所有者
    if (ctx.guild.ownerId === ctx.targetUser.id) {
        return {
            valid: false,
            reason: '不能对服务器所有者执行此操作'
        };
    }

    // 检查角色层级
    const executorMember = ctx.member;
    const executorHighestRole = executorMember.roles.highest;
    const targetHighestRole = targetMember.roles.highest;

    if (executorHighestRole.position <= targetHighestRole.position) {
        return {
            valid: false,
            reason: '你的身份组不足以管理此用户'
        };
    }

    return { valid: true, reason: '' };
}

// ==================== 验证器映射表 ====================

/**
 * 所有可用的验证器
 */
export const VALIDATORS = {
    // 环境相关
    inGuild: validateInGuild,
    inDM: validateInDM,
    inThread: validateInThread,
    inPublicThread: validateInPublicThread,
    inPrivateThread: validateInPrivateThread,
    inForumPost: validateInForumPost,
    inPublicChannel: validateInPublicChannel,
    inVoiceChannel: validateInVoiceChannel,

    // 身份相关
    isThreadOwner: validateIsThreadOwner,
    isChannelOwner: validateIsChannelOwner,
    isServerOwner: validateIsServerOwner,
    isMessageAuthor: validateIsMessageAuthor,
    isTargetSelf: validateIsTargetSelf,
    isNotSelf: validateIsNotSelf,
    targetNotBot: validateTargetNotBot,
    targetIsBot: validateTargetIsBot,
    canModerateTarget: validateCanModerateTarget
};
