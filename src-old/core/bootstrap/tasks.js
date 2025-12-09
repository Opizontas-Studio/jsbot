/**
 * 将 Registry 中的任务注册到 SchedulerManager
 * @param {import('../Registry.js').Registry} registry
 * @param {import('../Container.js').Container} container
 * @param {import('../Logger.js').Logger} logger
 * @param {Object} [options]
 * @param {string} [options.moduleName] - 仅同步指定模块的任务
 */
export function registerScheduledTasks(registry, container, logger, options = {}) {
    if (!container?.has?.('schedulerManager')) {
        return;
    }

    const scheduler = container.get('schedulerManager');
    const modulePrefix = options.moduleName ? `${options.moduleName}.` : null;
    const tasks = registry.getTasks();

    for (const [taskId, config] of tasks) {
        if (modulePrefix && !taskId.startsWith(modulePrefix)) {
            continue;
        }

        if (!config?.execute || !config?.schedule) {
            logger?.warn?.({
                msg: '[TaskRegistry] 任务配置缺少 execute 或 schedule',
                taskId
            });
            continue;
        }

        const runner = async () => {
            const dependencies = config.inject ? container.resolve(config.inject) : {};
            await config.execute(dependencies, { container });
        };

        try {
            scheduleTask(taskId, config, runner, scheduler, logger);
        } catch (error) {
            logger?.error?.({
                msg: '[TaskRegistry] 注册任务失败',
                taskId,
                error: error.message
            });
        }
    }
}

function scheduleTask(taskId, config, runner, scheduler, logger) {
    const schedule = config.schedule || {};
    const description = config.description || taskId;
    const baseOptions = {
        taskId,
        task: runner,
        description,
        replaceExisting: true
    };

    switch (schedule.type) {
        case 'daily': {
            assertNumber(schedule.hour, 'schedule.hour');
            assertNumber(schedule.minute, 'schedule.minute');
            scheduler.addDailyTask({
                ...baseOptions,
                hour: schedule.hour,
                minute: schedule.minute
            });
            break;
        }
        case 'cron':
        case 'custom': {
            if (!schedule.rule) {
                throw new Error('schedule.rule 不能为空');
            }
            scheduler.addCustomTask({
                ...baseOptions,
                rule: schedule.rule
            });
            break;
        }
        case 'interval':
        default: {
            assertNumber(schedule.interval, 'schedule.interval');
            scheduler.addTask({
                ...baseOptions,
                interval: schedule.interval,
                runImmediately: schedule.runImmediately ?? false,
                startAt: resolveStartAt(schedule.startAt)
            });
        }
    }

    logger?.debug?.({
        msg: '[TaskRegistry] 已注册调度任务',
        taskId,
        schedule: schedule.type || 'interval'
    });
}

function assertNumber(value, field) {
    if (typeof value !== 'number') {
        throw new Error(`${field} 必须是数字`);
    }
}

function resolveStartAt(startAt) {
    if (!startAt) {
        return undefined;
    }

    if (startAt instanceof Date && !Number.isNaN(startAt.getTime())) {
        return startAt;
    }

    if (typeof startAt === 'string' || typeof startAt === 'number') {
        const parsed = new Date(startAt);
        return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }

    return undefined;
}
