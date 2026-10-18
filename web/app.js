const log = document.getElementById('log');
const box = document.getElementById('whybody');
const aside = document.getElementById('why');
const raw = document.getElementById('raw');
const rawwrap = document.getElementById('rawwrap');
const form = document.getElementById('f');
const input = document.getElementById('t');
const sendBtn = document.getElementById('s');
const examples = document.getElementById('examples');

// The transcript is the client's to carry. There is no session table on this path,
// so the whole conversation is resent each turn — cheap at demo scale, and honest
// about not being how the WhatsApp flow works.
let messages = [];
try { messages = JSON.parse(sessionStorage.getItem('jorip.transcript') ?? '[]'); } catch { messages = []; }

const EXAMPLES = [
  'আমার ক্লিনিকের জন্য হোয়াটসঅ্যাপ অটোমেশন লাগবে, বাজেট ৩০০০০ টাকা, এই মাসেই শুরু করতে চাই',
  'I run a tailors shop, want something to stop missing enquiries, maybe 10k, I decide',
  'just looking for now, need to ask my partner first',
  'what does it cost?',
];

function bubble(text, who) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function badge(h) {
  const cls = h === 'hot' ? 'hot' : h === 'warm' ? 'warm' : h === 'cold' ? 'cold' : 'null';
  return `<span class="badge ${cls}">${h ?? 'not yet trusted'}</span>`;
}

function renderDecision(d) {
  aside.classList.remove('empty');
  const s = d.score ?? {};
  const e = d.extraction ?? {};
  const usage = (d.usage ?? []);
  const tokens = usage.reduce((a, u) => a + (u.tokens_in ?? 0) + (u.tokens_out ?? 0), 0);
  const ms = usage.reduce((a, u) => a + (u.latency_ms ?? 0), 0);
  const rows = [
    ['hotness', badge(d.hotness)],
    ['action', `<b>${d.action ?? '—'}</b>`],
    ['reason', `<b>${s.reason_code ?? '—'}</b>`],
    ['total', `<b>${s.total ?? 0}</b>`],
    ['need', `${s.need_pts ?? 0}  <span style="color:var(--dim)">← ${e.need ?? '—'}</span>`],
    ['budget', `${s.budget_pts ?? 0}  <span style="color:var(--dim)">← ${e.budget_bdt ?? 'unknown'}</span>`],
    ['timeline', `${s.timeline_pts ?? 0}  <span style="color:var(--dim)">← ${e.timeline ?? '—'}</span>`],
    ['authority', `${s.authority_pts ?? 0}  <span style="color:var(--dim)">← ${e.authority ?? '—'}</span>`],
    ['confidence', `<b>${e.confidence ?? '—'}</b>`],
    ['reply from', `<b>${d.reply_source}</b>`],
    ['repairs', `<b>${d.repair_attempts}</b>`],
    ['escalate', `<b>${(d.escalations ?? []).join(', ') || '—'}</b>`],
    ['rule', `<b>${d.rule_version}</b>`],
    ['tokens', `${tokens} · ${ms} ms`],
  ];
  box.innerHTML = rows.map(([k, v]) => `<div class="row"><span>${k}</span>${v}</div>`).join('');
  raw.textContent = JSON.stringify(d, null, 2);
  rawwrap.hidden = false;
}

function restore() {
  for (const m of messages) bubble(m.text, m.role === 'lead' ? 'lead' : 'bot');
  if (messages.length) bubble('Continuing where you left off — this tab holds the conversation.', 'sys');
}

async function submit(text) {
  messages.push({ role: 'lead', text });
  bubble(text, 'lead');
  sendBtn.disabled = true;
  const thinking = bubble('…', 'bot');
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    const data = await res.json().catch(() => ({}));
    thinking.remove();
    if (!res.ok) {
      const map = {
        405: 'POST /api/chat is not wired — the function did not deploy.',
        429: 'Too many messages from here. Try again in a minute.',
        413: 'That message was too long.',
        503: data.error === 'daily_cap_reached'
          ? 'The free model quota for today is used up. A human reads these messages regardless.'
          : 'This demo is not configured right now.',
        502: 'The model did not answer. Nothing was invented in its place — try once more.',
      };
      bubble(map[res.status] ?? `Something went wrong (${res.status}).`, 'sys');
      return;
    }
    messages.push({ role: 'assistant', text: data.reply });
    sessionStorage.setItem('jorip.transcript', JSON.stringify(messages));
    bubble(data.reply, 'bot');
    renderDecision(data);
  } catch (err) {
    thinking.remove();
    bubble('Could not reach the agent. It is not faking an answer offline.', 'sys');
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  submit(text);
});
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); }
});

EXAMPLES.forEach((ex) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = ex.length > 46 ? ex.slice(0, 44) + '…' : ex;
  b.title = ex;
  b.onclick = () => submit(ex);
  examples.appendChild(b);
});

if (!messages.length) {
  bubble('Hi — I am Jorip, an assistant, not a person. Tell me what you want to get set up and I will work out whether a call makes sense.', 'bot');
} else {
  restore();
}
