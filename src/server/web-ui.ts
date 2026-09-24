export const webUi = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Agent Gateway</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, Consolas, monospace; }
    body { margin: 0; background: #0c1017; color: #dce4ee; }
    header { padding: 16px 22px; border-bottom: 1px solid #253042; display:flex; gap:18px; align-items:center; }
    main { display:grid; grid-template-columns: 280px 1fr; height:calc(100vh - 61px); }
    aside { border-right:1px solid #253042; padding:14px; overflow:auto; }
    section { display:flex; flex-direction:column; min-width:0; }
    button, input, select, textarea { background:#151c27; color:#dce4ee; border:1px solid #334155; border-radius:6px; padding:8px; }
    button { cursor:pointer; }
    .item { padding:10px; border:1px solid #253042; border-radius:7px; margin-bottom:8px; cursor:pointer; }
    .item:hover, .item.active { border-color:#5d8bd8; }
    #events { flex:1; overflow:auto; padding:18px; white-space:pre-wrap; line-height:1.5; }
    #composer { display:flex; gap:8px; padding:12px; border-top:1px solid #253042; }
    #message { flex:1; }
    .delta { color:#ecf3ff; }
    .tool { color:#f2c66d; }
    .error { color:#ff8585; }
    .muted { color:#7f8da3; font-size:12px; }
  </style>
</head>
<body>
  <header><strong>Agent Gateway</strong><span id="connection" class="muted">connecting</span></header>
  <main>
    <aside><button onclick="refresh()">刷新</button><h3>设备</h3><div id="devices"></div><h3>会话</h3><div id="sessions"></div></aside>
    <section><div id="events">选择一个会话查看事件。</div><div id="composer"><input id="message" placeholder="输入消息"/><select id="delivery"><option>auto</option><option>steer</option><option>queue</option><option>interrupt</option></select><button onclick="sendMessage()">发送</button><button onclick="interrupt()">中断</button></div></section>
  </main>
<script>
let selectedSession;
const events = document.getElementById('events');
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/v1/terminal');
ws.onopen = () => document.getElementById('connection').textContent = 'connected';
ws.onclose = () => document.getElementById('connection').textContent = 'disconnected';
ws.onmessage = e => { const m=JSON.parse(e.data); if(m.type==='agent.event' && m.payload.sessionId===selectedSession) renderEvent(m.payload); refresh(); };
async function refresh(){
  const [devices,sessions]=await Promise.all([fetch('/v1/devices').then(r=>r.json()),fetch('/v1/sessions').then(r=>r.json())]);
  document.getElementById('devices').innerHTML=devices.map(d=>'<div class="item"><b>'+escapeHtml(d.device.name)+'</b><div class="muted">'+d.device.id+' · '+d.status+'</div></div>').join('');
  document.getElementById('sessions').innerHTML=sessions.map(s=>'<div class="item '+(s.id===selectedSession?'active':'')+'" onclick="selectSession(\''+s.id+'\')"><b>'+s.agent+'</b><div class="muted">'+s.id+' · '+s.status+'</div></div>').join('');
}
async function selectSession(id){ selectedSession=id; events.textContent=''; const list=await fetch('/v1/sessions/'+id+'/events').then(r=>r.json()); list.forEach(renderEvent); ws.send(JSON.stringify({type:'subscribe',sessionId:id})); refresh(); }
function renderEvent(e){ const line=document.createElement('div'); line.className=e.type.includes('error')?'error':e.type.startsWith('tool.')?'tool':e.type==='assistant.delta'?'delta':'muted'; const p=e.payload||{}; line.textContent=e.type==='assistant.delta'?(p.delta||p.text||''): '['+e.type+'] '+JSON.stringify(p); events.appendChild(line); events.scrollTop=events.scrollHeight; }
async function command(type,payload){ if(!selectedSession)return; await fetch('/v1/sessions/'+selectedSession+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),type,payload})}); }
async function sendMessage(){ const el=document.getElementById('message'); await command('message.send',{content:el.value,delivery:document.getElementById('delivery').value}); el.value=''; }
async function interrupt(){ await command('turn.interrupt',{}); }
function escapeHtml(v){ const d=document.createElement('div'); d.textContent=v; return d.innerHTML; }
refresh();
</script>
</body>
</html>`;

