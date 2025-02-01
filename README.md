# Discord.js Bot Project

## 使用

将 `config.json` 放在根目录下, 将 `messageIds.json` 放在 `data` 文件夹下

安装 pnpm:

```bash
npm -g pnpm
```

用 pnpm 安装依赖包并运行:

```bash
pnpm install
pnpm start
```

由于代码问题, 本 bot 可能在运行一段时间后卡死, 为此你可以运行能自动重启的 `start.ps1` 脚本, 而非直接运行 `pnpm start`.

## 参与贡献

本项目采用 JavaScript 混合了少量 TypeScript 编写, 项目整体为自建架构, 因而有如下文件结构:

```txt
..
├── index.js  # 总入口, 读取配置文件, 完成命令、事件的加载, 启动 bot 客户端
│
├── events  # 监听 discord 事件, 执行对应操作
│   ├── guildMemberAdd.js     # 有新成员加入服务器时, 检测他是否是以前加入封禁列表但还没实际封禁的成员, 执行封禁操作
│   ├── interactionCreate.js  # 有人通过按钮、模态框等与 bot 发生交互, 将会分发给 handlers 进行处理
│   └── ready.js              # bot 客户端准备就绪
│
├── commands  # 各身份组可使用的 discord 命令
│               - 如果命令较为简单则直接编写, 否则在 services 中处理逻辑, 在此处调用对应函数
│               - 使用 try-catch 进行错误处理, 所有异步操作都应用 try-catch 包装
│               - 考虑用 globalBatchProcessor 处理批量操作, 用 globalRequestQueue 控制 API 请求频率
│   ├── adm_*.js   # 管理员 (优先级 5)
│   ├── mod_*.js   # 版主 (优先级 4)
│   ├── user_*.js  # 普通用户 (优先级 3)
│   └── long_*.js  # 长期执行的后台命令 (优先级 2)
│
├── handlers  # 处理交互
│   ├── buttons.js    # 处理按钮交互
│   ├── modals.js     # 处理模态框交互
│   └── scheduler.js  # 处理定时任务
│
├── services  # 对于较为复杂的命令, 在此编写处理逻辑
│   ├── courtService.js
│   ├── punishmentService.js
│   ├── roleApplication.js
│   ├── threadAnalyzer.js
│   ├── threadCleaner.js
│   └── voteService.js
│
├── db  # 存取数据库, 数据文件将存储于 data/database.sqlite 中
│   ├── dbManager.ts  # 对数据库建表、查询等操作的封装, 目前的建表是直接以 SQL 形式硬编码在代码中
│   └── models        # 对各表存取的封装
│       ├── processModel.js     # 对一些命令的处理流程进行记录
│       ├── punishmentModel.js  # 对成员的处罚记录
│       └── voteModel.js        # 红蓝投票
│
└── utils
    ├── assertion.ts
    ├── concurrency.js
    ├── guildManager.js  # 对服务器配置进行管理
    ├── helper.js
    ├── logger.js
    └── punishmentHelper.js
```
