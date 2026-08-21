const express = require('express');
const router = express.Router();
const { supabase } = require('../db');

// GET /api/logs — Get run logs (scoped by role)
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    let query = supabase
      .from('run_logs')
      .select('*, clients!inner(name)', { count: 'exact' })
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Scope: client/agency only see logs for their clients
    if (req.clientScope && req.clientScope.scoped) {
      const ids = req.clientScope.clientIds || [];
      if (ids.length === 0) return res.json({ data: [], total: 0 });
      query = query.in('client_id', ids);
    }

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/client/:clientId — Get run logs for a specific client (scope-checked)
router.get('/client/:clientId', async (req, res) => {
  try {
    // Scope check
    if (req.clientScope && req.clientScope.scoped) {
      const ids = req.clientScope.clientIds || [];
      if (!ids.includes(req.params.clientId)) {
        return res.status(403).json({ error: 'Forbidden: client not in your scope' });
      }
    }

    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const { data, error, count } = await supabase
      .from('run_logs')
      .select('*', { count: 'exact' })
      .eq('client_id', req.params.clientId)
      .order('started_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/:logId — Get detailed run log
router.get('/:logId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('run_logs')
      .select('*, clients!inner(name)')
      .eq('id', req.params.logId)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Run log not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/:logId/queries — Get query history for a specific run
router.get('/:logId/queries', async (req, res) => {
  try {
    const { was_blocked } = req.query;
    let query = supabase
      .from('negative_keyword_history')
      .select('*')
      .eq('run_log_id', req.params.logId)
      .order('impressions', { ascending: false });

    if (was_blocked !== undefined) {
      query = query.eq('was_blocked', was_blocked === 'true');
    }

    const { data, error } = await query.limit(500);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PERFORMANCE / MONITORING ENDPOINTS
// ============================================================

// GET /api/logs/stats/health — System health overview
router.get('/stats/health', async (req, res) => {
  try {
    const { data, error } = await supabase.from('system_health').select('*').single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/stats/performance — Client performance summary
router.get('/stats/performance', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('client_performance_summary')
      .select('*')
      .order('client_name');

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/stats/daily — Daily stats for charting
router.get('/stats/daily', async (req, res) => {
  try {
    const { client_id, days } = req.query;
    const numDays = parseInt(days) || 30;

    let query = supabase
      .from('daily_stats')
      .select('*')
      .order('run_date', { ascending: false })
      .limit(numDays);

    if (client_id) {
      query = query.eq('client_id', client_id);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/stats/client/:clientId/recent-queries — Recent blocked/allowed queries
router.get('/stats/client/:clientId/recent-queries', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const { was_blocked } = req.query;

    let query = supabase
      .from('negative_keyword_history')
      .select('*')
      .eq('client_id', req.params.clientId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (was_blocked !== undefined) {
      query = query.eq('was_blocked', was_blocked === 'true');
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
