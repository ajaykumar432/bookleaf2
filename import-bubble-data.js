const fs = require('node:fs');
const path = require('node:path');

const BASE = (process.env.BUBBLE_API_BASE || 'https://ag153597.bubbleapps.io/version-test/api/1.1/obj').replace(/\/+$/, '');
const TOKEN = process.env.BUBBLE_ADMIN_TOKEN;
const APPLY = process.argv.includes('--apply');

if (!TOKEN) {
  console.error('Set BUBBLE_ADMIN_TOKEN in this PowerShell session first. Do not paste it into chat.');
  process.exit(1);
}

function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(value); value = ''; }
    else if (ch === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += ch;
  }
  if (value.length || row.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  const [headers, ...records] = rows;
  return records.filter(r => r.some(v => v !== '')).map(r =>
    Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

async function request(endpoint, options = {}) {
  const response = await fetch(BASE + '/' + endpoint, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error((options.method || 'GET') + ' ' + endpoint + ' failed (' + response.status + '): ' + body);
  return body;
}

async function list(type) {
  const body = await request(type + '?limit=100');
  const parsed = JSON.parse(body);
  return parsed.response?.results || parsed.results || [];
}

async function bulk(type, records) {
  if (!records.length) return;
  const body = records.map(r => JSON.stringify(r)).join('\n');
  const response = await request(type + '/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body,
  });
  const results = response.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const failed = results.filter(r => r.status !== 'success');
  if (failed.length) throw new Error(failed.length + ' ' + type + ' records failed: ' + JSON.stringify(failed));
  console.log('Created ' + results.length + ' ' + type + ' records.');
}

function dateValue(s) {
  return s ? s + 'T00:00:00.000Z' : '';
}
function numberValue(s) {
  return s === '' ? undefined : Number(s);
}

async function main() {
  const authorCsv = parseCsv(fs.readFileSync(path.join(__dirname, 'bubble-import', 'authors.csv'), 'utf8'));
  const bookCsv = parseCsv(fs.readFileSync(path.join(__dirname, 'bubble-import', 'books.csv'), 'utf8'));

  let authors = await list('author');
  let authorIds = new Map(authors.map(a => [a.author_id_text || a.author_id, a._id]));
  const newAuthors = authorCsv.filter(a => !authorIds.has(a.author_id)).map(a => ({
    author_id_text: a.author_id,
    name_text: a.name,
    email_text: a.email,
    phone_text: a.phone,
    city_text: a.city,
    joined_date_date: dateValue(a.joined_date),
  }));

  const existingBooks = await list('book');
  const knownBookIds = new Set(existingBooks.map(b => b.book_id_text || b.book_id));
  const newBookRows = bookCsv.filter(b => !knownBookIds.has(b.book_id));

  console.log('Bubble base: ' + BASE);
  console.log('Authors: ' + authorCsv.length + ' in CSV, ' + newAuthors.length + ' to create.');
  console.log('Books: ' + bookCsv.length + ' in CSV, ' + newBookRows.length + ' to create.');
  if (!APPLY) {
    console.log('Preview only; Bubble data was not changed. Review counts, then run again with --apply.');
    return;
  }

  await bulk('author', newAuthors);
  authors = await list('author');
  authorIds = new Map(authors.map(a => [a.author_id_text || a.author_id, a._id]));

  const numeric = ['mrp', 'author_royalty_per_copy', 'total_copies_sold', 'total_royalty_earned', 'royalty_paid', 'royalty_pending'];
  const newBooks = newBookRows.map(b => {
    const authorUid = authorIds.get(b.author_ref_id);
    if (!authorUid) throw new Error('No Bubble Author record found for ' + b.book_id + ' -> ' + b.author_ref_id);
    const item = {
      book_id_text: b.book_id,
      author_ref_id_text: b.author_ref_id,
      author_custom_author: authorUid,
      title_text: b.title,
      isbn_text: b.isbn,
      genre_text: b.genre,
      status_text: b.status,
      print_partner_text: b.print_partner,
      available_on_list_text: b.available_on ? b.available_on.split(',').map(x => x.trim()) : [],
    };
    if (b.publication_date) item.publication_date_date = dateValue(b.publication_date);
    if (b.last_royalty_payout_date) item.last_royalty_payout_date_date = dateValue(b.last_royalty_payout_date);
    for (const key of numeric) {
      const n = numberValue(b[key]);
      if (n !== undefined) item[key + '_number'] = n;
    }
    return item;
  });
  await bulk('book', newBooks);
  console.log('Import finished. Check All Authors and All Books in Bubble App data.');
}

main().catch(err => {
  console.error(err.message || err);
  process.exitCode = 1;
});

