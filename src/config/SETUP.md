## 环境变量 ：项目根目录的 `.env` 文件：

| 变量名 | 必需 | 说明 | 示例 |
|--------|------|------|------|
| `DISCORD_TOKEN` | ✅ | Discord Bot Token | `MTIz...` |
| `DISCORD_CLIENT_ID` | ✅ | Discord Bot Client ID | `123456789...` |
| `TEST_BOT_TOKEN` | ❌ | 测试环境Token | `OTg3...` |
| `TEST_BOT_CLIENT_ID` | ❌ | 测试Bot Client ID | `123456789...` |
| `DATABASE_URL` | ❌ | 数据库连接（覆盖config.json） | `postgresql://...` |
| `NODE_ENV` | ❌ | 运行环境 | `development` |

## 全局配置 (config.json)

```json
{
    "bot": {
        "logLevel": "info",              // trace|debug|info|warn|error
        "gracefulShutdownTimeout": 30000  // 优雅关闭超时（毫秒）
    },
    "database": {
        "sqlite": {
            "path": "./data/database.sqlite"
        },
        "postgres": {
            "host": "localhost",
            "port": 5432,
            "database": "gatekeeper",
            "user": "postgres",
            "password": "password"
        }
    },
    "api": {
        "rateLimit": {
            "global": {
                "maxRequests": 50,       // 全局每秒最大请求数
                "window": 1000           // 时间窗口（毫秒）
            }
        }
    },
    "queue": {
        "concurrency": 3,                // 并发任务数
        "timeout": 900000                // 任务超时（毫秒）
    }
}
```

> 提示：框架会同时连接 `sqlite` 与 `postgres`。SQLite 是必需的，如果连接失败将直接退出进程；PostgreSQL 连接失败则会被标记为不可用，相关模块可以根据 `DatabaseManager.isTargetAvailable('postgres')` 等方法自行禁用功能。

## 服务器配置 (guilds/{guildId}.json)

在 `src/config/guilds/` 目录创建，文件名为服务器ID：

```json
{
    "guildId": "123456789012345678",
    "roleIds": {
        "moderators": ["role_id_1", "role_id_2"],
        "administrators": ["admin_role_id"]
    },
    "channelIds": {
        "log": "log_channel_id",
        "mod": "mod_channel_id"
    }
}
```
