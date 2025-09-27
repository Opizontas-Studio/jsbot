// 测试EmbedFactory.Colors是否正确定义
import { EmbedFactory } from './src/factories/embedFactory.js';

console.log('测试EmbedFactory.Colors定义:');
console.log('SUCCESS:', EmbedFactory.Colors.SUCCESS);
console.log('ERROR:', EmbedFactory.Colors.ERROR);
console.log('INFO:', EmbedFactory.Colors.INFO);
console.log('WARNING:', EmbedFactory.Colors.WARNING);
console.log('PRIMARY:', EmbedFactory.Colors.PRIMARY);

// 测试撤销处罚embed创建
const mockPunishment = {
    id: 820,
    type: 'softban',
    reason: '系统测试',
    userId: '123456789'
};

const mockTarget = {
    id: '123456789',
    username: 'testuser',
    tag: 'testuser#1234'
};

try {
    const dmEmbed = EmbedFactory.createPunishmentRevokeDMEmbed(mockPunishment, '测试撤销');
    console.log('✅ 撤销处罚私信embed创建成功');
    console.log('颜色:', dmEmbed.color);
    console.log('标题:', dmEmbed.title);
    
    const logEmbed = EmbedFactory.createPunishmentRevokeLogEmbed(mockPunishment, mockTarget, '测试撤销', ['服务器1'], []);
    console.log('✅ 撤销处罚日志embed创建成功');
    console.log('颜色:', logEmbed.color);
    console.log('标题:', logEmbed.title);
    
} catch (error) {
    console.error('❌ Embed创建失败:', error.message);
}
