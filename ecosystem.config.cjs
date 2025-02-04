module.exports = {
  apps: [{
    name: 'discord-bot',
    script: 'dist/index.js',
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    time: true,
    // 每3小时重启一次
    cron_restart: '0 */3 * * *',
    // 优雅关闭
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 10000,
    node_args: '--experimental-modules'
  }]
}
