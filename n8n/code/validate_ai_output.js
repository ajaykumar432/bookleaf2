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
