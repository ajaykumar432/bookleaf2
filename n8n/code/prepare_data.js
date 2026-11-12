// Bubble Data API returns fields as "<name>_<type>" (e.g. royalty_pending_number). Strip the type suffix.
const norm = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) =>
  [k.replace(/_(list_text|list_number|list_date|text|number|date|boolean|custom_[a-z0-9_]+|option_[a-z0-9_]+|user)$/, ''), v]));

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
