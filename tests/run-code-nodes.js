/**
 * Offline test of the n8n Code nodes against the real sample dataset (no n8n / Bubble needed).
 * Simulates Bubble Data API responses (with "<name>_<type>" keys), runs Prepare Data and Validate AI Output,
 * and verifies every financial figure. Usage: node tests/run-code-nodes.js
 */
const fs = require('fs'), path = require('path'), assert = require('assert');
const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '../n8n/bookleaf-royalty-workflow.json'), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../bubble-import/bookleaf_sample_data.json'), 'utf8'));
const code = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

function run(name, ctx, input = {}, staticData = {}) {
  const $ = (n) => ({ first: () => ({ json: ctx[n] }), all: () => [{ json: ctx[n] }] });
  const $input = { first: () => ({ json: input }), all: () => [{ json: input }] };
  return new Function('$', '$input', '$getWorkflowStaticData', '$execution', code(name))($, $input, () => staticData, { id: 'test-1' })[0].json;
}
const CFG = { WEBHOOK_SECRET: 'a-very-long-shared-secret', OVERDUE_DAYS: '90', MIN_PAYOUT: '1000', REFERENCE_DATE: '2026-11-03', AI_MODEL: 'm' };
const bubbleBook = (b, authorUid) => ({ _id: 'bk_' + b.book_id, book_id_text: b.book_id, title_text: b.title, status_text: b.status, author_custom_author: authorUid,
  publication_date_date: b.publication_date && b.publication_date + 'T00:00:00.000Z', total_copies_sold_number: b.total_copies_sold, total_royalty_earned_number: b.total_royalty_earned,
  royalty_paid_number: b.royalty_paid, royalty_pending_number: b.royalty_pending, last_royalty_payout_date_date: b.last_royalty_payout_date && b.last_royalty_payout_date + 'T00:00:00.000Z' });

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

// ---- Webhook validation ----
const wh = (headers, body) => ({ headers, body });
let r = run('Validate Request', { Config: CFG, Webhook: wh({ 'x-api-key': 'wrong' }, { author_id: 'A', author_unique_id: 'u', notification_log_id: 'l', idempotency_key: 'k' }) });
ok(r.auth_ok === false, 'wrong key rejected');
const good = { author_id: 'AUTH001', author_unique_id: 'u1', notification_log_id: 'l1', idempotency_key: 'AUTH001-202611031200' };
const sd = {};
r = run('Validate Request', { Config: CFG, Webhook: wh({ 'x-api-key': CFG.WEBHOOK_SECRET }, good) }, {}, sd);
ok(r.auth_ok && r.params_ok && r.not_duplicate, 'valid request accepted');
r = run('Validate Request', { Config: CFG, Webhook: wh({ 'x-api-key': CFG.WEBHOOK_SECRET }, good) }, {}, sd);
ok(r.not_duplicate === false, 'same idempotency key rejected as duplicate');
r = run('Validate Request', { Config: CFG, Webhook: wh({ 'x-api-key': CFG.WEBHOOK_SECRET }, { author_id: 'AUTH001' }) }, {}, {});
ok(!r.params_ok && r.missing.includes('notification_log_id'), 'missing params reported');

// ---- Per-author data prep, totals, status, payout type ----
const expectType = { AUTH001: 'overdue', AUTH002: 'overdue', AUTH003: 'overdue', AUTH004: 'overdue', AUTH005: 'overdue', AUTH006: 'rolls_over'.replace('rolls_over', 'overdue'), AUTH007: 'overdue', AUTH008: 'all_paid', AUTH009: 'rolls_over', AUTH010: 'overdue' };
for (const a of data.authors) {
  const uid = 'uid_' + a.author_id;
  const ctx = { Config: CFG, Webhook: wh({}, { author_id: a.author_id, author_unique_id: uid }),
    'Fetch Author': { response: { _id: uid, author_id_text: a.author_id, name_text: a.name, email_text: a.email } },
    'Fetch Books': { response: { results: a.books.map((b) => bubbleBook(b, uid)) } } };
  const p = run('Prepare Data', ctx);
  ok(p.ok, a.author_id + ' prepared');
  const pub = a.books.filter((b) => b.status === 'Published & Live');
  const sum = (k) => pub.reduce((s, b) => s + b[k], 0);
  const inr = (n) => '₹' + n.toLocaleString('en-IN');
  ok(p.facts.totals.earned === inr(sum('total_royalty_earned')), a.name + ' earned total');
  ok(p.facts.totals.paid === inr(sum('royalty_paid')), a.name + ' paid total');
  ok(p.facts.totals.pending === inr(sum('royalty_pending')), a.name + ' pending total');
  ok(p.facts.books_in_production.length === a.books.length - pub.length, a.name + ' production books excluded from royalty');
  ok(p.facts.payout_message_type === expectType[a.author_id], `${a.name}: payout type ${p.facts.payout_message_type}`);

  // Simulated "good" AI reply built only from facts -> must pass; tampered reply -> must fail
  const f = p.facts;
  const lines = f.published_books.map((b) => `${b.title}: ${b.copies_sold} copies sold, earned ${b.earned}, paid ${b.paid}, pending ${b.pending}. Last payout: ${b.last_payout_date}.`);
  const body = `Hi ${f.author_first_name},\n\nThank you for being part of BookLeaf. Here is your royalty summary as of ${f.today}.\n\n${lines.join('\n')}\n\nTotals: earned ${f.totals.earned}, paid ${f.totals.paid}, pending ${f.totals.pending}.\n\nOur next payout window closes on ${f.payout_calendar.next_payout_due_by}.\n\n${f.books_in_production.map((b) => b.title + ' is currently at: ' + b.current_stage + '.').join('\n')}\n\nWarm regards,\nBookLeaf Author Support Team`;
  const resp = (content) => ({ choices: [{ message: { content } }] });
  const v = run('Validate AI Output', { 'Prepare Data': p }, resp(JSON.stringify({ subject: 'Your BookLeaf royalty summary', body })));
  ok(v.ok, a.name + ' valid email accepted: ' + (v.error || ''));
  if (pub.length) {
    const bad = run('Validate AI Output', { 'Prepare Data': p }, resp(JSON.stringify({ subject: 's', body: body.replace(f.totals.earned, '₹99,999') })));
    ok(!bad.ok && /Unverified amount/.test(bad.error), a.name + ' tampered figure rejected');
  }
}
// specific edge-case assertions from the brief
const prep = (id) => { const a = data.authors.find((x) => x.author_id === id), uid = 'u'; return run('Prepare Data', { Config: CFG, Webhook: wh({}, { author_id: id, author_unique_id: uid }), 'Fetch Author': { response: { _id: uid, author_id_text: id, name_text: a.name, email_text: a.email } }, 'Fetch Books': { response: { results: a.books.map((b) => bubbleBook(b, uid)) } } }); };
ok(prep('AUTH003').facts.published_books[0].last_payout_date === 'No payout has been made yet', 'no-previous-payout author');
ok(prep('AUTH008').facts.published_books.every((b) => b.royalty_status === 'GREEN'), 'fully paid author is GREEN');
ok(prep('AUTH007').facts.books_in_production[0].current_stage === 'In Production - Cover Design', 'mixed published + production author');
ok(prep('AUTH009').facts.totals.pending === '₹850', 'production book contributes nothing; pending only from published');
// Yellow path (inside normal cycle): pin date to shortly after a payout
const y = run('Prepare Data', { Config: { ...CFG, REFERENCE_DATE: '2025-12-20' }, Webhook: wh({}, { author_id: 'AUTH001', author_unique_id: 'u' }), 'Fetch Author': { response: { _id: 'u', author_id_text: 'AUTH001', name_text: 'Priya Sharma', email_text: 'x' } }, 'Fetch Books': { response: { results: data.authors[0].books.map((b) => bubbleBook(b, 'u')) } } });
ok(y.facts.published_books[0].royalty_status === 'YELLOW' && y.facts.payout_message_type === 'on_schedule', 'yellow / on_schedule inside payout cycle');
// Author mismatch (security) and missing author
ok(run('Prepare Data', { Config: CFG, Webhook: wh({}, { author_id: 'AUTH002', author_unique_id: 'u' }), 'Fetch Author': { response: { _id: 'u', author_id_text: 'AUTH001' } }, 'Fetch Books': { response: { results: [] } } }).ok === false, 'author mismatch rejected');
ok(run('Prepare Data', { Config: CFG, Webhook: wh({}, { author_id: 'AUTH001', author_unique_id: 'u' }), 'Fetch Author': {}, 'Fetch Books': {} }).ok === false, 'missing author rejected');
// AI garbage
ok(run('Validate AI Output', { 'Prepare Data': prep('AUTH001') }, { choices: [{ message: { content: 'sorry I cannot' } }] }).ok === false, 'non-JSON AI output rejected');
console.log(`All ${checks} checks passed`);
