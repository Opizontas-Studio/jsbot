# Core模块测试文档

## 概述

本目录包含rewrite架构core模块的完整测试套件，包括单元测试和集成测试。

## 测试结构

```
tests/
├── unit/                          # 单元测试
│   ├── Container.test.js         # 依赖注入容器
│   ├── Context.test.js           # 上下文对象
│   ├── Registry.test.js          # 注册中心
│   ├── Logger.test.js            # 日志器
│   ├── MiddlewareChain.test.js   # 中间件链
│   ├── middleware/               # 中间件测试
│   │   ├── cooldown.test.js
│   │   ├── defer.test.js
│   │   ├── errorHandler.test.js
│   │   └── permissions.test.js
│   └── events/                   # 事件监听器测试
│       ├── InteractionListener.test.js
│       ├── MemberListener.test.js
│       └── MessageListener.test.js
└── integration/                   # 集成测试
    ├── Application.test.js       # 应用主入口
    └── bootstrap.test.js         # 启动流程
```

## 运行测试

### 运行所有测试

```bash
pnpm test
```

### 运行单元测试

```bash
pnpm test -- tests/unit
```

### 运行集成测试

```bash
pnpm test -- tests/integration
```

### 运行特定测试文件

```bash
pnpm test -- tests/unit/Container.test.js
```

### 带覆盖率的测试

```bash
pnpm test -- --coverage
```

### 监听模式

```bash
pnpm test -- --watch
```

## 测试覆盖范围

### 单元测试

#### Container (依赖注入容器)
- ✅ 注册工厂函数和实例
- ✅ 懒加载和缓存
- ✅ 循环依赖检测
- ✅ 批量解析依赖
- ✅ 服务验证

#### Context (上下文对象)
- ✅ 基础Context和CommandContext
- ✅ 自动判断reply/editReply/update
- ✅ error/success方法（ComponentV2）
- ✅ defer处理
- ✅ 上下文菜单支持

#### Registry (注册中心)
- ✅ 模块扫描和加载
- ✅ 配置验证
- ✅ Pattern编译和参数提取
- ✅ 命令/组件/事件/任务注册
- ✅ 路由查找和匹配
- ✅ 诊断信息收集

#### Logger (日志器)
- ✅ 各级别日志输出
- ✅ 结构化日志
- ✅ 子logger创建
- ✅ 文件日志（生产环境）
- ✅ flush方法

#### MiddlewareChain (中间件链)
- ✅ 中间件添加和执行
- ✅ 按顺序执行
- ✅ next调用控制
- ✅ 错误传播
- ✅ 上下文传递

#### Middleware (中间件)
- ✅ **cooldown**: 冷却时间检查
- ✅ **defer**: 自动defer交互
- ✅ **errorHandler**: 错误捕获和格式化
- ✅ **permissions**: 权限验证

#### Event Listeners (事件监听器)
- ✅ **InteractionListener**: 交互事件分发
- ✅ **MemberListener**: 成员事件处理
- ✅ **MessageListener**: 消息事件处理
- ✅ 事件注册和分发
- ✅ Filter检查
- ✅ 依赖注入
- ✅ 错误隔离

### 集成测试

#### Application (应用集成)
- ✅ 完整初始化流程
- ✅ 核心服务注册
- ✅ 模块加载（单个/多个/嵌套）
- ✅ 事件监听器注册
- ✅ 启动和停止流程
- ✅ 资源清理
- ✅ 依赖验证
- ✅ 配置加载

#### Bootstrap (启动流程)
- ✅ 配置文件加载
- ✅ 环境变量覆盖
- ✅ 优雅关闭处理
- ✅ 信号处理（SIGINT/SIGTERM）
- ✅ 未捕获异常处理
- ✅ 错误处理

## 测试策略

### 单元测试
- 使用Jest的mock功能隔离依赖
- 测试每个类和函数的公共API
- 覆盖正常流程和边界情况
- 验证错误处理

### 集成测试
- 测试组件间的交互
- 使用临时文件系统
- 模拟Discord.js客户端
- 验证完整工作流

## Mock和测试工具

### Discord.js Mock
集成测试中使用了Discord.js的mock版本，模拟：
- Client实例
- GatewayIntentBits
- Events
- Interaction对象

### 临时文件系统
使用`os.tmpdir()`创建临时测试目录，测试后自动清理。

### Jest工具
- `jest.fn()`: mock函数
- `jest.spyOn()`: spy方法
- `beforeEach/afterEach`: 测试前后钩子
- `expect()`: 断言

## 注意事项

### 测试隔离
- 每个测试都应该独立，不依赖其他测试
- 使用`beforeEach`重置状态
- 使用`afterEach`清理资源

### 异步测试
- 所有异步操作使用`async/await`
- 正确处理Promise拒绝

### 临时文件清理
- 测试使用临时目录
- `afterEach`中清理所有临时文件
- 使用`force: true`忽略清理错误

### Mock管理
- 在`beforeEach`中创建新的mock
- 避免mock泄漏到其他测试

## 添加新测试

### 单元测试模板

```javascript
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { YourClass } from '../../core/YourClass.js';

describe('YourClass', () => {
    let instance;

    beforeEach(() => {
        // 设置测试环境
        instance = new YourClass();
    });

    describe('method', () => {
        it('应该正常工作', () => {
            const result = instance.method();
            expect(result).toBeDefined();
        });

        it('应该处理错误', () => {
            expect(() => {
                instance.method(invalidInput);
            }).toThrow();
        });
    });
});
```

### 集成测试模板

```javascript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('Feature Integration', () => {
    let testDir;

    beforeEach(() => {
        // 创建测试环境
        testDir = createTempDir();
    });

    afterEach(() => {
        // 清理测试环境
        cleanupTempDir(testDir);
    });

    it('应该完成完整流程', async () => {
        // 执行集成测试
    });
});
```

## 持续集成

测试应该在以下情况自动运行：
- 代码提交前（pre-commit hook）
- PR创建时
- 合并到主分支前

## 测试覆盖率目标

- 语句覆盖率: >= 80%
- 分支覆盖率: >= 75%
- 函数覆盖率: >= 85%
- 行覆盖率: >= 80%

## 常见问题

### Q: 测试运行很慢
A: 使用`--maxWorkers=4`限制并发数，或使用`--testPathPattern`只运行特定测试。

### Q: 临时文件未清理
A: 确保`afterEach`中使用`try-catch`包裹清理代码。

### Q: Mock没有生效
A: 检查import顺序，确保mock在导入被测模块前定义。

### Q: 测试在CI环境失败
A: 检查环境变量、文件权限和路径问题。

## 维护指南

- 保持测试简洁易读
- 及时更新测试以匹配代码变更
- 添加新功能时同步添加测试
- 定期审查和重构测试代码
- 保持高覆盖率

## 参考资源

- [Jest文档](https://jestjs.io/docs/getting-started)
- [Discord.js文档](https://discord.js.org/)
- [项目架构文档](../plan.md)

