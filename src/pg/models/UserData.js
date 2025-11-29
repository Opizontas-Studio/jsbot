import { DataTypes } from 'sequelize';

/**
 * UserData模型 - 读写权限
 * 用户数据表，存储用户的统计信息
 */
export default function defineUserData(sequelize) {
    const UserData = sequelize.define('UserData', {
        user_id: {
            type: DataTypes.BIGINT,
            primaryKey: true,
            allowNull: false,
            comment: '用户ID（主键）',
        },
        user_username: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: '用户名',
        },
        user_nickname: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '用户昵称',
        },
        user_global_name: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '用户全局名称',
        },
        user_avatar_url: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '用户头像URL',
        },
        user_thread_count: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 0,
            comment: '用户创建的帖子数',
        },
        user_message_count: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 0,
            comment: '用户消息数',
        },
        user_update_count: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 0,
            comment: '用户发布更新数',
        },
        user_credit_lv1: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 0,
            comment: '用户积分lv1',
        },
        user_credit_lv2: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 0,
            comment: '用户积分lv2',
        },
        user_credit_lv3: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 0,
            comment: '用户积分lv3',
        },
    }, {
        tableName: 'user_data',
        freezeTableName: true,
        timestamps: false, // 表中没有Sequelize的默认时间戳字段
        comment: '用户数据表（读写）',
    });

    return UserData;
}

