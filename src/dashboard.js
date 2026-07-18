// Self-contained admin dashboard served at /dashboard. It calls the /admin JSON
// API using the token entered by the operator (kept in localStorage). Plain
// HTML/CSS/JS, no build step — ships as one string from the Worker.

export function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>MMX SMS Router — Admin</title>
<style>
  :root { --bg:#0f172a; --panel:#1e293b; --line:#334155; --text:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --ok:#22c55e; --bad:#ef4444; --warn:#f59e0b; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  header { padding:16px 24px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  header h1 { font-size:18px; margin:0; }
  header .sub { color:var(--muted); font-size:13px; }
  .token { margin-left:auto; display:flex; gap:8px; align-items:center; }
  input, select, textarea { background:#0b1220; color:var(--text); border:1px solid var(--line); border-radius:6px; padding:7px 9px; font-size:13px; }
  button { background:var(--accent); color:#04283a; border:0; border-radius:6px; padding:8px 12px; font-weight:600; cursor:pointer; font-size:13px; }
  button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
  button.danger { background:transparent; color:var(--bad); border:1px solid var(--bad); }
  nav { display:flex; gap:4px; padding:0 24px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  nav a { padding:12px 14px; color:var(--muted); cursor:pointer; border-bottom:2px solid transparent; font-size:14px; }
  nav a.active { color:var(--text); border-bottom-color:var(--accent); }
  main { padding:24px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; margin-bottom:18px; }
  .card h3 { margin:0 0 12px; font-size:15px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:10px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; }
  .pill.success { background:rgba(34,197,94,.15); color:var(--ok); }
  .pill.failed { background:rgba(239,68,68,.15); color:var(--bad); }
  .pill.pending { background:rgba(245,158,11,.15); color:var(--warn); }
  .muted { color:var(--muted); }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:end; }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:4px; }
  code { background:#0b1220; padding:1px 5px; border-radius:4px; font-size:12px; }
  .hint { font-size:12px; color:var(--muted); margin-top:6px; }
  .overflow { overflow-x:auto; }
</style>
</head>
<body>
<header>
  <div>
    <h1>MMX SMS Router</h1>
    <div class="sub">MO / DR callback routing &amp; delivery console</div>
  </div>
  <div class="token">
    <input id="token" placeholder="Admin token" size="24"/>
    <button onclick="saveToken()">Connect</button>
  </div>
</header>
<nav>
  <a data-tab="customers" class="active">Customers</a>
  <a data-tab="mo">MO Routes</a>
  <a data-tab="dr">DR Routes</a>
  <a data-tab="retry">Retry Policies</a>
  <a data-tab="logs">Delivery Log</a>
</nav>
<main id="view"></main>

<script>
const S = { tab:'customers', token: localStorage.getItem('mmx_token')||'', customers:[] };
document.getElementById('token').value = S.token;
function saveToken(){ S.token = document.getElementById('token').value.trim(); localStorage.setItem('mmx_token', S.token); render(); }
function h(s){ return (s==null?'':String(s)).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }
async function api(path, opts={}){
  const r = await fetch('/admin'+path, { ...opts, headers:{ 'content-type':'application/json', 'x-admin-token':S.token, ...(opts.headers||{}) }});
  if(r.status===401){ alert('Unauthorized — check the admin token.'); throw new Error('401'); }
  return r.json();
}
document.querySelectorAll('nav a').forEach(a=>a.onclick=()=>{ S.tab=a.dataset.tab; document.querySelectorAll('nav a').forEach(x=>x.classList.toggle('active',x===a)); render(); });

async function loadCustomers(){ const d = await api('/customers'); S.customers = d.customers||[]; return S.customers; }
function custOptions(sel){ return S.customers.map(c=>'<option value="'+c.id+'"'+(c.id==sel?' selected':'')+'>'+h(c.name)+' ('+h(c.account_ref)+')</option>').join(''); }

async function render(){
  const v = document.getElementById('view');
  if(!S.token){ v.innerHTML = '<div class="card">Enter your admin token above to connect.</div>'; return; }
  try { await loadCustomers(); } catch(e){ return; }
  if(S.tab==='customers') return renderCustomers(v);
  if(S.tab==='mo') return renderMo(v);
  if(S.tab==='dr') return renderDr(v);
  if(S.tab==='retry') return renderRetry(v);
  if(S.tab==='logs') return renderLogs(v);
}

function renderCustomers(v){
  v.innerHTML = \`
   <div class="card"><h3>Add customer</h3>
    <div class="row">
      <div><label>Account ref</label><input id="c_acc" placeholder="19871-115"/></div>
      <div><label>Name</label><input id="c_name" placeholder="Acme Corp"/></div>
      <div><label>message_id format</label><select id="c_fmt">
        <option value="passthrough">passthrough</option><option value="uuid">128-bit UUID</option>
        <option value="num12">numeric ≤12</option><option value="num19">numeric ≤19</option></select></div>
      <button onclick="addCustomer()">Add</button>
    </div></div>
   <div class="card overflow"><h3>Customers</h3>
    <div class="hint">Give each customer's two callback URLs below to the MMX provisioning team — MMX identifies the account by the URL it posts to.</div>
    <table><thead><tr><th>ID</th><th>Account</th><th>Name</th><th>msg_id fmt</th><th>MMX callback URLs</th><th></th></tr></thead><tbody>\`
   + S.customers.map(c=>{const mo=location.origin+'/inbound/mo/'+c.inbound_key; const dr=location.origin+'/inbound/dr/'+c.inbound_key; return '<tr><td>'+c.id+'</td><td><code>'+h(c.account_ref)+'</code></td><td>'+h(c.name)+'</td><td>'+h(c.message_id_format)+'</td><td><div class="muted" style="font-size:11px">MO</div><code>'+h(mo)+'</code><div class="muted" style="font-size:11px;margin-top:4px">DR</div><code>'+h(dr)+'</code></td><td><button class="ghost" onclick="rotateKey('+c.id+')">Rotate key</button> <button class="danger" onclick="delCustomer('+c.id+')">Delete</button></td></tr>';}).join('')
   + '</tbody></table></div>';
}
async function addCustomer(){ await api('/customers',{method:'POST',body:JSON.stringify({account_ref:c_acc.value.trim(),name:c_name.value.trim(),message_id_format:c_fmt.value})}); render(); }
async function delCustomer(id){ if(confirm('Delete customer and its routes?')){ await api('/customers/'+id,{method:'DELETE'}); render(); } }
async function rotateKey(id){ if(confirm('Rotate this customer\\'s callback key? You must give MMX the new URLs.')){ await api('/customers/'+id+'/rotate-key',{method:'POST'}); render(); } }

async function renderMo(v){
  const d = await api('/mo-routes'); const routes = d.routes||[];
  v.innerHTML = \`
   <div class="card"><h3>Add MO route</h3>
    <div class="row">
      <div><label>Customer</label><select id="m_cust">\`+custOptions()+\`</select></div>
      <div><label>Sender ID</label><input id="m_sender" placeholder="12345 (optional)"/></div>
      <div><label>Keyword</label><input id="m_kw" placeholder="word1 (optional)"/></div>
      <div><label>Keyword match</label><select id="m_km"><option value="first_word">first word</option><option value="contains">contains</option><option value="exact">exact</option></select></div>
      <div style="flex:1"><label>Destination URL</label><input id="m_url" style="width:100%" placeholder="https://customer.example/mo"/></div>
      <button onclick="addMo()">Add</button>
    </div>
    <div class="hint">Most specific rule wins: Sender ID + Keyword &gt; Keyword &gt; Sender ID &gt; catch-all. Leave both blank for a catch-all.</div></div>
   <div class="card overflow"><h3>MO routes</h3><table><thead><tr><th>ID</th><th>Customer</th><th>Sender ID</th><th>Keyword</th><th>Match</th><th>Dest URL</th><th>Spec</th><th></th></tr></thead><tbody>\`
   + routes.map(r=>{const c=S.customers.find(x=>x.id==r.customer_id);return '<tr><td>'+r.id+'</td><td>'+h(c?c.name:r.customer_id)+'</td><td>'+h(r.match_sender_id||'—')+'</td><td>'+h(r.match_keyword||'—')+'</td><td>'+h(r.keyword_match)+'</td><td><code>'+h(r.dest_url)+'</code></td><td>'+r.specificity+'</td><td><button class="danger" onclick="delMo('+r.id+')">Del</button></td></tr>';}).join('')
   + '</tbody></table></div>';
}
async function addMo(){ await api('/mo-routes',{method:'POST',body:JSON.stringify({customer_id:+m_cust.value,match_sender_id:m_sender.value.trim(),match_keyword:m_kw.value.trim(),keyword_match:m_km.value,dest_url:m_url.value.trim(),allow_default:(!m_sender.value.trim()&&!m_kw.value.trim())})}); render(); }
async function delMo(id){ await api('/mo-routes/'+id,{method:'DELETE'}); render(); }

async function renderDr(v){
  const d = await api('/dr-routes'); const routes = d.routes||[];
  v.innerHTML = \`
   <div class="card"><h3>Add DR route (fan-out)</h3>
    <div class="row">
      <div><label>Customer</label><select id="d_cust">\`+custOptions()+\`</select></div>
      <div><label>Sender ID</label><input id="d_sender" placeholder="12345 (optional = all)"/></div>
      <div style="flex:1"><label>Destination URL</label><input id="d_url" style="width:100%" placeholder="https://customer.example/dr"/></div>
      <button onclick="addDr()">Add</button>
    </div>
    <div class="hint">Add several rows for the same customer to fan one receipt out to multiple URLs. Set a Sender ID to scope a URL to that sender.</div></div>
   <div class="card overflow"><h3>DR routes</h3><table><thead><tr><th>ID</th><th>Customer</th><th>Sender ID</th><th>Dest URL</th><th></th></tr></thead><tbody>\`
   + routes.map(r=>{const c=S.customers.find(x=>x.id==r.customer_id);return '<tr><td>'+r.id+'</td><td>'+h(c?c.name:r.customer_id)+'</td><td>'+h(r.match_sender_id||'all')+'</td><td><code>'+h(r.dest_url)+'</code></td><td><button class="danger" onclick="delDr('+r.id+')">Del</button></td></tr>';}).join('')
   + '</tbody></table></div>';
}
async function addDr(){ await api('/dr-routes',{method:'POST',body:JSON.stringify({customer_id:+d_cust.value,match_sender_id:d_sender.value.trim(),dest_url:d_url.value.trim()})}); render(); }
async function delDr(id){ await api('/dr-routes/'+id,{method:'DELETE'}); render(); }

async function renderRetry(v){
  const d = await api('/retry-policies'); const pols = d.policies||[];
  v.innerHTML = \`
   <div class="card"><h3>Add retry policy</h3>
    <div class="row">
      <div><label>Customer</label><select id="r_cust"><option value="">(global)</option>\`+custOptions()+\`</select></div>
      <div><label>Name</label><input id="r_name" placeholder="Aggressive"/></div>
      <div><label>Sender ID</label><input id="r_sender" placeholder="optional override"/></div>
      <div style="flex:1"><label>Stages JSON</label><input id="r_stages" style="width:100%" value='[{"retryDelay":10,"retryDuration":100},{"retryDelay":30,"retryDuration":300}]'/></div>
      <button onclick="addRetry()">Add</button>
    </div>
    <div class="hint">Each stage allows floor(retryDuration / retryDelay) retries, e.g. delay 10 / duration 100 = 10 retries, then the next stage begins.</div></div>
   <div class="card overflow"><h3>Retry policies</h3><table><thead><tr><th>ID</th><th>Scope</th><th>Name</th><th>Sender ID</th><th>Stages</th><th></th></tr></thead><tbody>\`
   + pols.map(p=>{const c=S.customers.find(x=>x.id==p.customer_id);return '<tr><td>'+p.id+'</td><td>'+(p.customer_id?h(c?c.name:p.customer_id):'global')+'</td><td>'+h(p.name)+'</td><td>'+h(p.sender_id||'—')+'</td><td><code>'+h(p.stages)+'</code></td><td><button class="danger" onclick="delRetry('+p.id+')">Del</button></td></tr>';}).join('')
   + '</tbody></table></div>';
}
async function addRetry(){ let stages; try{stages=JSON.parse(r_stages.value);}catch(e){return alert('Stages must be valid JSON');} await api('/retry-policies',{method:'POST',body:JSON.stringify({customer_id:r_cust.value?+r_cust.value:null,name:r_name.value.trim(),sender_id:r_sender.value.trim(),stages})}); render(); }
async function delRetry(id){ await api('/retry-policies/'+id,{method:'DELETE'}); render(); }

async function renderLogs(v){
  const [dd, ie] = await Promise.all([api('/deliveries'), api('/inbound')]);
  const del = dd.deliveries||[]; const inb = ie.events||[];
  v.innerHTML = \`
   <div class="card overflow"><h3>Deliveries (latest 200)</h3><table><thead><tr><th>ID</th><th>Dir</th><th>Dest</th><th>msg_id</th><th>Status</th><th>Attempts</th><th>Stage</th><th>Next retry</th><th>Code</th></tr></thead><tbody>\`
   + del.map(d=>'<tr><td>'+d.id+'</td><td>'+h(d.direction)+'</td><td><code>'+h(d.dest_url)+'</code></td><td>'+h(d.message_id||'—')+'</td><td><span class="pill '+h(d.status)+'">'+h(d.status)+'</span></td><td>'+d.attempts+'</td><td>'+d.stage_index+'/'+d.stage_attempts+'</td><td class="muted">'+h(d.next_attempt_at||'—')+'</td><td>'+h(d.last_status_code||'—')+'</td></tr>').join('')
   + \`</tbody></table></div>
   <div class="card overflow"><h3>Inbound events (latest 200)</h3><table><thead><tr><th>ID</th><th>Type</th><th>Account</th><th>Sender</th><th>Keyword</th><th>msg_id</th><th>Matched</th><th>At</th></tr></thead><tbody>\`
   + inb.map(e=>'<tr><td>'+e.id+'</td><td>'+h(e.type)+'</td><td>'+h(e.account_ref||'—')+'</td><td>'+h(e.sender_id||'—')+'</td><td>'+h(e.keyword||'—')+'</td><td>'+h(e.message_id||'—')+'</td><td>'+e.matched_count+'</td><td class="muted">'+h(e.created_at)+'</td></tr>').join('')
   + '</tbody></table></div>';
}
render();
</script>
</body>
</html>`;
}
