import mongoose from 'mongoose';

const processSchema = new mongoose.Schema({
    punishmentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Punishment',
        required: true,
        index: true
    },
    type: {
        type: String,
        required: true,
        enum: ['appeal', 'vote', 'debate'],
        index: true
    },
    status: {
        type: String,
        required: true,
        enum: ['pending', 'in_progress', 'completed', 'rejected', 'cancelled'],
        default: 'pending',
        index: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    expireAt: {
        type: Date,
        required: true,
        index: true
    },
    messageIds: [{
        type: String
    }],
    votes: {
        type: Map,
        of: String,
        default: new Map()
    },
    result: {
        type: String,
        enum: ['approved', 'rejected', 'cancelled', null],
        default: null
    },
    reason: {
        type: String,
        default: ''
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// 更新时间中间件
processSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

// 创建复合索引
processSchema.index({ punishmentId: 1, type: 1 });
processSchema.index({ status: 1, expireAt: 1 });

// 静态方法
processSchema.statics = {
    /**
     * 创建新的流程记录
     * @param {Object} data - 流程数据
     * @returns {Promise<Document>}
     */
    async createProcess(data) {
        return await this.create(data);
    },

    /**
     * 获取处罚相关的所有流程
     * @param {String} punishmentId - 处罚ID
     * @returns {Promise<Array>}
     */
    async getPunishmentProcesses(punishmentId) {
        return await this.find({ punishmentId })
            .sort({ createdAt: -1 });
    },

    /**
     * 获取活跃的流程
     * @returns {Promise<Array>}
     */
    async getActiveProcesses() {
        return await this.find({
            status: { $in: ['pending', 'in_progress'] },
            expireAt: { $gt: new Date() }
        });
    },

    /**
     * 更新流程状态
     * @param {String} id - 流程ID
     * @param {String} status - 新状态
     * @param {String} result - 结果
     * @param {String} reason - 原因
     * @returns {Promise<Document>}
     */
    async updateProcessStatus(id, status, result = null, reason = '') {
        return await this.findByIdAndUpdate(id, 
            { status, result, reason },
            { new: true }
        );
    },

    /**
     * 添加投票
     * @param {String} id - 流程ID
     * @param {String} userId - 用户ID
     * @param {String} vote - 投票（approve/reject）
     * @returns {Promise<Document>}
     */
    async addVote(id, userId, vote) {
        const process = await this.findById(id);
        if (!process) return null;

        process.votes.set(userId, vote);
        return await process.save();
    }
};

export default mongoose.model('Process', processSchema); 