// pm2 process file — starts the API + the webhook listener.
// Run: pm2 startOrReload deploy/ecosystem.config.js --update-env
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'app_soldes-api',
      cwd: path.resolve(__dirname, '..', 'server'),
      script: 'index.js',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '512M',
      out_file: '/home/deploy/.pm2/logs/api-out.log',
      error_file: '/home/deploy/.pm2/logs/api-err.log',
      time: true,
    },
    {
      name: 'app_soldes-webhook',
      cwd: __dirname,
      script: 'webhook.js',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '128M',
      out_file: '/home/deploy/.pm2/logs/webhook-out.log',
      error_file: '/home/deploy/.pm2/logs/webhook-err.log',
      time: true,
    },
  ],
};
