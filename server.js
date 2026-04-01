const express = require("express");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── credentials from env ──────────────────────────────────────────────────────
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_PHONE_NUMBER;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── in-memory reminder store ──────────────────────────────────────────────────
const scheduled = new Map(); // jobId → {timeout, data, phone}

// ── helpers ───────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  try { return new Date(iso).toLocaleString("en-SE", { dateStyle:"medium", timeStyle:"short" }); }
  catch { return iso; }
}

async function sendSMS(to, body) {
  const creds = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || "Twilio error");
  return j;
}

async function parseReminder(text) {
  const now = new Date().toISOString().slice(0,19).replace("T"," ");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 400,
      system: `Extract reminder data from SMS. Current date/time: ${now}
Rules: calculate exact datetimes, default reminder 10min before, "call me" = notification_type call else sms, use ISO 8601.
Return ONLY valid JSON no markdown: {"task":"string","event_time":"ISO","reminder_time":"ISO","notification_type":"sms or call"}`,
      messages: [{ role:"user", content: text }]
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || "Anthropic error");
  const raw = d.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim();
  return JSON.parse(raw);
}

// ── routes ────────────────────────────────────────────────────────────────────

// Register: send welcome SMS
app.post("/api/register", async (req, res) => {
  let { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone number required" });
  phone = phone.replace(/\s+/g,"");
  if (phone.startsWith("0")) phone = "+46" + phone.slice(1);
  if (!phone.startsWith("+")) phone = "+46" + phone;
  try {
    await sendSMS(phone,
      "👋 Hi! SMS Reminder Bot here.\n\nReply with a reminder like:\n• Gym at 6pm remind me 1 hour before\n• Doctor tomorrow at 10am call me 30 min before\n\nI'll text you right back when it's time! ⏰"
    );
    res.json({ success: true, phone });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Twilio webhook: incoming SMS
app.post("/webhook/sms", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();
  const { MessagingResponse } = require("twilio").twiml;
  const twiml = new MessagingResponse();

  if (!body) {
    twiml.message('Try: "Gym at 6pm remind me 1 hour before"');
    return res.type("text/xml").send(twiml.toString());
  }

  try {
    const parsed = await parseReminder(body);
    const reminderDate = new Date(parsed.reminder_time);
    const delay = reminderDate - Date.now();

    if (delay < 0) {
      twiml.message("⚠️ That time has already passed! Try a future time.");
      return res.type("text/xml").send(twiml.toString());
    }

    const jobId = `${from}-${Date.now()}`;
    const t = setTimeout(async () => {
      await sendSMS(from, `⏰ Reminder: ${parsed.task}\nScheduled for: ${fmtDate(parsed.event_time)}`);
      scheduled.delete(jobId);
    }, delay);
    scheduled.set(jobId, { t, parsed, phone: from });

    const mins = Math.round(delay / 60000);
    twiml.message(`✅ Got it!\n📌 ${parsed.task}\n📅 Event: ${fmtDate(parsed.event_time)}\n🔔 Reminder: ${fmtDate(parsed.reminder_time)} (~${mins} min)\n\nReply anytime to set another!`);
  } catch(e) {
    console.error(e);
    twiml.message('❌ Couldn\'t parse that. Try: "Meeting at 3pm remind me 30 min before"');
  }
  res.type("text/xml").send(twiml.toString());
});

// Health check
app.get("/health", (_, res) => res.json({ ok: true, reminders: scheduled.size }));

// ── frontend (embedded) ───────────────────────────────────────────────────────
app.get("/", (_, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SMS Reminder Bot</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=Syne+Mono&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#060608;--s1:#0f0f14;--s2:#17171f;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
  --text:#eeeae4;--muted:#6b6b7a;
  --acc:#7cffd4;--acc2:#3de0b0;
  --err:#ff6b8a;--ok:#7cffd4;
}
html{background:var(--bg);color:var(--text);font-family:'Syne',sans-serif;min-height:100vh}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:0 1.25rem}

/* grid bg */
body::before{content:'';position:fixed;inset:0;
  background-image:linear-gradient(rgba(124,255,212,.025) 1px,transparent 1px),
    linear-gradient(90deg,rgba(124,255,212,.025) 1px,transparent 1px);
  background-size:56px 56px;pointer-events:none;z-index:0}

/* glow orb */
body::after{content:'';position:fixed;top:-120px;left:50%;transform:translateX(-50%);
  width:600px;height:400px;border-radius:50%;
  background:radial-gradient(ellipse,rgba(124,255,212,.06) 0%,transparent 70%);
  pointer-events:none;z-index:0}

.page{position:relative;z-index:1;width:100%;max-width:500px;padding:4rem 0 6rem}

/* badge */
.badge{display:inline-flex;align-items:center;gap:7px;
  border:1px solid rgba(124,255,212,.22);border-radius:100px;
  padding:5px 14px;font-size:11px;color:var(--acc);font-family:'Syne Mono',monospace;
  margin-bottom:1.75rem;letter-spacing:.05em}
.dot{width:6px;height:6px;border-radius:50%;background:var(--acc);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}

h1{font-size:clamp(2.6rem,9vw,3.6rem);font-weight:800;line-height:1.05;
  margin-bottom:.9rem;letter-spacing:-.02em}
h1 span{color:var(--acc)}
.sub{font-size:15px;color:var(--muted);line-height:1.65;margin-bottom:2.5rem;font-weight:400}

/* card */
.card{background:var(--s1);border:1px solid var(--border);
  border-radius:20px;padding:1.75rem;margin-bottom:1.25rem}
.card-label{font-size:10px;font-family:'Syne Mono',monospace;color:var(--muted);
  letter-spacing:.1em;margin-bottom:1rem}

/* input */
.row{display:flex;gap:8px}
.prefix{display:flex;align-items:center;padding:0 14px;height:50px;
  background:var(--s2);border:1px solid var(--border2);border-radius:12px;
  font-family:'Syne Mono',monospace;font-size:13px;color:var(--muted);white-space:nowrap}
input[type=tel]{flex:1;height:50px;background:var(--s2);border:1px solid var(--border2);
  border-radius:12px;padding:0 16px;font-size:15px;font-family:'Syne Mono',monospace;
  color:var(--text);outline:none;transition:border-color .2s;min-width:0}
input[type=tel]::placeholder{color:var(--muted);opacity:.45}
input[type=tel]:focus{border-color:rgba(124,255,212,.35)}

/* button */
.btn{display:flex;align-items:center;justify-content:center;width:100%;
  height:52px;margin-top:12px;background:var(--acc);color:#060608;
  border:none;border-radius:13px;font-size:15px;font-weight:700;
  font-family:'Syne',sans-serif;cursor:pointer;transition:background .15s,transform .1s;gap:8px}
.btn:hover{background:#a0ffe4}
.btn:active{transform:scale(.98)}
.btn:disabled{background:#1e2e28;color:var(--muted);cursor:not-allowed}
.spin{width:17px;height:17px;border:2px solid rgba(6,6,8,.25);border-top-color:#060608;
  border-radius:50%;animation:sp .65s linear infinite;display:none}
@keyframes sp{to{transform:rotate(360deg)}}
.btn.loading .btn-text{display:none}
.btn.loading .spin{display:block}

/* status */
.status{display:none;border-radius:13px;padding:14px 16px;font-size:14px;
  line-height:1.6;margin-top:12px;font-family:'Syne Mono',monospace;white-space:pre-line}
.ok{display:block;background:rgba(124,255,212,.07);border:1px solid rgba(124,255,212,.18);color:var(--ok)}
.err{display:block;background:rgba(255,107,138,.07);border:1px solid rgba(255,107,138,.18);color:var(--err)}

/* steps */
.steps-title{font-size:10px;font-family:'Syne Mono',monospace;color:var(--muted);
  letter-spacing:.1em;margin:2rem 0 .85rem}
.step{display:flex;gap:14px;align-items:flex-start;padding:13px 0;
  border-bottom:1px solid var(--border)}
.step:last-child{border-bottom:none}
.snum{flex-shrink:0;width:28px;height:28px;border-radius:50%;
  border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;
  font-family:'Syne Mono',monospace;font-size:11px;color:var(--muted);margin-top:1px}
.stxt{font-size:14px;color:var(--muted);line-height:1.55}
.stxt strong{color:var(--text);font-weight:600}
.bubble{background:var(--s2);border:1px solid var(--border2);
  border-radius:13px 13px 13px 3px;padding:10px 14px;
  font-size:12px;font-family:'Syne Mono',monospace;color:var(--text);
  margin-top:8px;display:inline-block;line-height:1.55}

.foot{font-size:12px;color:var(--muted);text-align:center;margin-top:2.5rem;line-height:1.8;opacity:.65}
.foot a{color:var(--acc);text-decoration:none}
</style>
</head>
<body>
<div class="page">
  <div class="badge"><span class="dot"></span>AI · Twilio · Live</div>
  <h1>Remind me<br/><span>by text</span></h1>
  <p class="sub">Enter your number. We text you. You reply in plain English. We remind you — automatically.</p>

  <div class="card">
    <div class="card-label">YOUR PHONE NUMBER</div>
    <div class="row">
      <div class="prefix">🇸🇪 +46</div>
      <input type="tel" id="ph" placeholder="70 123 45 67" />
    </div>
    <button class="btn" id="btn" onclick="register()">
      <span class="btn-text">Send me a message →</span>
      <div class="spin"></div>
    </button>
    <div class="status" id="st"></div>
  </div>

  <div class="steps-title">HOW IT WORKS</div>
  <div class="step"><div class="snum">1</div><div class="stxt"><strong>Enter your number</strong> above — we send you a welcome SMS right away.</div></div>
  <div class="step"><div class="snum">2</div><div class="stxt"><strong>Reply with a reminder</strong> in plain text:<div class="bubble">Doctor tomorrow at 10am<br/>call me 30 min before</div></div></div>
  <div class="step"><div class="snum">3</div><div class="stxt"><strong>Claude AI parses it</strong> — extracts task, date, time and notification type instantly.</div></div>
  <div class="step"><div class="snum">4</div><div class="stxt"><strong>At reminder time</strong> we text you automatically. ⏰ Reply anytime to set more.</div></div>

  <p class="foot">Powered by <a href="https://twilio.com">Twilio</a> + <a href="https://anthropic.com">Claude AI</a><br/>Your number is used only to send reminders.</p>
</div>
<script>
async function register(){
  let v=document.getElementById('ph').value.trim();
  const btn=document.getElementById('btn'),st=document.getElementById('st');
  if(!v){show('err','Please enter your phone number.');return}
  let p=v.replace(/\\s+/g,'');
  if(p.startsWith('0'))p='+46'+p.slice(1);
  else if(!p.startsWith('+'))p='+46'+p;
  btn.classList.add('loading');btn.disabled=true;st.className='status';
  try{
    const r=await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:p})});
    const d=await r.json();
    if(d.success)show('ok','✅ Message sent to '+p+'!\\n\\nCheck your phone and reply with a reminder like:\\n"Gym at 6pm remind me 1 hour before"');
    else show('err','❌ '+( d.error||'Something went wrong.'));
  }catch(e){show('err','❌ Server error: '+e.message);}
  btn.classList.remove('loading');btn.disabled=false;
}
function show(t,m){const el=document.getElementById('st');el.className='status '+t;el.textContent=m;}
document.getElementById('ph').addEventListener('keydown',e=>{if(e.key==='Enter')register();});
</script>
</body>
</html>`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Running on port ${PORT}`));
