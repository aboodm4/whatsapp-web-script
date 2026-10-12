module.exports = {
  apps: [
    {
      name: 'massar-whatsapp',
      script: './index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: 'production',
        PORT: 4002,
      },
    },
  ],
};
