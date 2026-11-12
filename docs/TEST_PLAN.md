# Test plan (sample dataset)

Run the automated n8n-logic tests first: `node tests/run-code-nodes.js` (92 checks, all 10 authors' totals verified against the JSON, tampered AI output rejected).
Then test in the live apps. Dates assume today = 3 Nov 2026 (all pending books are RED because 2025 payouts are > 90 days old).

| # | Case | Account / data | Expected |
|---|---|---|---|
| 1 | Multiple books | Rohit Kapoor (BK003, BK004) | 2 books; earned ₹84,024, paid ₹71,000, pending ₹13,024 |
| 2 | Fully paid | Farhan Sheikh (BK014) | GREEN; email: all paid, thanks, nothing pending; "Generate" not in bulk |
| 3 | Pending | Vikram Joshi | BK006 RED, BK007 GREEN; pending ₹3,350 |
| 4 | No previous payout | Ananya Reddy (BK005) | RED (published > 90 days, never paid); email says no payout made yet |
| 5 | Overdue | Priya Sharma BK001 | RED (last payout 15 Oct 2025) |
| 6 | Book in production | Kavita (BK015) | in-production list, no royalty numbers, excluded from totals; pending only ₹850 (BK016) |
| 7 | Mixed published + production | Sneha Kulkarni | 2 published + BK013 "In Production - Cover Design"; email has status line |
| 8 | Admin sees all | admin@bookleaf.com | 10 authors / 18 books |
| 9 | Isolation | Log in as Ananya, open another author's URL/search | nothing returned (privacy rules) |
| 10 | Single summary | Admin > author detail > Generate | log Pending > Processing > Success; email visible |
| 11 | Bulk | Admin > Bulk | one log per eligible author (9 of 10: all but Farhan); independent statuses |
| 12 | Duplicate click | click twice fast | second blocked by Bubble guard; if it reaches n8n: HTTP 409 duplicate_ignored |
| 13 | AI failure | set a wrong AI_API_KEY in Config | log Failed with "AI API failure ..."; no email |
| 14 | Bubble failure | wrong BUBBLE_API_TOKEN | webhook 202, then Fetch fails; Failed callback attempted (may itself fail, logged in n8n); Bubble shows "Timed out: retry" after 2 min |
| 15 | Callback failure | wrong URL on Callback node | execution shows failed callback; Bubble watchdog shows timeout; retry creates a new log with a new key |
| 16 | Unauthorized | `curl` without `x-api-key` | 401 |

```bash
# unauthorized (expect 401)
curl -i -X POST https://<n8n>/webhook/bookleaf-royalty-summary -H 'Content-Type: application/json' -d '{"author_id":"AUTH001"}'
# valid (expect 202)
curl -i -X POST https://<n8n>/webhook/bookleaf-royalty-summary -H 'Content-Type: application/json' -H 'x-api-key: <secret>' \
  -d '{"author_id":"AUTH003","author_unique_id":"<bubble _id>","notification_log_id":"<log _id>","idempotency_key":"AUTH003-test1"}'
```
