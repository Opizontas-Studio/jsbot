import { DataTypes } from 'sequelize';

/**
 * UserRoles模型 - 读写权限
 * 用户角色表，记录用户与角色的映射关系
 */
export default function defineUserRoles(sequelize) {
    const UserRoles = sequelize.define('UserRoles', {
        user_id: {
            type: DataTypes.BIGINT,
            primaryKey: true,
            allowNull: false,
            comment: '用户ID（复合主键之一）',
        },
        role_id: {
            type: DataTypes.BIGINT,
            primaryKey: true,
            allowNull: false,
            comment: '身份组ID（复合主键之一）',
        },
        is_active: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            comment: '是否激活（软删除）',
        },
        updated_at: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
            comment: '最后更新时间',
        },
    }, {
        tableName: 'user_roles',
        freezeTableName: true,
        timestamps: false, // 不使用Sequelize的自动时间戳(createdAt/updatedAt)，我们手动管理
        comment: '用户身份组映射表（读写）',
    });

    return UserRoles;
}

