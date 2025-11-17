/**
 * 权限检查中间件
 * 验证用户是否有执行权限
 */

import { PermissionFlagsBits } from 'discord.js';

export async function permissionsMiddleware(ctx, next, config) {
    if (!config.permissions || config.permissions.length === 0) {
        return await next();
    }

    if (!ctx.guild || !ctx.member) {
        await ctx.error('此命令只能在服务器中使用', true);
        return;
    }

    const roleMapping = getRoleMapping(ctx.config, config.permissions);
    const hasRolePermission = roleMapping.length > 0 && ctx.member.roles.cache.some(role =>
        roleMapping.includes(role.id)
    );

    const hasDiscordPermission = checkDiscordPermission(ctx, config.permissions);
    const hasPermission = hasRolePermission || hasDiscordPermission;

    if (!hasPermission) {
        ctx.logger?.info({
            msg: '权限检查失败',
            userId: ctx.user.id,
            required: config.permissions,
            userRoles: ctx.member.roles.cache.map(r => r.id)
        });

        await ctx.error('你没有权限使用此命令', true);
        return;
    }

    ctx.logger?.debug({
        msg: '权限检查通过',
        userId: ctx.user.id
    });

    await next();
}

/**
 * 获取角色ID映射
 * @param {Object} config - 服务器配置
 * @param {Array<string>} permissions - 权限标识数组
 * @returns {Array<string>} 角色ID数组
 */
export function getRoleMapping(config, permissions) {
    const roleIds = [];

    for (const perm of permissions) {
        const permRoleIds = perm === 'administrator' ? config.roleIds?.administrators :
                           perm === 'moderator' ? config.roleIds?.moderators :
                           config.roleIds?.[perm];

        if (permRoleIds) {
            roleIds.push(...(Array.isArray(permRoleIds) ? permRoleIds : [permRoleIds]));
        }
    }

    return roleIds;
}

/**
 * 检查Discord权限
 * @param {Object} ctx - 上下文
 * @param {Array<string>} permissions - 权限标识数组
 * @returns {boolean} 是否具有权限
 */
function checkDiscordPermission(ctx, permissions = []) {
    if (!ctx.member?.permissions) {
        return false;
    }

    return permissions.some((permission) => {
        if (permission === 'administrator') {
            return ctx.guild?.ownerId === ctx.user.id || ctx.member.permissions.has(PermissionFlagsBits.Administrator);
        }

        if (permission === 'moderator') {
            return ctx.member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
                ctx.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
                ctx.member.permissions.has(PermissionFlagsBits.KickMembers) ||
                ctx.member.permissions.has(PermissionFlagsBits.BanMembers);
        }

        const normalizedKey = toPermissionKey(permission);
        if (normalizedKey && PermissionFlagsBits[normalizedKey]) {
            return ctx.member.permissions.has(PermissionFlagsBits[normalizedKey]);
        }

        return false;
    });
}


/**
 * 将权限标识转换为Discord权限键
 * @param {string} value - 权限标识
 * @returns {string|null} Discord权限键
 */
function toPermissionKey(value) {
    if (!value || typeof value !== 'string') {
        return null;
    }

    if (PermissionFlagsBits[value]) {
        return value;
    }

    const normalized = value
        .split(/[_\s]+/)
        .filter(Boolean)
        .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join('');

    return PermissionFlagsBits[normalized] ? normalized : null;
}
