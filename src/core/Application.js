import { MonitoringManager } from '../infrastructure/MonitoringManager.js';
import { createMiddlewareChain } from './bootstrap/middlewares.js';
import { bootstrapCoreServices } from './bootstrap/services.js';
import { registerScheduledTasks } from './bootstrap/tasks.js';
import { ClientFactory } from './ClientFactory.js';
import { Container } from './Container.js';
import { EventListenerManager } from './events/EventListenerManager.js';
import { Logger } from './Logger.js';
import { Registry } from './Registry.js';
import { getVersionInfo } from './utils/version.js';

/**
 * 应用主入口协调器
 * 负责协调各组件的初始化和生命周期，不包含具体业务逻辑
 */
class Application {
    constructor(config) {
        this.config = config;
        this.container = new Container();
        this.logger = null;
        this.registry = null;
        this.client = null;
        this.middlewareChain = null;
        this.monitoringManager = null;
    }

    /**
     * 初始化应用
     */
    async initialize() {
        try {
            // 1. 初始化Logger
            this.logger = new Logger({
                level: this.config.bot?.logLevel || 'info',
                prettyPrint: process.env.NODE_ENV !== 'production'
            });
            this.logger.debug('[Application] 开始初始化');

            // 输出版本信息
            const versionInfo = getVersionInfo(this.logger);
            if (versionInfo) {
                this.logger.info({
                    msg: '📦 应用版本信息',
                    version: versionInfo.version,
                    commit: versionInfo.commitHash,
                    date: versionInfo.commitDate
                });
            }

            // 2. 引导核心服务
            bootstrapCoreServices(this.container, this.config, this.logger);

            // 3. 初始化数据库连接（如有需要）
            if (this.container.has('database')) {
                await this.container.get('database').connect();
            }

            // 4. 初始化Discord客户端
            this.client = ClientFactory.create();
            this.container.registerInstance('client', this.client);

            // 监听clientReady事件
            this.client.once('clientReady', () => this._onClientReady());

            // 5. 初始化Registry
            this.registry = new Registry(this.container, this.logger);
            this.container.registerInstance('registry', this.registry);

            // 6. 创建中间件链
            this.middlewareChain = createMiddlewareChain(this.container);

            // 7. 注册事件监听器
            EventListenerManager.register(
                this.client,
                this.container,
                this.registry,
                this.middlewareChain,
                this.logger
            );

            // 8. 加载共享代码和业务模块
            const modulesPath = this.config.modulesPath ||
                new URL('../modules', import.meta.url).pathname;
            const sharedPath = this.config.sharedPath ||
                new URL('../shared', import.meta.url).pathname;
            await this.registry.loadModules(modulesPath, sharedPath);

            // 9. 注册调度任务
            registerScheduledTasks(this.registry, this.container, this.logger);

            // 10. 验证依赖
            this._validateDependencies();

            this.logger.info('[Application] 初始化完成');
        } catch (error) {
            this.logger?.error({
                msg: '[Application] 初始化失败',
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * 启动应用
     */
    async start() {
        try {
            this.logger.debug('[Application] 正在启动');

            // 登录Discord
            await this.client.login(this.config.token);

            // 等待ready事件
            await this._waitForReady();

            // 部署命令到未部署的服务器
            const deployer = this.container.get('commandDeployer');
            await deployer.deployToAllGuilds();

            this.logger.info('[Application] 启动成功');
        } catch (error) {
            this.logger.error({
                msg: '[Application] 启动失败',
                error: error.message
            });
            throw error;
        }
    }

    /**
     * 停止应用
     */
    async stop() {
        try {
            this.logger.debug('[Application] 正在停止');

            // 停止监控
            if (this.monitoringManager) {
                this.monitoringManager.stop();
            }

            // 停止所有定时任务
            if (this.container.has('schedulerManager')) {
                await this.container.get('schedulerManager').cleanup();
            }

            // 清理队列
            if (this.container.has('queueManager')) {
                const queueManager = this.container.get('queueManager');
                await queueManager.onIdle();
                queueManager.clear();
            }

            // 关闭数据库连接
            if (this.container.has('database')) {
                await this.container.get('database').disconnect();
            }

            // 销毁Discord客户端
            if (this.client) {
                this.client.removeAllListeners();
                await this.client.destroy();
            }

            // 刷新日志
            await this.logger.flush();

            this.logger.info('[Application] 已停止');
        } catch (error) {
            this.logger?.error({
                msg: '[Application] 停止过程出错',
                error: error.message
            });
            throw error;
        }
    }

    /**
     * 客户端就绪处理
     * @private
     */
    _onClientReady() {
            this.logger.info({
                msg: '[Discord] 客户端已就绪',
                user: this.client.user.tag,
                guilds: this.client.guilds.cache.size
            });

        // 初始化监控
        this.monitoringManager = new MonitoringManager(
            this.client,
            this.container,
            this.logger
        );
        this.monitoringManager.start();
    }

    /**
     * 等待客户端ready
     * @private
     */
    async _waitForReady() {
        if (this.client.isReady()) {
            return;
        }

        return new Promise((resolve) => {
            this.client.once('clientReady', resolve);
        });
    }

    /**
     * 验证依赖
     * @private
     */
    _validateDependencies() {
        const errors = this.container.validateAll();

        if (errors.length > 0) {
            this.logger.warn({
                msg: '[Application] 依赖验证发现问题',
                errors
            });
        }
    }

    /**
     * 获取Registry（用于外部访问）
     */
    getRegistry() {
        return this.registry;
    }

    /**
     * 获取Container（用于外部访问）
     */
    getContainer() {
        return this.container;
    }

    /**
     * 获取Client（用于外部访问）
     */
    getClient() {
        return this.client;
    }
}

export { Application };
