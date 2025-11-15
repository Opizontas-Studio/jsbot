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
    }, {
        tableName: 'user_roles',
        freezeTableName: true,
        timestamps: false, // 表中没有Sequelize的默认时间戳字段
        comment: '用户身份组映射表（读写）',
    });

    return UserRoles;
}

