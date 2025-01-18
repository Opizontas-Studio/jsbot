import mongoose from 'mongoose';

const punishmentSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        index: true
    },
    guildId: {
        type: String,
        required: true,
        index: true
    },
    type: {
        type: String,
        required: true,
        enum: ['ban', 'mute', 'warn'],
        index: true
    },
    reason: {
        type: String,
        required: true
    },
    duration: {
        type: Number,  // 持续时间（毫秒），0表示永久
        required: true
    },
    expireAt: {
        type: Date,
        required: true,
        index: true
    },
    executorId: {
        type: String,
        required: true
    },
    status: {
        type: String,
        required: true,
        enum: ['active', 'expired', 'appealed', 'revoked'],
        default: 'active',
        index: true
    },
    synced: {
        type: Boolean,
        default: false,
        index: true
    },
    syncedServers: [{
        type: String
    }],
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// 更新时间中间件
punishmentSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

// 创建复合索引
punishmentSchema.index({ userId: 1, guildId: 1, type: 1 });
punishmentSchema.index({ guildId: 1, status: 1 });
punishmentSchema.index({ expireAt: 1, status: 1 });

// 静态方法
punishmentSchema.statics = {
    /**
     * 创建新的处罚记录
     * @param {Object} data - 处罚数据
     * @returns {Promise<Document>}
     */
    async createPunishment(data) {
        return await this.create(data);
    },

    /**
     * 获取用户在指定服务器的处罚历史
     * @param {String} userId - 用户ID
     * @param {String} guildId - 服务器ID
     * @returns {Promise<Array>}
     */
    async getUserPunishments(userId, guildId) {
        return await this.find({ userId, guildId })
            .sort({ createdAt: -1 });
    },

    /**
     * 获取服务器的活跃处罚
     * @param {String} guildId - 服务器ID
     * @returns {Promise<Array>}
     */
    async getActivePunishments(guildId) {
        return await this.find({
            guildId,
            status: 'active',
            expireAt: { $gt: new Date() }
        });
    },

    /**
     * 更新处罚状态
     * @param {String} id - 处罚ID
     * @param {String} status - 新状态
     * @returns {Promise<Document>}
     */
    async updatePunishmentStatus(id, status) {
        return await this.findByIdAndUpdate(id, 
            { status },
            { new: true }
        );
    }
};

export default mongoose.model('Punishment', punishmentSchema); 