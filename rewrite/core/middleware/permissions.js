/**
 * 权限检查中间件
 * 验证用户是否有执行权限
 */
export async function permissionsMiddleware(ctx, next, config) {
    if (!config.permissions || config.permissions.length === 0) {
        return await next();
    }

    if (!ctx.guild || !ctx.member) {
        await ctx.error('此命令只能在服务器中使用', true);
        return;
    }

    const roleMapping = getRoleMapping(ctx.config, config.permissions);
    const hasPermission = ctx.member.roles.cache.some(role =>
        roleMapping.includes(role.id)
    );

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
function getRoleMapping(config, permissions) {
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

export { getRoleMapping };

