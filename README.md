# BookLeaf Author Royalty Dashboard & Notification System (Bubble.io + n8n + AI)

**Status, honestly:** the n8n workflow, AI prompt, validation logic, import data, tests and documentation are done and the Code nodes are tested offline against the sample dataset. The **Bubble app must be built in the Bubble editor** (it cannot be exported as code); `docs/BUBBLE_BUILD_GUIDE.md` is the exact recipe. The n8n JSON has not yet been run inside a live n8n instance, so import it, fill the *Config* node, and run the tests in `docs/TEST_PLAN.md`.

## Contents
- `n8n/bookleaf-royalty-workflow.json` importable workflow (33 nodes); `n8n/code/*.js` readable copies of its Code nodes; `n8n/build_workflow.py` generator
- `bubble-import/authors.csv`, `books.csv`, `bookleaf_sample_data.json`
- `docs/BUBBLE_BUILD_GUIDE.md`, `docs/TEST_PLAN.md`, `tests/run-code-nodes.js`

## Architecture
```
Bubble (admin clicks) -> create NotificationLog(Pending) -> POST webhook (x-api-key, ids only)
   n8n: auth > validate > dedupe > 202 Accepted (Bubble is never left waiting)
        > Data API: log, author, books > compute figures in code > AI writes email > validate output
        > PATCH NotificationLog (Success + subject + email) > optional SMTP > PATCH email status
   any failure > PATCH NotificationLog (Failed + reason)
Bubble: log row updates live; watchdog marks stuck rows "Timed out: retry".
```
**Why n8n pulls data from the Bubble Data API instead of Bubble sending a full payload:** Bubble sends only 4 ids, so the webhook body stays tiny and tamper-proof; n8n always reads fresh, verified figures from the source of truth, and a forged request cannot inject numbers into an email. Cost: extra API calls.
**Why PATCH via the Data API for callbacks:** works without Bubble backend workflows (reported to need a paid plan); one token and one mechanism for read and write. If you have backend workflows, swap the PATCH nodes for a `/wf/` endpoint.

## Database schema
Author 1-to-many Book (`Book.author`), User (role, linked_author), NotificationLog (see guide). Royalty figures stay on Book exactly as in the dataset; no fabricated payout history (the dataset has only the latest payout date). Totals exclude books not "Published & Live".

## Royalty status (computed from today's date, never stored)
GREEN pending = 0. RED pending > 0 and (last payout > 90 days ago, or published > 90 days with no payout ever). YELLOW otherwise. KB nuance: if an author's total pending is below the KB's Rs 1,000 minimum, the email explains it *rolls over* (e.g. Kavita, Rs 850) even though the badge may be RED under the assignment's 90-day rule.

## AI prompt strategy
- **The model never does maths.** n8n computes totals, statuses, ₹-Indian formatting, and the payout calendar (calendar quarters, +45 days, from the Assignment 1 KB; "calendar quarters" is an assumption). The model receives a JSON of finished facts and a `payout_message_type` (`all_paid | on_schedule | rolls_over | overdue`) that selects the paragraph to write.
- System prompt encodes the KB tone: acknowledge first, own BookLeaf delays, specific numbers, a clear next step, 48-hour timeline for escalation, never blame the author, never claim a payout was processed unless the data says so, no invented dates.
- Output is JSON `{subject, body}`; default model `openai/gpt-oss-120b` on Groq (free tier, no card); swap to OpenAI `gpt-4o-mini` by changing `AI_BASE_URL`, `AI_MODEL`, key, and clearing `AI_REASONING_EFFORT`.
- **Output validation (Validate AI Output node):** parseable JSON; non-empty; every ₹ amount must be a known figure; every date must be one of the supplied dates; every published title mentioned; no "payment processed" claims unless all paid. Failures mark the log **Failed** with the reason; nothing is sent.

## Security
Webhook requires the `x-api-key` header (constant-time compare, min 16 chars); wrong/missing key gets 401 before any work. Secrets live only in the n8n *Config* node (move them to n8n credentials/env for production) and in Bubble's private API Connector header; never in page elements. Author/admin separation is enforced by Bubble privacy rules, not by hidden UI. The n8n token is an admin key; keep it out of the browser.

## Error handling and idempotency
| Failure | Behaviour |
|---|---|
| Bad/missing API key | 401, no work |
| Missing params | 400 with the list of missing fields |
| Duplicate request | Bubble guard (no new send if one is Pending/Processing in the last 5 min); n8n 409 for a repeated key within 10 min; Success logs are never reprocessed |
| Bubble API down / author not found | 3 retries, then log Failed with message |
| AI down/timeout/invalid output | 2 tries, then Failed (output rejected by validation is Failed too) |
| Callback fails | 3 retries; if it still fails the row stays Processing and Bubble's watchdog shows "Timed out: retry" |
| Email (SMTP) fails | summary stays **Success**; `email_delivery_status` = Failed (generation and delivery are tracked separately) |
Retries cannot send duplicate emails: the email step only runs after one successful pass, and a retried admin action creates a new key.

## Setup
1. Build Bubble per `docs/BUBBLE_BUILD_GUIDE.md`. 2. In n8n: Import from file > fill *Config* (Bubble base URL incl. `/api/1.1`, Bubble private key, webhook secret, AI key/model) > for email set `SEND_EMAIL=true`, add an SMTP credential > **Activate** the workflow and use the *Production* webhook URL (not the test URL). 3. Run `node tests/run-code-nodes.js`, then the test plan.

## Known limitations / challenges
Not yet executed in live n8n/Bubble; Bubble field keys must be confirmed in the Data API swagger (see guide); `:filtered`-based admin filters suit tens of authors, not thousands; static-data dedupe only works on an active workflow; Bubble's free plan may restrict backend workflows, so bulk sending uses a front-end queue. Learning notes (what was new about Bubble, what I tried and how it was resolved) should be added here as you build, since the assignment grades that.
