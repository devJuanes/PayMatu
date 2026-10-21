module.exports = {
  apps: [
    {
      name: 'paymatu',
      script: 'lib/index.js',
      cwd: process.cwd(),
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 8787,
        HOST: '127.0.0.1'
      }
    }
  ]
}
