/**
 * Cron entry point — called by Railway Cron on an hourly schedule.
 * Usage: node src/cron.js
 */
const { runAll } = require('./engine/dispatcher');

async function main() {
  try {
    const results = await runAll();
    if (results.failed > 0) {
      process.exit(1); // Non-zero exit signals partial failure to Railway
    }
    process.exit(0);
  } catch (err) {
    console.error('Fatal cron error:', err);
    process.exit(1);
  }
}

main();
