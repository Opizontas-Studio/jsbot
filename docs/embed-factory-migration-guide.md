# Embed Factory 迁移指南

## 概述

为了遵循模块化开发规范，将embed构建逻辑从业务服务层分离到专门的工厂类中。

## 已完成的重构

### ✅ opinionMailboxService.js
- 已将所有embed构建迁移到 `EmbedFactory`
- 重构的embed类型：
  - 意见信箱入口消息
  - 投稿审核消息
  - 私聊反馈消息
  - 更新投稿状态消息

## 待重构的文件

根据代码扫描，以下文件仍包含大量embed构建代码：

### 高优先级（服务层文件）
- `src/services/fastgptService.js`
- `src/services/monitorService.js`

### 中优先级（命令文件）
这些命令文件中的embed可以根据功能类型分组重构：

#### 管理员命令
- `src/commands/adm_*.js` - 管理员相关embed
- `src/commands/mod_*.js` - 版主相关embed

#### 用户命令
- `src/commands/user_*.js` - 用户相关embed

#### 系统命令
- `src/commands/long_*.js` - 长时间操作相关embed

## 重构步骤

### 1. 分析embed使用模式
```bash
# 查找embed构建代码
grep -n "EmbedBuilder\|\.setTitle\|\.setDescription\|\.setColor" target_file.js
```

### 2. 设计工厂方法
在 `EmbedFactory` 中添加新的静态方法：
```javascript
/**
 * 创建XXX相关的embed
 * @param {Object} params - 参数对象
 * @returns {EmbedBuilder|Object} embed对象
 */
static createXXXEmbed(params) {
    // embed构建逻辑
}
```

### 3. 重构原始文件
```javascript
// 重构前
const embed = new EmbedBuilder()
    .setTitle('标题')
    .setDescription('描述')
    .setColor(0x00aaff);

// 重构后
const embed = EmbedFactory.createXXXEmbed(params);
```

### 4. 更新import语句
```javascript
// 添加
import { EmbedFactory } from '../factories/embedFactory.js';

// 可能需要移除（如果不再直接使用）
// import { EmbedBuilder } from 'discord.js';
```

## 分类建议

### 按功能模块分类
- **意见系统**: `createOpinionXXXEmbed()`
- **投票系统**: `createVoteXXXEmbed()`
- **议事系统**: `createDebateXXXEmbed()`
- **监控系统**: `createMonitorXXXEmbed()`
- **管理系统**: `createAdminXXXEmbed()`
- **用户系统**: `createUserXXXEmbed()`

### 按消息类型分类
- **成功消息**: `createSuccessEmbed()`
- **错误消息**: `createErrorEmbed()`
- **信息消息**: `createInfoEmbed()`
- **警告消息**: `createWarningEmbed()`

## 最佳实践

### 1. 参数设计
使用对象参数而不是过多的位置参数：
```javascript
// 好的设计
static createUserProfileEmbed({ user, stats, guild }) {
    // ...
}

// 避免的设计
static createUserProfileEmbed(user, joinDate, messageCount, roleCount, guildName) {
    // ...
}
```

### 2. 复用常量
使用 `EmbedFactory.Colors` 和 `EmbedFactory.Emojis`：
```javascript
.setColor(EmbedFactory.Colors.SUCCESS)
.setTitle(`${EmbedFactory.Emojis.SUCCESS} 操作成功`)
```

### 3. 职责分离
- **Factory**: 只负责构建embed，不包含业务逻辑
- **Service**: 负责业务逻辑，调用factory创建embed

### 4. 返回类型
- 简单embed使用 `EmbedBuilder`
- 复杂embed或需要兼容性考虑时使用原始对象

## 验证清单

重构完成后检查：
- [ ] 原文件不再包含embed构建代码
- [ ] import语句已更新
- [ ] 功能测试通过
- [ ] 代码无linter错误
- [ ] 参数传递正确
- [ ] 样式和格式保持一致

## 扩展建议

完成基础重构后，可以考虑：
1. 添加embed模板系统
2. 支持主题切换
3. 添加国际化支持
4. 创建embed预览工具
