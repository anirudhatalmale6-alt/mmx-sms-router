// Admin JSON API — CRUD for customers, MO/DR routes and retry policies, plus
// read access to the inbound + delivery logs. Every route requires the
// X-Admin-Token header (or ?token=) to match env.ADMIN_TOKEN.
//
// The specificity column on MO routes is derived server-side so the router can
// order by it without recomputing.

function auth(c, next) {
  const token = c.req.header('x-admin-token') || new URL(c.req.url).searchParams.get('token');
  if (!token || token !== c.env.ADMIN_TOKEN) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  return next();
}

function specificity(senderId, keyword) {
  if (senderId && keyword) return 3;
  if (keyword) return 2;
  if (senderId) return 1;
  return 0;
}

export function mountAdmin(app) {
  app.use('/admin/*', auth);

  // ---- Customers -------------------------------------------------------
  app.get('/admin/customers', async (c) => {
    const { results } = await c.env.DB.prepare('SELECT * FROM customers ORDER BY id DESC').all();
    return c.json({ ok: true, customers: results || [] });
  });

  app.post('/admin/customers', async (c) => {
    const b = await c.req.json();
    if (!b.account_ref || !b.name) return c.json({ ok: false, error: 'account_ref and name required' }, 400);
    const fmt = b.message_id_format || 'passthrough';
    const res = await c.env.DB.prepare(
      'INSERT INTO customers (account_ref, name, message_id_format, enabled) VALUES (?, ?, ?, ?)'
    ).bind(b.account_ref, b.name, fmt, b.enabled === false ? 0 : 1).run();
    return c.json({ ok: true, id: res.meta.last_row_id });
  });

  app.patch('/admin/customers/:id', async (c) => {
    const id = c.req.param('id');
    const b = await c.req.json();
    const fields = [], vals = [];
    for (const k of ['name', 'account_ref', 'message_id_format', 'enabled']) {
      if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(k === 'enabled' ? (b[k] ? 1 : 0) : b[k]); }
    }
    if (!fields.length) return c.json({ ok: false, error: 'nothing to update' }, 400);
    vals.push(id);
    await c.env.DB.prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
    return c.json({ ok: true });
  });

  app.delete('/admin/customers/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM customers WHERE id = ?').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  // ---- MO routes -------------------------------------------------------
  app.get('/admin/mo-routes', async (c) => {
    const cid = new URL(c.req.url).searchParams.get('customer_id');
    const q = cid
      ? c.env.DB.prepare('SELECT * FROM mo_routes WHERE customer_id = ? ORDER BY specificity DESC, priority DESC, id DESC').bind(cid)
      : c.env.DB.prepare('SELECT * FROM mo_routes ORDER BY id DESC');
    const { results } = await q.all();
    return c.json({ ok: true, routes: results || [] });
  });

  app.post('/admin/mo-routes', async (c) => {
    const b = await c.req.json();
    if (!b.customer_id || !b.dest_url) return c.json({ ok: false, error: 'customer_id and dest_url required' }, 400);
    if (!b.match_sender_id && !b.match_keyword && b.allow_default !== true) {
      return c.json({ ok: false, error: 'rule needs a sender_id and/or keyword (set allow_default:true for a catch-all)' }, 400);
    }
    const spec = specificity(b.match_sender_id, b.match_keyword);
    const res = await c.env.DB.prepare(
      `INSERT INTO mo_routes (customer_id, match_sender_id, match_keyword, keyword_match, dest_url,
        specificity, priority, retry_policy_id, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(b.customer_id, b.match_sender_id || null, b.match_keyword || null,
           b.keyword_match || 'first_word', b.dest_url, spec, b.priority || 0,
           b.retry_policy_id || null, b.enabled === false ? 0 : 1).run();
    return c.json({ ok: true, id: res.meta.last_row_id });
  });

  app.patch('/admin/mo-routes/:id', async (c) => {
    const id = c.req.param('id');
    const b = await c.req.json();
    const fields = [], vals = [];
    for (const k of ['match_sender_id', 'match_keyword', 'keyword_match', 'dest_url', 'priority', 'retry_policy_id', 'enabled']) {
      if (b[k] !== undefined) { fields.push(`${k} = ?`); vals.push(k === 'enabled' ? (b[k] ? 1 : 0) : (b[k] || null)); }
    }
    if (b.match_sender_id !== undefined || b.match_keyword !== undefined) {
      const cur = await c.env.DB.prepare('SELECT match_sender_id, match_keyword FROM mo_routes WHERE id = ?').bind(id).first();
      const s = b.match_sender_id !== undefined ? b.match_sender_id : cur.match_sender_id;
      const k = b.match_keyword !== undefined ? b.match_keyword : cur.match_keyword;
      fields.push('specificity = ?'); vals.push(specificity(s, k));
    }
    if (!fields.length) return c.json({ ok: false, error: 'nothing to update' }, 400);
    vals.push(id);
    await c.env.DB.prepare(`UPDATE mo_routes SET ${fields.join(', ')} WHERE id = ?`).bind(...vals).run();
    return c.json({ ok: true });
  });

  app.delete('/admin/mo-routes/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM mo_routes WHERE id = ?').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  // ---- DR routes -------------------------------------------------------
  app.get('/admin/dr-routes', async (c) => {
    const cid = new URL(c.req.url).searchParams.get('customer_id');
    const q = cid
      ? c.env.DB.prepare('SELECT * FROM dr_routes WHERE customer_id = ? ORDER BY id DESC').bind(cid)
      : c.env.DB.prepare('SELECT * FROM dr_routes ORDER BY id DESC');
    const { results } = await q.all();
    return c.json({ ok: true, routes: results || [] });
  });

  app.post('/admin/dr-routes', async (c) => {
    const b = await c.req.json();
    if (!b.customer_id || !b.dest_url) return c.json({ ok: false, error: 'customer_id and dest_url required' }, 400);
    const res = await c.env.DB.prepare(
      `INSERT INTO dr_routes (customer_id, match_sender_id, dest_url, retry_policy_id, enabled)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(b.customer_id, b.match_sender_id || null, b.dest_url, b.retry_policy_id || null,
           b.enabled === false ? 0 : 1).run();
    return c.json({ ok: true, id: res.meta.last_row_id });
  });

  app.delete('/admin/dr-routes/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM dr_routes WHERE id = ?').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  // ---- Retry policies --------------------------------------------------
  app.get('/admin/retry-policies', async (c) => {
    const cid = new URL(c.req.url).searchParams.get('customer_id');
    const q = cid
      ? c.env.DB.prepare('SELECT * FROM retry_policies WHERE customer_id = ? ORDER BY id DESC').bind(cid)
      : c.env.DB.prepare('SELECT * FROM retry_policies ORDER BY id DESC');
    const { results } = await q.all();
    return c.json({ ok: true, policies: results || [] });
  });

  app.post('/admin/retry-policies', async (c) => {
    const b = await c.req.json();
    if (!b.name) return c.json({ ok: false, error: 'name required' }, 400);
    const stages = JSON.stringify(b.stages || [{ retryDelay: 60, retryDuration: 172800 }]);
    const res = await c.env.DB.prepare(
      'INSERT INTO retry_policies (customer_id, name, sender_id, stages, enabled) VALUES (?, ?, ?, ?, ?)'
    ).bind(b.customer_id || null, b.name, b.sender_id || null, stages, b.enabled === false ? 0 : 1).run();
    return c.json({ ok: true, id: res.meta.last_row_id });
  });

  app.delete('/admin/retry-policies/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM retry_policies WHERE id = ?').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  // ---- Logs ------------------------------------------------------------
  app.get('/admin/inbound', async (c) => {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM inbound_events ORDER BY id DESC LIMIT 200'
    ).all();
    return c.json({ ok: true, events: results || [] });
  });

  app.get('/admin/deliveries', async (c) => {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM deliveries ORDER BY id DESC LIMIT 200'
    ).all();
    return c.json({ ok: true, deliveries: results || [] });
  });
}
