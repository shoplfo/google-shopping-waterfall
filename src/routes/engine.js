const express = require('express');
const router = express.Router();
const { runAll, runOne } = require('../engine/dispatcher');

// POST /api/engine/run — Trigger run for all active clients (cron or manual)
router.post('/run', async (req, res) => {
  try {
    // Run asynchronously — respond immediately, process in background
    const isAsync = req.query.async === 'true';

    if (isAsync) {
      res.json({ message: 'Engine run triggered', status: 'processing' });
      runAll({ skipCronCheck: true }).catch(err => console.error('Async run error:', err));
    } else {
      const results = await runAll({ skipCronCheck: true });
      res.json(results);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/engine/run/:clientId — Trigger run for a specific client
router.post('/run/:clientId', async (req, res) => {
  try {
    const result = await runOne(req.params.clientId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
