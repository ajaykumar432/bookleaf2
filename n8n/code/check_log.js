// Bubble Data API returns fields as "<name>_<type>" (e.g. royalty_pending_number). Strip the type suffix.
const norm = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) =>
  [k.replace(/_(list_text|list_number|list_date|text|number|date|boolean|custom_[a-z0-9_]+|option_[a-z0-9_]+|user)$/, ''), v]));

// Node 5: confirm the NotificationLog row exists, matches the idempotency key, and is not already done.
const body = $('Webhook').first().json.body;
const raw = $input.first().json.response || {};
const log = norm(raw);
let proceed = true, reason = '';
if (!raw._id) { proceed = false; reason = 'Notification log not found'; }
else if (log.idempotency_key !== body.idempotency_key) { proceed = false; reason = 'Idempotency key mismatch'; }
else if (log.status === 'Success') { proceed = false; reason = 'Already completed - duplicate ignored'; }
return [{ json: { proceed, reason } }];
