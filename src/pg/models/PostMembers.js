import { DataTypes } from 'sequelize';

/**
 * PostMembers模型 - 读写权限
 * 帖子成员表，记录用户与帖子的关系
 */
export default function definePostMembers(sequelize) {
    const PostMembers = sequelize.define('PostMembers', {
        user_id: {
            type: DataTypes.BIGINT,
            primaryKey: true,
            allowNull: false,
            comment: '用户ID（复合主键之一）',
        },
        thread_id: {
            type: DataTypes.BIGINT,
            primaryKey: true,
            allowNull: false,
            comment: '线程ID（复合主键之一）',
        },
        is_thread_owner: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            comment: '是否为帖子所有者',
        },
        first_join_at: {
            type: DataTypes.DATE,
            allowNull: false,
            comment: '首次加入时间',
        },
        last_join_at: {
            type: DataTypes.DATE,
            allowNull: false,
            comment: '最后加入时间',
        },
        last_leave_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: '最后离开时间',
        },
        is_leave: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            comment: '是否已离开',
        },
        message_count: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 0,
            comment: '消息数量',
        },
        last_message_id: {
            type: DataTypes.BIGINT,
            allowNull: true,
            comment: '最后消息ID',
        },
        last_message_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: '最后消息时间',
        },
    }, {
        tableName: 'post_members',
        freezeTableName: true,
        timestamps: false, // 表中没有Sequelize的默认时间戳字段
        comment: '帖子成员表（读写）',
    });

    return PostMembers;
}

