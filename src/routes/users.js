const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { supabase } = require('../db');

// GET /api/users — List all users with assigned clients
router.get('/', async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, email, name, role, is_active, created_at, updated_at')
      .order('name');

    if (error) throw error;

    // Fetch client assignments for all users
    const userIds = users.map(u => u.id);
    const { data: assignments, error: assignErr } = await supabase
      .from('user_clients')
      .select('user_id, client_id, clients(id, name)')
      .in('user_id', userIds);

    if (assignErr) throw assignErr;

    // Group assignments by user
    const assignmentMap = {};
    for (const a of (assignments || [])) {
      if (!assignmentMap[a.user_id]) assignmentMap[a.user_id] = [];
      assignmentMap[a.user_id].push({
        client_id: a.client_id,
        client_name: a.clients?.name || 'Unknown',
      });
    }

    const result = users.map(u => ({
      ...u,
      assigned_clients: assignmentMap[u.id] || [],
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users — Create a new user
router.post('/', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: 'email, password, name, and role are required' });
    }

    const validRoles = ['client', 'agency', 'account_manager', 'admin'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { data, error } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase(),
        password_hash: passwordHash,
        name,
        role,
      })
      .select('id, email, name, role, is_active, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'A user with that email already exists' });
      }
      throw error;
    }

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/:id — Update user (name, role, is_active)
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['name', 'role', 'is_active'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (updates.role) {
      const validRoles = ['client', 'agency', 'account_manager', 'admin'];
      if (!validRoles.includes(updates.role)) {
        return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, email, name, role, is_active, updated_at')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id/clients — Replace all client assignments for a user
router.put('/:id/clients', async (req, res) => {
  try {
    const { client_ids } = req.body;

    if (!Array.isArray(client_ids)) {
      return res.status(400).json({ error: 'client_ids must be an array' });
    }

    // Delete existing assignments
    const { error: deleteErr } = await supabase
      .from('user_clients')
      .delete()
      .eq('user_id', req.params.id);

    if (deleteErr) throw deleteErr;

    // Insert new assignments
    if (client_ids.length > 0) {
      const rows = client_ids.map(clientId => ({
        user_id: req.params.id,
        client_id: clientId,
      }));

      const { error: insertErr } = await supabase
        .from('user_clients')
        .insert(rows);

      if (insertErr) throw insertErr;
    }

    // Return updated assignments
    const { data, error } = await supabase
      .from('user_clients')
      .select('client_id, clients(id, name)')
      .eq('user_id', req.params.id);

    if (error) throw error;

    res.json({
      user_id: req.params.id,
      assigned_clients: (data || []).map(a => ({
        client_id: a.client_id,
        client_name: a.clients?.name || 'Unknown',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
