import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRoleMapping, permissionsMiddleware } from '../../../core/middleware/permissions.js';

describe('permissions middleware', () => {
    let mockLogger;
    let mockCtx;
    let mockConfig;
    let next;

    beforeEach(() => {
        mockLogger = {
            info: vi.fn(),
            debug: vi.fn()
        };

        // Mock Discord.js Collection (extends Map with some method)
        const roleCache = new Map();
        roleCache.set('mod123', { id: 'mod123', name: 'Moderator' });
        roleCache.some = function(callback) {
            for (const [key, value] of this) {
                if (callback(value, key, this)) return true;
            }
            return false;
        };

        mockCtx = {
            user: { id: 'user123' },
            guild: { id: 'guild123' },
            member: {
                roles: {
                    cache: roleCache
                }
            },
            config: {
                ModeratorRoleIds: ['mod123'],
                AdministratorRoleIds: ['admin123']
            },
            error: vi.fn().mockResolvedValue({})
        };

        mockConfig = {
            id: 'test.command',
            permissions: ['moderator']
        };

        next = vi.fn().mockResolvedValue({});
    });

    it('应该在无权限配置时跳过检查', async () => {
        const middleware = permissionsMiddleware(mockLogger);
        const configWithoutPerms = { ...mockConfig, permissions: [] };

        await middleware(mockCtx, next, configWithoutPerms);

        expect(mockLogger.info).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalled();
    });

    it('应该拒绝非服务器命令', async () => {
        const middleware = permissionsMiddleware(mockLogger);
        const ctxWithoutGuild = { ...mockCtx, guild: null, member: null };

        await middleware(ctxWithoutGuild, next, mockConfig);

        expect(ctxWithoutGuild.error).toHaveBeenCalledWith(
            '此命令只能在服务器中使用',
            true
        );
        expect(next).not.toHaveBeenCalled();
    });

    it('应该允许有权限的用户', async () => {
        const middleware = permissionsMiddleware(mockLogger);

        await middleware(mockCtx, next, mockConfig);

        expect(mockLogger.debug).toHaveBeenCalledWith({
            msg: '权限检查通过',
            userId: 'user123'
        });
        expect(next).toHaveBeenCalled();
    });

    it('应该拒绝无权限的用户', async () => {
        const middleware = permissionsMiddleware(mockLogger);
        const emptyCache = new Map();
        emptyCache.some = function() { return false; };
        emptyCache.map = function(callback) {
            const result = [];
            for (const [key, value] of this) {
                result.push(callback(value, key, this));
            }
            return result;
        };
        mockCtx.member.roles.cache = emptyCache; // 无任何角色

        await middleware(mockCtx, next, mockConfig);

        expect(mockLogger.info).toHaveBeenCalledWith({
            msg: '权限检查失败',
            userId: 'user123',
            required: ['moderator'],
            userRoles: []
        });
        expect(mockCtx.error).toHaveBeenCalledWith(
            '你没有权限使用此命令',
            true
        );
        expect(next).not.toHaveBeenCalled();
    });

    it('应该检查administrator权限', async () => {
        const middleware = permissionsMiddleware(mockLogger);
        const configWithAdmin = { ...mockConfig, permissions: ['administrator'] };

        const adminCache = new Map();
        adminCache.set('admin123', { id: 'admin123' });
        adminCache.some = function(callback) {
            for (const [key, value] of this) {
                if (callback(value, key, this)) return true;
            }
            return false;
        };
        mockCtx.member.roles.cache = adminCache;

        await middleware(mockCtx, next, configWithAdmin);

        expect(next).toHaveBeenCalled();
    });

    it('应该支持多个权限（任一满足即可）', async () => {
        const middleware = permissionsMiddleware(mockLogger);
        const configWithMultiPerms = {
            ...mockConfig,
            permissions: ['moderator', 'administrator']
        };

        await middleware(mockCtx, next, configWithMultiPerms);

        expect(next).toHaveBeenCalled();
    });
});

describe('getRoleMapping', () => {
    let mockConfig;

    beforeEach(() => {
        mockConfig = {
            ModeratorRoleIds: ['mod1', 'mod2'],
            AdministratorRoleIds: ['admin1'],
            roleIds: {
                custom: ['custom1', 'custom2'],
                single: 'single1'
            }
        };
    });

    it('应该映射moderator权限', () => {
        const roleIds = getRoleMapping(mockConfig, ['moderator']);
        expect(roleIds).toEqual(['mod1', 'mod2']);
    });

    it('应该映射administrator权限', () => {
        const roleIds = getRoleMapping(mockConfig, ['administrator']);
        expect(roleIds).toEqual(['admin1']);
    });

    it('应该映射自定义权限标识', () => {
        const roleIds = getRoleMapping(mockConfig, ['custom']);
        expect(roleIds).toEqual(['custom1', 'custom2']);
    });

    it('应该处理单个角色ID', () => {
        const roleIds = getRoleMapping(mockConfig, ['single']);
        expect(roleIds).toEqual(['single1']);
    });

    it('应该合并多个权限的角色', () => {
        const roleIds = getRoleMapping(mockConfig, ['moderator', 'administrator']);
        expect(roleIds).toEqual(['mod1', 'mod2', 'admin1']);
    });

    it('应该返回空数组当无匹配权限', () => {
        const roleIds = getRoleMapping(mockConfig, ['nonexistent']);
        expect(roleIds).toEqual([]);
    });

    it('应该处理缺少配置的情况', () => {
        const emptyConfig = {};
        const roleIds = getRoleMapping(emptyConfig, ['moderator']);
        expect(roleIds).toEqual([]);
    });
});

