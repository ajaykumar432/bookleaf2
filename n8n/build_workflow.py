"""Generates n8n/bookleaf-royalty-workflow.json and n8n/code/*.js (the JS used inside Code nodes)."""
import json, pathlib
HERE = pathlib.Path(__file__).parent

NORM = r"""
// Bubble Data API returns fields as "<name>_<type>" (e.g. royalty_pending_number). Strip the type suffix.
const norm = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) =>
  [k.replace(/_(list_text|list_number|list_date|text|number|date|boolean|custom_[a-z0-9_]+|option_[a-z0-9_]+|user)$/, ''), v]));
"""

VALIDATE_REQUEST = r"""
// Node 2: authenticate + validate + de-duplicate the incoming webhook call.
const cfg = $('Config').first().json;
const req = $('Webhook').first().json;
const headers = req.headers || {};
const body = req.body || {};

// constant-time shared-secret comparison
const provided = String(headers['x-api-key'] || '');
const secret = String(cfg.WEBHOOK_SECRET || '');
let diff = provided.length ^ secret.length;
for (let i = 0; i < Math.max(provided.length, secret.length); i++) diff |= (provided.charCodeAt(i) || 0) ^ (secret.charCodeAt(i) || 0);
const auth_ok = secret.length >= 16 && diff === 0;

const required = ['author_id', 'author_unique_id', 'notification_log_id', 'idempotency_key'];
const missing = required.filter((k) => !body[k] || String(body[k]).trim() === '');
const params_ok = missing.length === 0;

// n8n-side idempotency: remember keys for 10 minutes (workflow static data; persists on active workflows)
const sd = $getWorkflowStaticData('global');
sd.seen = sd.seen || {};
const now = Date.now();
for (const k of Object.keys(sd.seen)) if (now - sd.seen[k] > 10 * 60 * 1000) delete sd.seen[k];
let not_duplicate = true;
if (auth_ok && params_ok) {
  if (sd.seen[body.idempotency_key]) not_duplicate = false;
  else sd.seen[body.idempotency_key] = now;
}
return [{ json: { auth_ok, params_ok, missing, not_duplicate } }];
"""

CHECK_LOG = NORM + r"""
// Node 5: confirm the NotificationLog row exists, matches the idempotency key, and is not already done.
const body = $('Webhook').first().json.body;
const raw = $input.first().json.response || {};
const log = norm(raw);
let proceed = true, reason = '';
if (!raw._id) { proceed = false; reason = 'Notification log not found'; }
else if (log.idempotency_key !== body.idempotency_key) { proceed = false; reason = 'Idempotency key mismatch'; }
else if (log.status === 'Success') { proceed = false; reason = 'Already completed - duplicate ignored'; }
return [{ json: { proceed, reason } }];
"""

PREPARE = NORM + r"""
// Node 8: normalise Bubble data, compute every figure deterministically, build the AI request.
// The model only WRITES the email; it never calculates anything.
const cfg = $('Config').first().json;
const body = $('Webhook').first().json.body;
const authorRaw = $('Fetch Author').first().json.response;
const booksRaw = (($('Fetch Books').first().json.response) || {}).results || [];

const author = norm(authorRaw);
if (!authorRaw || !author.author_id) return [{ json: { ok: false, error: 'Author not found in Bubble for id ' + body.author_id } }];
if (author.author_id !== body.author_id) return [{ json: { ok: false, error: 'Author mismatch: webhook author_id does not match the Bubble record' } }];
const books = booksRaw.map(norm);

const OVERDUE_DAYS = Number(cfg.OVERDUE_DAYS) || 90;
const MIN_PAYOUT = Number(cfg.MIN_PAYOUT) || 1000;
const today = cfg.REFERENCE_DATE ? new Date(cfg.REFERENCE_DATE + 'T00:00:00Z') : new Date();

const num = (v) => Number(v) || 0;
// Bubble stores dates as UTC instants; shift by IST so a date entered as local midnight keeps its day
const day = (v) => (v ? new Date(new Date(v).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10) : null);
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate = (d) => { if (!d) return null; const x = new Date(typeof d === 'string' ? d + 'T00:00:00Z' : d); return x.getUTCDate() + ' ' + MON[x.getUTCMonth()] + ' ' + x.getUTCFullYear(); };
const inr = (n) => { const s = String(Math.round(num(n))); const last3 = s.slice(-3), rest = s.slice(0, -3); return '₹' + (rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3); };
const daysSince = (iso) => Math.floor((today - new Date(iso + 'T00:00:00Z')) / 86400000);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

const isPublished = (b) => b.status === 'Published & Live';
const royaltyStatus = (b) => {
  if (num(b.royalty_pending) <= 0) return 'GREEN';
  const lp = day(b.last_royalty_payout_date);
  if (lp) return daysSince(lp) > OVERDUE_DAYS ? 'RED' : 'YELLOW';
  const pd = day(b.publication_date);
  return pd && daysSince(pd) > OVERDUE_DAYS ? 'RED' : 'YELLOW';   // never paid + published > 90 days
};

const published = books.filter(isPublished);
const production = books.filter((b) => !isPublished(b));          // excluded from all royalty maths
const totals = published.reduce((t, b) => ({ earned: t.earned + num(b.total_royalty_earned), paid: t.paid + num(b.royalty_paid), pending: t.pending + num(b.royalty_pending), copies: t.copies + num(b.total_copies_sold) }), { earned: 0, paid: 0, pending: 0, copies: 0 });

// Royalty calendar from the Assignment-1 KB: calendar quarters, paid within 45 days of quarter end
const y = today.getUTCFullYear(), q = Math.floor(today.getUTCMonth() / 3);
const lastQuarterEnd = new Date(Date.UTC(y, q * 3, 0));
const currentQuarterEnd = new Date(Date.UTC(y, q * 3 + 3, 0));
const lastPayoutBy = addDays(lastQuarterEnd, 45), nextPayoutBy = addDays(currentQuarterEnd, 45);

const statuses = published.map(royaltyStatus);
let type = 'on_schedule';
if (totals.pending === 0) type = 'all_paid';
else if (totals.pending < MIN_PAYOUT) type = 'rolls_over';
else if (statuses.includes('RED')) type = 'overdue';

const facts = {
  author_first_name: String(author.name || '').split(' ')[0],
  author_full_name: author.name,
  today: fmtDate(today),
  payout_message_type: type,
  totals: { copies_sold: totals.copies, earned: inr(totals.earned), paid: inr(totals.paid), pending: inr(totals.pending) },
  published_books: published.map((b) => ({
    title: b.title, copies_sold: num(b.total_copies_sold), earned: inr(b.total_royalty_earned), paid: inr(b.royalty_paid), pending: inr(b.royalty_pending),
    last_payout_date: day(b.last_royalty_payout_date) ? fmtDate(day(b.last_royalty_payout_date)) : 'No payout has been made yet', royalty_status: royaltyStatus(b),
  })),
  books_in_production: production.map((b) => ({ title: b.title, current_stage: b.status })),
  payout_calendar: {
    policy: 'Royalties are calculated quarterly and paid within 45 days of quarter end. Minimum payout is ' + inr(MIN_PAYOUT) + '; smaller balances roll over to the next quarter.',
    last_quarter_ended: fmtDate(lastQuarterEnd), last_quarter_payout_due_by: fmtDate(lastPayoutBy),
    current_quarter_ends: fmtDate(currentQuarterEnd), next_payout_due_by: fmtDate(nextPayoutBy),
  },
};

const allowed = {
  numbers: [...new Set([MIN_PAYOUT, 45, ...published.flatMap((b) => [num(b.total_royalty_earned), num(b.royalty_paid), num(b.royalty_pending)]), totals.earned, totals.paid, totals.pending])],
  dates: [facts.today, facts.payout_calendar.last_quarter_ended, facts.payout_calendar.last_quarter_payout_due_by, facts.payout_calendar.current_quarter_ends, facts.payout_calendar.next_payout_due_by,
          ...published.map((b) => day(b.last_royalty_payout_date)).filter(Boolean).map(fmtDate)],
  titles: published.map((b) => b.title),
};

const system = `You write royalty summary emails for BookLeaf Publishing, a self-publishing company in India. You are drafting for the BookLeaf team to send to ONE author.

TONE: empathetic, professional, warm; authors are partners, not customers. Acknowledge their situation first. Be specific with the exact figures given. If BookLeaf is late, own it plainly (no corporate deflection) and give a clear timeline. End with one clear next step.

HARD RULES
- Use ONLY the figures, dates and statuses in the JSON. Copy money exactly as written (e.g. "₹11,970"). Never calculate, round, convert or invent numbers or dates.
- Never say a payout has been made/processed/sent unless the JSON says so. "last_payout_date" is the only confirmed payout.
- Mention only this author's books. Keep real publication/production statuses.
- Plain text only: no markdown, no bold, no tables. Short paragraphs; one line per book.
- 170-280 words.

STRUCTURE
1. "Hi <first name>," + one warm opening line.
2. One line per published book: title, copies sold, earned, paid, pending (and last payout date, or that no payout has been made yet).
3. Totals line: total earned, total paid, total pending.
4. Payout paragraph, chosen by payout_message_type:
   - all_paid: thank them warmly; confirm every royalty is paid up; nothing pending.
   - on_schedule: explain quarterly calculation + 45-day window; say the next payout is due by next_payout_due_by.
   - rolls_over: pending is below the minimum payout, so it rolls over and is paid once the balance reaches the minimum; reference next_payout_due_by only as the next payout window.
   - overdue: acknowledge pending royalties are past BookLeaf's normal payout window; apologise and own it; say the accounts team is reviewing and will confirm payment timing within 48 hours. Do not invent a payment date.
5. If books_in_production is not empty: one short status line per book using the exact current_stage (do not promise a launch date).
6. Close: "Warm regards,\nBookLeaf Author Support Team".

OUTPUT: return ONLY a JSON object {"subject": "...", "body": "..."}; "body" is the full email text with \\n line breaks. Subject: short, e.g. "Your BookLeaf royalty summary".`;

const ai_request = {
  model: cfg.AI_MODEL, temperature: 0.3, max_tokens: 2000,
  messages: [{ role: 'system', content: system }, { role: 'user', content: 'Author data (JSON):\n' + JSON.stringify(facts, null, 2) }],
};
if (cfg.AI_REASONING_EFFORT) ai_request.reasoning_effort = cfg.AI_REASONING_EFFORT;

return [{ json: { ok: true, author_email: author.email, author_name: author.name, facts, allowed, ai_request } }];
"""

VALIDATE_AI = r"""
// Node 10: never trust the model. Parse it, then check every figure/date/title against the verified facts.
const prep = $('Prepare Data').first().json;
const raw = $input.first().json || {};
let content = (raw.choices && raw.choices[0] && raw.choices[0].message && raw.choices[0].message.content) || '';
content = String(content).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '').trim();

const fail = (error) => [{ json: { ok: false, error } }];
const m = content.match(/\{[\s\S]*\}/);
if (!m) return fail('Model returned no JSON object');
let out;
try { out = JSON.parse(m[0]); } catch (e) { return fail('Model returned malformed JSON'); }
const subject = String(out.subject || '').trim();
const body = String(out.body || '').trim();
if (!subject) return fail('Empty subject');
if (body.length < 120) return fail('Email body empty or too short');

// 1) every rupee amount must be one of the verified figures
const allowedNums = new Set(prep.allowed.numbers);
const money = [...body.matchAll(/(?:₹|Rs\.?\s?|INR\s?)\s?([\d,]+(?:\.\d+)?)/g)].map((x) => Number(x[1].replace(/,/g, '')));
const badMoney = money.filter((n) => !allowedNums.has(n));
if (badMoney.length) return fail('Unverified amount(s) in email: ' + badMoney.join(', '));

// 2) every date must be one of the verified dates
const allowedDates = new Set(prep.allowed.dates);
const dates = body.match(/\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b/g) || [];
const iso = body.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
const badDates = [...dates.filter((d) => !allowedDates.has(d)), ...iso];
if (badDates.length) return fail('Unverified date(s) in email: ' + badDates.join(', '));

// 3) every published book must be mentioned; no processed-payment claims when something is pending
const lower = body.toLowerCase().replace(/[\u2018\u2019]/g, "'");
const missing = prep.allowed.titles.filter((t) => !lower.includes(t.toLowerCase().replace(/[\u2018\u2019]/g, "'")));
if (missing.length) return fail('Email omits book(s): ' + missing.join(', '));
if (prep.facts.payout_message_type !== 'all_paid' && /(has|have) been (processed|paid|sent|transferred)|we (have )?(processed|transferred|paid) your/i.test(body)) return fail('Email claims a payment was processed');

return [{ json: { ok: true, subject, body } }];
"""

(HERE / 'code').mkdir(exist_ok=True)
CODE = {'validate_request': VALIDATE_REQUEST, 'check_log': CHECK_LOG, 'prepare_data': PREPARE, 'validate_ai_output': VALIDATE_AI}
for k, v in CODE.items():
    (HERE / 'code' / f'{k}.js').write_text(v.strip() + '\n')

C = "$('Config').first().json"
WB = "$('Webhook').first().json.body"
nodes, conns = [], {}
def add(name, ntype, params, x, y, ver=1, **extra):
    n = {'parameters': params, 'id': f'n{len(nodes)+1:02d}', 'name': name, 'type': ntype, 'typeVersion': ver, 'position': [x, y]}
    n.update(extra); nodes.append(n); return name
def link(a, b, out=0):
    conns.setdefault(a, {'main': []})
    while len(conns[a]['main']) <= out: conns[a]['main'].append([])
    conns[a]['main'][out].append({'node': b, 'type': 'main', 'index': 0})
def if_true(expr):
    return {'conditions': {'options': {'caseSensitive': True, 'leftValue': '', 'typeValidation': 'loose'},
            'conditions': [{'id': 'c1', 'leftValue': expr, 'rightValue': '', 'operator': {'type': 'boolean', 'operation': 'true', 'singleValue': True}}], 'combinator': 'and'}, 'options': {}}
def respond(code, body_expr):
    return {'respondWith': 'json', 'responseBody': body_expr, 'options': {'responseCode': code}}
def http(method, url, body=None, timeout=30000):
    p = {'method': method, 'url': url, 'sendHeaders': True,
         'headerParameters': {'parameters': [{'name': 'Authorization', 'value': f"=Bearer {{{{ {C}.BUBBLE_API_TOKEN }}}}"}]},
         'options': {'timeout': timeout}}
    if body: p.update({'sendBody': True, 'specifyBody': 'json', 'jsonBody': body})
    return p
def patch_body(fields_js):
    return "={{ (() => { const c = " + C + "; return JSON.stringify({ " + fields_js + " }); })() }}"
LOGURL = f"={{{{ {C}.BUBBLE_API_BASE }}}}/obj/notificationlog/{{{{ {WB}.notification_log_id }}}}"

cfg_vals = [
 ('BUBBLE_API_BASE', 'https://YOUR-APP.bubbleapps.io/version-test/api/1.1'),
 ('BUBBLE_API_TOKEN', 'PASTE_BUBBLE_API_PRIVATE_KEY'),
 ('WEBHOOK_SECRET', 'PASTE_LONG_RANDOM_SECRET_MIN_16_CHARS'),
 ('AI_BASE_URL', 'https://api.groq.com/openai/v1'),
 ('AI_API_KEY', 'PASTE_AI_API_KEY'),
 ('AI_MODEL', 'openai/gpt-oss-120b'),
 ('AI_REASONING_EFFORT', 'low'),
 ('SEND_EMAIL', 'false'),
 ('SMTP_FROM', 'royalties@yourdomain.com'),
 ('OVERDUE_DAYS', '90'), ('MIN_PAYOUT', '1000'), ('REFERENCE_DATE', ''),
 ('F_STATUS', 'status_text'), ('F_SUBJECT', 'generated_subject_text'), ('F_CONTENT', 'generated_content_text'),
 ('F_ERROR', 'error_message_text'), ('F_EXEC', 'n8n_execution_id_text'), ('F_COMPLETED', 'completed_at_date'),
 ('F_EMAIL_STATUS', 'email_delivery_status_text'),
]
add('Webhook', 'n8n-nodes-base.webhook', {'httpMethod': 'POST', 'path': 'bookleaf-royalty-summary', 'responseMode': 'responseNode', 'options': {}}, 0, 300, 2, webhookId='bookleaf-royalty-summary')
add('Config', 'n8n-nodes-base.set', {'assignments': {'assignments': [{'id': f'a{i}', 'name': k, 'value': v, 'type': 'string'} for i, (k, v) in enumerate(cfg_vals)]}, 'includeOtherFields': True, 'options': {}}, 220, 300, 3.4)
add('Validate Request', 'n8n-nodes-base.code', {'jsCode': CODE['validate_request'].strip()}, 440, 300, 2)
add('Authorized?', 'n8n-nodes-base.if', if_true('={{ $json.auth_ok }}'), 660, 300, 2)
add('Respond 401', 'n8n-nodes-base.respondToWebhook', respond(401, '={{ { error: "unauthorized", message: "Invalid or missing x-api-key" } }}'), 880, 120, 1.1)
add('Params valid?', 'n8n-nodes-base.if', if_true('={{ $json.params_ok }}'), 880, 300, 2)
add('Respond 400', 'n8n-nodes-base.respondToWebhook', respond(400, '={{ { error: "missing_parameters", missing: $json.missing } }}'), 1100, 120, 1.1)
add('Not duplicate?', 'n8n-nodes-base.if', if_true('={{ $json.not_duplicate }}'), 1100, 300, 2)
add('Respond 409 Duplicate', 'n8n-nodes-base.respondToWebhook', respond(409, '={{ { status: "duplicate_ignored" } }}'), 1320, 120, 1.1)
add('Respond 202 Accepted', 'n8n-nodes-base.respondToWebhook', respond(202, '={{ { status: "accepted", notification_log_id: ' + WB + '.notification_log_id } }}'), 1320, 300, 1.1)
add('Fetch Notification Log', 'n8n-nodes-base.httpRequest', http('GET', f"={{{{ {C}.BUBBLE_API_BASE }}}}/obj/notificationlog/{{{{ {WB}.notification_log_id }}}}"), 1540, 300, 4.2, retryOnFail=True, maxTries=3, waitBetweenTries=1500, onError='continueErrorOutput')
add('Check Notification Log', 'n8n-nodes-base.code', {'jsCode': CODE['check_log'].strip()}, 1760, 300, 2)
add('Log OK?', 'n8n-nodes-base.if', if_true('={{ $json.proceed }}'), 1980, 300, 2)
add('Stop: duplicate or invalid log', 'n8n-nodes-base.noOp', {}, 2200, 120, 1)
add('Mark Processing', 'n8n-nodes-base.httpRequest', http('PATCH', LOGURL, patch_body("[c.F_STATUS]: 'Processing', [c.F_EXEC]: String($execution.id)")), 2200, 300, 4.2, onError='continueRegularOutput')
add('Fetch Author', 'n8n-nodes-base.httpRequest', http('GET', f"={{{{ {C}.BUBBLE_API_BASE }}}}/obj/author/{{{{ {WB}.author_unique_id }}}}"), 2420, 300, 4.2, retryOnFail=True, maxTries=3, waitBetweenTries=1500, onError='continueErrorOutput')
books_url = "={{ " + C + ".BUBBLE_API_BASE }}/obj/book?constraints={{ encodeURIComponent(JSON.stringify([{ key: 'author_custom_author', constraint_type: 'equals', value: " + WB + ".author_unique_id }])) }}&limit=100"
add('Fetch Books', 'n8n-nodes-base.httpRequest', http('GET', books_url), 2640, 300, 4.2, retryOnFail=True, maxTries=3, waitBetweenTries=1500, onError='continueErrorOutput')
add('Prepare Data', 'n8n-nodes-base.code', {'jsCode': CODE['prepare_data'].strip()}, 2860, 300, 2)
add('Data OK?', 'n8n-nodes-base.if', if_true('={{ $json.ok }}'), 3080, 300, 2)
add('Call AI', 'n8n-nodes-base.httpRequest', {'method': 'POST', 'url': f"={{{{ {C}.AI_BASE_URL }}}}/chat/completions", 'sendHeaders': True,
    'headerParameters': {'parameters': [{'name': 'Authorization', 'value': f"=Bearer {{{{ {C}.AI_API_KEY }}}}"}]},
    'sendBody': True, 'specifyBody': 'json', 'jsonBody': '={{ JSON.stringify($json.ai_request) }}', 'options': {'timeout': 60000}}, 3300, 300, 4.2,
    retryOnFail=True, maxTries=2, waitBetweenTries=3000, onError='continueErrorOutput')
add('Validate AI Output', 'n8n-nodes-base.code', {'jsCode': CODE['validate_ai_output'].strip()}, 3520, 300, 2)
add('Output valid?', 'n8n-nodes-base.if', if_true('={{ $json.ok }}'), 3740, 300, 2)
SUCCESS_FIELDS = "[c.F_STATUS]: 'Success', [c.F_SUBJECT]: $json.subject, [c.F_CONTENT]: $json.body, [c.F_COMPLETED]: new Date().toISOString(), [c.F_EXEC]: String($execution.id), [c.F_EMAIL_STATUS]: c.SEND_EMAIL === 'true' ? 'Pending' : 'Not sent'"
add('Callback: Success', 'n8n-nodes-base.httpRequest', http('PATCH', LOGURL, patch_body(SUCCESS_FIELDS)), 3960, 300, 4.2, retryOnFail=True, maxTries=3, waitBetweenTries=2000, onError='continueRegularOutput')
add('Send email enabled?', 'n8n-nodes-base.if', if_true("={{ " + C + ".SEND_EMAIL === 'true' }}"), 4180, 300, 2)
add('Done (email not sent)', 'n8n-nodes-base.noOp', {}, 4400, 420, 1)
add('Send Email (SMTP)', 'n8n-nodes-base.emailSend', {'fromEmail': "={{ " + C + ".SMTP_FROM }}", 'toEmail': "={{ $('Prepare Data').first().json.author_email }}",
    'subject': "={{ $('Validate AI Output').first().json.subject }}", 'emailFormat': 'text', 'text': "={{ $('Validate AI Output').first().json.body }}", 'options': {}}, 4400, 260, 2.1,
    credentials={'smtp': {'id': 'REPLACE_WITH_YOUR_SMTP_CREDENTIAL', 'name': 'SMTP account'}}, onError='continueErrorOutput')
add('Callback: Email Sent', 'n8n-nodes-base.httpRequest', http('PATCH', LOGURL, patch_body("[c.F_EMAIL_STATUS]: 'Sent'")), 4620, 200, 4.2, onError='continueRegularOutput')
add('Callback: Email Failed', 'n8n-nodes-base.httpRequest', http('PATCH', LOGURL, patch_body("[c.F_EMAIL_STATUS]: 'Failed', [c.F_ERROR]: 'Summary saved, but email delivery failed'")), 4620, 340, 4.2, onError='continueRegularOutput')

def fail_set(name, expr, y):
    add(name, 'n8n-nodes-base.set', {'assignments': {'assignments': [{'id': 'e1', 'name': 'error_message', 'value': expr, 'type': 'string'}]}, 'options': {}}, 3300, y, 3.4)
fail_set('Fail: Bubble unreachable', "={{ 'Bubble Data API error: ' + ($json.error && $json.error.message ? $json.error.message : JSON.stringify($json.error || 'request failed')) }}", 560)
fail_set('Fail: Data invalid', "={{ $json.error }}", 680)
fail_set('Fail: AI unavailable', "={{ 'AI API failure: ' + ($json.error && $json.error.message ? $json.error.message : JSON.stringify($json.error || 'request failed')) }}", 800)
fail_set('Fail: AI output rejected', "={{ 'AI output rejected: ' + $json.error }}", 920)
FAIL_FIELDS = "[c.F_STATUS]: 'Failed', [c.F_ERROR]: String($json.error_message).slice(0, 500), [c.F_COMPLETED]: new Date().toISOString(), [c.F_EXEC]: String($execution.id)"
add('Callback: Failed', 'n8n-nodes-base.httpRequest', http('PATCH', LOGURL, patch_body(FAIL_FIELDS)), 3740, 740, 4.2, retryOnFail=True, maxTries=3, waitBetweenTries=2000, onError='continueRegularOutput')

link('Webhook', 'Config'); link('Config', 'Validate Request'); link('Validate Request', 'Authorized?')
link('Authorized?', 'Params valid?', 0); link('Authorized?', 'Respond 401', 1)
link('Params valid?', 'Not duplicate?', 0); link('Params valid?', 'Respond 400', 1)
link('Not duplicate?', 'Respond 202 Accepted', 0); link('Not duplicate?', 'Respond 409 Duplicate', 1)
link('Respond 202 Accepted', 'Fetch Notification Log')
link('Fetch Notification Log', 'Check Notification Log', 0); link('Fetch Notification Log', 'Fail: Bubble unreachable', 1)
link('Check Notification Log', 'Log OK?')
link('Log OK?', 'Mark Processing', 0); link('Log OK?', 'Stop: duplicate or invalid log', 1)
link('Mark Processing', 'Fetch Author')
link('Fetch Author', 'Fetch Books', 0); link('Fetch Author', 'Fail: Bubble unreachable', 1)
link('Fetch Books', 'Prepare Data', 0); link('Fetch Books', 'Fail: Bubble unreachable', 1)
link('Prepare Data', 'Data OK?')
link('Data OK?', 'Call AI', 0); link('Data OK?', 'Fail: Data invalid', 1)
link('Call AI', 'Validate AI Output', 0); link('Call AI', 'Fail: AI unavailable', 1)
link('Validate AI Output', 'Output valid?')
link('Output valid?', 'Callback: Success', 0); link('Output valid?', 'Fail: AI output rejected', 1)
link('Callback: Success', 'Send email enabled?')
link('Send email enabled?', 'Send Email (SMTP)', 0); link('Send email enabled?', 'Done (email not sent)', 1)
link('Send Email (SMTP)', 'Callback: Email Sent', 0); link('Send Email (SMTP)', 'Callback: Email Failed', 1)
for f in ['Fail: Bubble unreachable', 'Fail: Data invalid', 'Fail: AI unavailable', 'Fail: AI output rejected']:
    link(f, 'Callback: Failed')

wf = {'name': 'BookLeaf - Royalty Summary (Bubble -> n8n -> AI -> Bubble)', 'nodes': nodes, 'connections': conns,
      'settings': {'executionOrder': 'v1', 'saveDataErrorExecution': 'all', 'saveDataSuccessExecution': 'all'}, 'active': False}
(HERE / 'bookleaf-royalty-workflow.json').write_text(json.dumps(wf, indent=2, ensure_ascii=False))
print(len(nodes), 'nodes')
