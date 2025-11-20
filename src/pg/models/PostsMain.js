import { DataTypes } from 'sequelize';

/**
 * PostsMain模型 - 只读权限
 * 帖子主表，存储论坛帖子的所有信息
 */
export default function definePostsMain(sequelize) {
    const PostsMain = sequelize.define('PostsMain', {
        thread_id: {
            type: DataTypes.BIGINT,
            primaryKey: true,
            allowNull: false,
            comment: '帖子ID（主键）',
        },
        first_message_id: {
            type: DataTypes.BIGINT,
            allowNull: false,
            comment: '首条消息ID',
        },
        author_id: {
            type: DataTypes.BIGINT,
            allowNull: false,
            comment: '作者用户ID',
        },
        channel_id: {
            type: DataTypes.BIGINT,
            allowNull: false,
            comment: '频道ID',
        },
        channel_name: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: '频道名称',
        },
        guild_id: {
            type: DataTypes.BIGINT,
            allowNull: false,
            comment: '服务器ID',
        },
        guild_name: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: '服务器名称',
        },
        created_at: {
            type: DataTypes.DATE,
            allowNull: false,
            comment: '创建时间',
        },
        reaction_count: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 0,
            comment: '反应数量',
        },
        reply_count: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 0,
            comment: '回复数量',
        },
        last_active_at: {
            type: DataTypes.DATE,
            allowNull: false,
            comment: '最后活跃时间',
        },
        jump_url: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: '跳转链接',
        },
        attachment_urls: {
            type: DataTypes.TEXT, // json array string, ["url1", "url2", "url3", "url4"]
            allowNull: true,
            comment: '附件链接',
        },
        updated_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: '更新时间',
        },
        updated_jump_url: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '更新消息跳转链接',
        },
        update_count: {
            type: DataTypes.INTEGER,
            allowNull: false,
            defaultValue: 0,
            comment: '更新次数',
        },
        tags: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '标签',
        },
        is_valid: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            comment: '是否有效',
        },
        is_locked: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            comment: '是否锁定',
        },
        is_deleted: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            comment: '是否删除',
        },
        in_forum: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            comment: '是否在论坛中',
        },
        delete_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: '删除时间',
        },
        title: {
            type: DataTypes.TEXT,
            allowNull: false,
            comment: '标题',
        },
        first_message_content: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '首条消息内容',
        },
        title_tokenized: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '标题分词',
        },
        content_tokenized: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '内容分词',
        },
        search_vector: {
            type: DataTypes.TEXT, // tsvector在Sequelize中用TEXT表示
            allowNull: true,
            comment: '搜索向量',
        },
    }, {
        tableName: 'posts_main',
        freezeTableName: true,
        timestamps: false, // 不使用Sequelize的自动时间戳
        // 只读配置：禁用所有写操作的钩子
        hooks: {
            beforeCreate: () => {
                throw new Error('posts_main表为只读表，不允许创建操作');
            },
            beforeUpdate: () => {
                throw new Error('posts_main表为只读表，不允许更新操作');
            },
            beforeDestroy: () => {
                throw new Error('posts_main表为只读表，不允许删除操作');
            },
            beforeBulkCreate: () => {
                throw new Error('posts_main表为只读表，不允许批量创建操作');
            },
            beforeBulkUpdate: () => {
                throw new Error('posts_main表为只读表，不允许批量更新操作');
            },
            beforeBulkDestroy: () => {
                throw new Error('posts_main表为只读表，不允许批量删除操作');
            },
        },
        indexes: [
            { fields: ['author_id'] },
            { fields: ['channel_id'] },
            { fields: ['created_at'] },
            { fields: ['reaction_count'] },
            { fields: ['reply_count'] },
            { fields: ['last_active_at'] },
        ],
        comment: '帖子主表（只读）',
    });

    return PostsMain;
}

