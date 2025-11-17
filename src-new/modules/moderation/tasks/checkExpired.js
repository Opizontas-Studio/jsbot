/**
 * 处罚过期检查定时任务
 */

export default {
    type: 'task',
    name: 'checkExpiredPunishments',
    schedule: '*/5 * * * *', // 每5分钟执行一次
    inject: ['punishmentService', 'logger'],

    /**
     * 执行任务
     * @param {Object} deps - 注入的依赖
     */
    async execute({ punishmentService, logger }) {
        logger.info('[Task] Checking expired punishments');

        // 检查并处理过期处罚
        const threshold = Date.now();
        const expired = await punishmentService.checkExpired(threshold);

        if (expired.length > 0) {
            logger.info(`[Task] Found ${expired.length} expired punishments`);
        }
    },
};

