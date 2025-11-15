import definePostsMain from './PostsMain.js';
import defineUserData from './UserData.js';
import definePostMembers from './PostMembers.js';
import defineUserRoles from './UserRoles.js';

/**
 * 初始化所有数据模型
 * @param {import('sequelize').Sequelize} sequelize - Sequelize实例
 * @returns {Object} 包含所有模型的对象
 */
export function initModels(sequelize) {
    const models = {
        // 只读模型
        PostsMain: definePostsMain(sequelize),
        
        // 读写模型
        UserData: defineUserData(sequelize),
        PostMembers: definePostMembers(sequelize),
        UserRoles: defineUserRoles(sequelize),
    };

    // 定义模型之间的关联关系（如果需要）
    // 例如：
    // models.PostsMain.hasMany(models.PostMembers, { foreignKey: 'thread_id' });
    // models.PostMembers.belongsTo(models.PostsMain, { foreignKey: 'thread_id' });
    // models.UserData.hasMany(models.PostMembers, { foreignKey: 'user_id' });
    // models.PostMembers.belongsTo(models.UserData, { foreignKey: 'user_id' });

    return models;
}

export default initModels;

