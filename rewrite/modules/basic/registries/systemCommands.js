import { SlashCommandBuilder } from 'discord.js';

/**
 * 系统管理命令组
 * 使用命令组模式：父命令定义 builder 和共享配置，子命令定义各自的逻辑
 */
export default {
    id: 'basic.system',
    type: 'commandGroup',
    commandKind: 'slash',
    name: '系统',
    description: 'Bot 系统管理指令',

    // 所有子命令共享的配置
    shared: {
        defer: { ephemeral: true },
        usage: ['inGuild'],
        permissions: ['administrator'],
        inject: ['basic.systemCommandService']
    },

    builder() {
        return new SlashCommandBuilder()
            .setName(this.name)
            .setDescription(this.description)
            .addSubcommand(subcommand =>
                subcommand
                    .setName('同步指令')
                    .setDescription('检查并同步当前服务器的Discord指令')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('重载模块')
                    .setDescription('热重载指定模块（不支持 basic 模块）')
                    .addStringOption(option =>
                        option.setName('模块')
                            .setDescription('要重载的模块名称')
                            .setRequired(true)
                            .setAutocomplete(true)
                        )
                    .addStringOption(option =>
                        option.setName('范围')
                            .setDescription('重载范围')
                            .setRequired(true)
                            .addChoices(
                                { name: '完全重载（服务+配置）', value: 'all' },
                                { name: '仅重载 Builders', value: 'builders' }
                                )
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('重载配置')
                    .setDescription('重新加载当前服务器的配置文件')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('重启')
                    .setDescription('重启 Bot（需要进程管理器支持）')
            );
    },

    subcommands: [
        // 同步指令
        {
            id: 'sync',
            name: '同步指令',
            cooldown: 10000,  // 10秒冷却

            async execute(ctx, { systemCommandService }) {
                await systemCommandService.executeSyncCommands(ctx);
            }
        },

        // 重载模块
        {
            id: 'reloadModule',
            name: '重载模块',
            cooldown: 5000,  // 5秒冷却

        async autocomplete(ctx, { systemCommandService }) {
                const focusedOption = ctx.interaction.options.getFocused(true);

                if (focusedOption.name === '模块') {
                    const modulesPath = new URL('../../', import.meta.url).pathname;
                    const modules = await systemCommandService.getReloadableModules(modulesPath);

                    const filtered = modules
                        .filter(name => name.toLowerCase().includes(focusedOption.value.toLowerCase()))
                        .slice(0, 25);

                    await ctx.interaction.respond(
                        filtered.map(name => ({ name, value: name }))
                    );
                }
            },

            async execute(ctx, { systemCommandService }) {
                const modulesPath = new URL('../../', import.meta.url).pathname;
                await systemCommandService.handleReloadModule(ctx, modulesPath);
            }
        },

        // 重载配置
        {
            id: 'reloadConfig',
            name: '重载配置',
            cooldown: 5000,  // 5秒冷却

        async execute(ctx, { systemCommandService }) {
                    await systemCommandService.handleReloadConfig(ctx);
            }
        },

        // 重启
        {
            id: 'restart',
            name: '重启',
            cooldown: 10000,  // 10秒冷却（防止误操作）

            async execute(ctx, { systemCommandService }) {
                    await systemCommandService.handleRestart(ctx);
            }
        }
    ]
};

