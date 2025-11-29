import { DataTypes } from 'sequelize';

/**
 * Roles模型 - 读写权限
 * 存储身份组的数据，支持软删除
 */
export default function defineRoles(sequelize) {
    const Roles = sequelize.define('Roles', {
        role_id: {
            type: DataTypes.BIGINT,
            primaryKey: true,
            comment: '身份组ID',
        },
        role_name: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: '身份组名称',
        },
        role_icon_url: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '身份组图标URL',
        },
        role_emoji: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '身份组Emoji',
        },
        role_primary_color: {
            type: DataTypes.BIGINT,
            allowNull: true,
            comment: '身份组主要颜色',
        },
        role_secondary_color: {
            type: DataTypes.BIGINT,
            allowNull: true,
            comment: '身份组次要颜色',
        },
        role_tertiary_color: {
            type: DataTypes.BIGINT,
            allowNull: true,
            comment: '身份组第三颜色',
        },
        is_deleted: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
            comment: '是否已删除（软删除）',
        },
        delete_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: '删除时间',
        },
    }, {
        tableName: 'roles',
        freezeTableName: true,
        timestamps: false,
        comment: '身份组表',
        indexes: [
            {
                name: 'idx_roles_role_id',
                fields: ['role_id']
            }
        ]
    });

    return Roles;
}

