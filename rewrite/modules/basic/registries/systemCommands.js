import { SlashCommandBuilder } from 'discord.js';

/**
 * 系统管理命令配置
 * Bot 系统管理相关指令
 */
export default [
    {
        id: 'basic.system',
        type: 'command',
        commandKind: 'slash',
        name: '系统',
        description: 'Bot 系统管理指令',
        defer: { ephemeral: true },
        permissions: ['administrator'],
        inject: ['basic.systemCommandService'],

        /**
         * 构建命令
         */
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

        /**
         * 自动补全处理
         */
        async autocomplete(ctx, { systemCommandService }) {
            const subcommand = ctx.interaction.options.getSubcommand();

            if (subcommand === '重载模块') {
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
            }
        },

        /**
         * 路由分发执行命令
         */
        async execute(ctx, { systemCommandService }) {
            const subcommand = ctx.interaction.options.getSubcommand();
            const modulesPath = new URL('../../', import.meta.url).pathname;

            switch (subcommand) {
                case '同步指令':
                    await systemCommandService.executeSyncCommands(ctx);
                    break;
                case '重载模块':
                    await systemCommandService.handleReloadModule(ctx, modulesPath);
                    break;
                case '重载配置':
                    await systemCommandService.handleReloadConfig(ctx);
                    break;
                case '重启':
                    await systemCommandService.handleRestart(ctx);
                    break;
            }
        }
    }
];

