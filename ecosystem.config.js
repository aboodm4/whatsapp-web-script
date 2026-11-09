module.exports = {
  apps: [
    {
      name: 'massar-whatsapp',
      script: './index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      kill_timeout: 20000,
      stop_exit_codes: [0],
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: 'production',
        PORT: 4002,
      },
    },
  ],
};
