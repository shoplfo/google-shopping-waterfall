const express = require('express');
const router = express.Router();
const { supabase } = require('../db');
const { normalize } = require('../engine/matcher');
const { requireRole, requirePermission } = require('../middleware/auth');

// ============================================================
// VENDORS (global vendor registry)
// ============================================================

// GET /api/vendors — List vendors (scoped by role through client assignments)
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;

    // For scoped users, only show vendors assigned to their clients
    if (req.clientScope && req.clientScope.scoped) {
      const clientIds = req.clientScope.clientIds || [];
      if (clientIds.length === 0) return res.json([]);

      // Get vendor IDs assigned to user's clients
      const { data: cvRows, error: cvErr } = await supabase
        .from('client_vendors')
        .select('vendor_id')
        .in('client_id', clientIds);
      if (cvErr) throw cvErr;

      const vendorIds = [...new Set(cvRows.map(r => r.vendor_id))];
      if (vendorIds.length === 0) return res.json([]);

      let query = supabase.from('vendors').select('*').in('id', vendorIds).order('name');
      if (search) query = query.ilike('name', `%${search}%`);
      const { data, error } = await query;
      if (error) throw error;
      return res.json(data);
    }

    let query = supabase.from('vendors').select('*').order('name');
    if (search) query = query.ilike('name', `%${search}%`);

    const { data, error } = await query;
    if (error) throw error;

    // Get keyword counts per vendor
    const vendorIds = data.map(v => v.id);
    if (vendorIds.length > 0) {
      const { data: keywords, error: kwError } = await supabase
        .from('vendor_keywords')
        .select('vendor_id, campaign_type')
        .in('vendor_id', vendorIds);

      if (kwError) throw kwError;

      const counts = {};
      for (const kw of (keywords || [])) {
        if (!counts[kw.vendor_id]) counts[kw.vendor_id] = { brand: 0, product: 0 };
        counts[kw.vendor_id][kw.campaign_type]++;
      }

      for (const vendor of data) {
        vendor.brand_keyword_count = counts[vendor.id]?.brand || 0;
        vendor.product_keyword_count = counts[vendor.id]?.product || 0;
      }
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vendors/:id — Get single vendor
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Vendor not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vendors — Create a vendor (account_manager+)
router.post('/', requireRole('account_manager', 'admin'), async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Vendor name is required' });
    }

    const { data, error } = await supabase
      .from('vendors')
      .upsert({ name: name.trim() }, { onConflict: 'name' })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/vendors/:id — Update vendor (account_manager+)
router.patch('/:id', requireRole('account_manager', 'admin'), async (req, res) => {
  try {
    const allowed = ['name', 'is_active'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('vendors')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, is_active, created_at')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Vendor not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/vendors/:id/archive — Archive (deactivate) a vendor (account_manager+)
router.patch('/:id/archive', requireRole('account_manager', 'admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendors')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .select('id, name, is_active')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ message: 'Vendor archived', vendor: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/vendors/:id — Delete vendor (account_manager+)
router.delete('/:id', requireRole('account_manager', 'admin'), async (req, res) => {
  try {
    const { count, error: countError } = await supabase
      .from('vendor_keywords')
      .select('id', { count: 'exact', head: true })
      .eq('vendor_id', req.params.id);

    if (countError) throw countError;
    if (count > 0) {
      return res.status(400).json({ error: `Cannot delete vendor — it has ${count} keywords. Remove keywords first.` });
    }

    const { error } = await supabase
      .from('vendors')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ message: 'Vendor deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// VENDOR KEYWORDS (belong to a vendor)
// ============================================================

// POST /api/vendors/keywords/import — Bulk import keywords (account_manager+)
router.post('/keywords/import', requirePermission('manage_vendor_keywords'), async (req, res) => {
  try {
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Provide rows: [{ vendor, campaign_type, keyword }]' });
    }

    const errors = [];
    let imported = 0;
    let vendorsCreated = 0;

    // Validate rows
    const validRows = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.vendor || !r.vendor.trim()) { errors.push(`Row ${i + 1}: missing vendor`); continue; }
      if (!r.campaign_type || !['brand', 'product'].includes(r.campaign_type.trim().toLowerCase())) { errors.push(`Row ${i + 1}: campaign_type must be "brand" or "product"`); continue; }
      if (!r.keyword || !r.keyword.trim()) { errors.push(`Row ${i + 1}: missing keyword`); continue; }
      validRows.push({
        vendor: r.vendor.trim(),
        campaign_type: r.campaign_type.trim().toLowerCase(),
        keyword: normalize(r.keyword.trim()),
      });
    }

    // Group by vendor name
    const byVendor = {};
    for (const r of validRows) {
      if (!byVendor[r.vendor]) byVendor[r.vendor] = [];
      byVendor[r.vendor].push(r);
    }

    // Resolve vendor names to IDs (create if missing)
    const vendorNames = Object.keys(byVendor);
    const { data: existingVendors } = await supabase.from('vendors').select('id, name');
    const vendorMap = {};
    for (const v of (existingVendors || [])) {
      vendorMap[v.name.toLowerCase()] = v.id;
    }

    for (const name of vendorNames) {
      const key = name.toLowerCase();
      if (!vendorMap[key]) {
        const { data, error } = await supabase
          .from('vendors')
          .upsert({ name }, { onConflict: 'name' })
          .select('id')
          .single();
        if (error) { errors.push(`Failed to create vendor "${name}": ${error.message}`); continue; }
        vendorMap[key] = data.id;
        vendorsCreated++;
      }
    }

    // Insert keywords per vendor in batches
    for (const [vendorName, vendorRows] of Object.entries(byVendor)) {
      const vendorId = vendorMap[vendorName.toLowerCase()];
      if (!vendorId) continue;

      const batch = vendorRows.map(r => ({
        vendor_id: vendorId,
        keyword: r.keyword,
        campaign_type: r.campaign_type,
      }));

      // Supabase handles up to ~1000 rows per upsert
      for (let i = 0; i < batch.length; i += 500) {
        const chunk = batch.slice(i, i + 500);
        const { data, error } = await supabase
          .from('vendor_keywords')
          .upsert(chunk, { onConflict: 'vendor_id,keyword' })
          .select('id');
        if (error) { errors.push(`Vendor "${vendorName}" batch error: ${error.message}`); }
        else { imported += data.length; }
      }
    }

    res.json({ imported, vendors_created: vendorsCreated, total_rows: rows.length, errors: errors.slice(0, 20) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vendors/:vendorId/keywords — List keywords for a vendor
router.get('/:vendorId/keywords', async (req, res) => {
  try {
    const { campaign_type, search, limit = 100, offset = 0 } = req.query;

    let query = supabase
      .from('vendor_keywords')
      .select('*', { count: 'exact' })
      .eq('vendor_id', req.params.vendorId);

    if (campaign_type) query = query.eq('campaign_type', campaign_type);
    if (search) query = query.ilike('keyword', `%${search}%`);

    query = query.order('keyword').range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vendors/:vendorId/keywords — Add keywords (account_manager+)
router.post('/:vendorId/keywords', requirePermission('manage_vendor_keywords'), async (req, res) => {
  try {
    const { keywords } = req.body; // Array of { keyword, campaign_type }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'Provide an array of keywords: [{ keyword, campaign_type }]' });
    }

    for (const k of keywords) {
      if (!k.campaign_type || !['brand', 'product'].includes(k.campaign_type)) {
        return res.status(400).json({ error: 'campaign_type must be "brand" or "product"' });
      }
    }

    const normalized = keywords.map(k => ({
      vendor_id: req.params.vendorId,
      keyword: normalize(k.keyword || k),
      campaign_type: k.campaign_type,
    }));

    const { data, error } = await supabase
      .from('vendor_keywords')
      .upsert(normalized, { onConflict: 'vendor_id,keyword' })
      .select();

    if (error) throw error;
    res.status(201).json({ added: data.length, keywords: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/vendors/keywords/:id/archive — Archive a vendor keyword (account_manager+)
router.patch('/keywords/:id/archive', requirePermission('manage_vendor_keywords'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendor_keywords')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .select('id, keyword, is_active')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Keyword not found' });
    res.json({ message: 'Keyword archived', keyword: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/vendors/keywords/:id/restore — Restore a vendor keyword (account_manager+)
router.patch('/keywords/:id/restore', requirePermission('manage_vendor_keywords'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendor_keywords')
      .update({ is_active: true })
      .eq('id', req.params.id)
      .select('id, keyword, is_active')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Keyword not found' });
    res.json({ message: 'Keyword restored', keyword: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/vendors/keywords/:id — Delete a vendor keyword (account_manager+)
router.delete('/keywords/:id', requirePermission('manage_vendor_keywords'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('vendor_keywords')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ message: 'Vendor keyword deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
