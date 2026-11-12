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
