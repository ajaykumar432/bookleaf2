# Bubble build guide (do these in the Bubble editor, in order)

Bubble apps cannot be exported as code, so this is the exact build recipe. Everything the n8n side needs is already built (`n8n/bookleaf-royalty-workflow.json`).
Field names below are chosen so that Bubble's Data API keys match what the workflow expects (`<field>_text`, `_number`, `_date`).

## Phase 1: Database (Data tab)

**Option Sets:** `Role` = Admin, Author.

| Data type | Fields (name : type) |
|---|---|
| **Author** | author_id : text, name : text, email : text, phone : text, city : text, joined_date : date |
| **Book** | book_id : text, author : Author, title : text, isbn : text, genre : text, publication_date : date, status : text, mrp : number, author_royalty_per_copy : number, total_copies_sold : number, total_royalty_earned : number, royalty_paid : number, royalty_pending : number, last_royalty_payout_date : date, print_partner : text, available_on : list of texts, author_ref_id : text (import helper) |
| **User** (built-in) | add: role : Role, linked_author : Author, is_active : yes/no (default yes) |
| **NotificationLog** | author : Author, recipient_email : text, status : text (Pending / Processing / Success / Failed), generated_subject : text, generated_content : text, error_message : text, idempotency_key : text, n8n_execution_id : text, completed_at : date, email_delivery_status : text |

Why this shape: Author 1-to-many Book (a reference on Book, so no duplicated author data and no list-sync problems); royalty figures live on Book because the dataset gives them per book; NotificationLog is its own type so every send is auditable and is the single source of truth for status. No `Payout` type: the dataset only holds the *latest* payout date per book, and inventing history would fabricate data.
`status` is text (not an option set) on purpose: the Data API returns it as plain text for n8n.

**Import:** Data > App data > *Upload* > choose `bubble-import/authors.csv` (type Author), then `bubble-import/books.csv` (type Book). Map columns by name. `available_on` is a comma-separated cell: map it to the list-of-texts field. Blank cells stay empty (production books keep empty mrp/publication date).
**Link books to authors (one-off):** create a page `admin-setup` with a button and workflow: *Make changes to a list of Books* (`Search for Books`) > `author = Search for Authors (author_id = ???):first item`. For the `???` value use the current list item's `author_ref_id` (in "Make changes to a list of things" Bubble exposes the item being edited as "This Book"). Run it once, then delete the page/button. If your editor won't allow that expression, do a one-time 18-row manual link in Data > App data > Book instead.
**Verify:** 10 authors, 18 books; Books with empty publication_date = 2 (BK013, BK015).

**Data API setup:** Settings > API: tick *Enable Data API*, generate the *Private key* (the n8n bearer token). In Data > Data types tick **Author, Book, NotificationLog** under "This data type is exposed as a Data API endpoint" (Data API tab) and allow *Modify via API* for NotificationLog. In the Bubble Data API swagger (`.../api/1.1/meta/swagger.json`) confirm the exact field keys (e.g. `royalty_pending_number`, and the Book->Author reference key). If the Book->author key differs from `author_custom_author`, change it in n8n node *Fetch Books*; if NotificationLog keys differ, edit the `F_*` values in the n8n *Config* node.

## Phase 2: Auth and Privacy Rules

1. Page `login`: Email + Password inputs, button *Log in* > action **Log the user in**; then Go to page: `Current User's role is Admin` ? `admin_dashboard` : `author_dashboard`.
2. Create users: temporarily add a *Sign up* button (or sign up from the login page), create **admin@bookleaf.com** and at least two authors (e.g. ananya.reddy@email.com, rohit.kapoor@email.com). Then Data > App data > User: set `role` and `linked_author` for each (admin has no linked author). Remove the sign-up button afterwards.
3. Page-load guards: every author page `When page is loaded` > if `Current User is not logged in` or `role is not Author` > Go to `login`. Admin pages: same with `role is not Admin`.
4. **Privacy rules (Data > Privacy)**, the real security layer:
   - **Author**: rule *"Admin or owner"*: `Current User's role is Admin or This Author is Current User's linked_author` > check *Find this in searches* + *View all fields*. Default rule: nothing checked.
   - **Book**: `Current User's role is Admin or This Book's author is Current User's linked_author` > find in searches + view all fields.
   - **NotificationLog**: `Current User's role is Admin` > all permissions. Default: nothing.
   - **User**: `This User is Current User or Current User's role is Admin` > view all fields.
   - The n8n private key bypasses privacy rules (it is an admin token); never put it in a page or the API Connector's public fields.
5. Test: log in as Ananya, open the Book list: only BK005. Try to guess another author's page id in the URL: empty. Admin sees all 18.

## Phase 3: Author portal (pages `author_dashboard`, `my_books`, `royalty`)

Shared sidebar (reusable element) with links. Navy `#12343b` / teal `#2a7a58`; green `#2e9e5b`, yellow `#e0a800`, red `#c0392b`.
Let `MyBooks` = `Search for Books (author = Current User's linked_author)`. `Pub` = same with `status = Published & Live`.
- **Dashboard cards:** Total Books `MyBooks:count`; Published `Pub:count`; In production `MyBooks:count - Pub:count`; Copies sold `Pub:each item's total_copies_sold:sum`; Earned / Paid / Pending the same with the respective field (`:sum`, format `$0,0` with "Rs " prefix; use Bubble's number format `0,0`).
- **My Books** repeating group of `MyBooks` + a search input (`title contains Input's value`). Cell: title, isbn, genre, `publication_date` (conditional: empty > "Not yet published"), status, mrp (empty > "n/a"), print_partner, `available_on:join with ", "`, status badge.
- **Royalty page:** repeating group of `Pub` showing copies sold, earned, paid, pending, last payout (empty > "No payout yet"), badge; above it the consolidated cards. Production books appear in a separate "In production" list with a status line, no royalty numbers.
- **Royalty status badge** (a Shape/Group with 3 conditionals, **no hard-coded status**, recalculated from today's date):
  - Green: `Current cell's Book's royalty_pending is 0`
  - Red: `royalty_pending > 0` **and** ( (`last_royalty_payout_date is not empty` **and** `last_royalty_payout_date < Current date/time minus (days) 90`) **or** (`last_royalty_payout_date is empty` **and** `status is "Published & Live"` **and** `publication_date < Current date/time minus (days) 90`) )
  - Yellow: `royalty_pending > 0` and not Red.
  Put the same logic in a custom **Reusable element "RoyaltyBadge"** (parameter: Book) and use it on author and admin pages.
  *Demo note:* the sample data's payouts are from 2025, so today every pending book is Red. To demonstrate Yellow, add one Book (or edit a date) with a recent last payout; the n8n workflow supports `REFERENCE_DATE` for the same purpose.

## Phase 4: Admin portal

- **admin_dashboard:** stat cards (`Search for Authors:count`, Books, Published, In production, total earned/paid/pending across all Books, **Authors with overdue payments**).
  - Overdue books = `Search for Books (royalty_pending > 0, last_royalty_payout_date < Current date/time minus (days) 90)` **:merged with** `Search for Books (royalty_pending > 0, last_royalty_payout_date is empty, status = Published & Live, publication_date < Current date/time minus (days) 90)`. Authors with overdue = `that list:each item's author:unique elements:count`.
- **Authors table** (repeating group). Data source: `Search for Authors (name contains SearchInput; city = CityDropdown, ignore empty constraints)`, then `:filtered` by payout status dropdown:
  - Fully paid: `Search for Books (author = This Author, royalty_pending > 0):count is 0`
  - Overdue: `Overdue books:filtered(author is This Author):count > 0`
  - Pending: pending count > 0 and not overdue.
  Columns: name, email, city, total books, total earned (`Search for Books(author=This Author):each item's total_royalty_earned:sum`), total pending, status badge, *View details* (Go to `author_detail`, data = Current cell's Author). Add sorting (a dropdown driving "Sort by") and *Items per page*/pagination buttons. Fine for this dataset; for thousands of authors, denormalize totals onto Author and refresh them with a scheduled backend workflow.
- **author_detail** (type of content: Author): author info, the same book list + royalty cards + badges, "Latest known payout" (max `last_royalty_payout_date`), plus the **Generate & Send Royalty Summary** button and the notification history for this author.
- **notification_log:** repeating group `Search for NotificationLogs` sorted by Created Date descending: author name, recipient email, created date (triggered), completed_at, status badge, email_delivery_status, n8n_execution_id, and a *View email* popup showing generated_subject/content/error_message. Add a conditional: `status is Processing/Pending and Created Date < Current date/time minus (minutes) 2` > show **"Timed out: retry"** (this is the front-end watchdog so the admin never waits forever).

## Phase 5: Bubble <-> n8n integration

**API Connector** (Plugins > API Connector > Add another API) named `n8n`:
- Authentication: None (we use a header). Shared header: `x-api-key` = your secret, **tick Private**.
- Call `TriggerRoyaltySummary`: *Use as* **Action**, `POST https://<your-n8n>/webhook/bookleaf-royalty-summary` (use the *Production* URL), Body type JSON:
```json
{ "author_id": "<author_id>", "author_unique_id": "<author_unique_id>", "notification_log_id": "<notification_log_id>", "idempotency_key": "<idempotency_key>" }
```
Leave the four values as dynamic parameters (not private). Click *Initialize call* with real values. Tick *"Include errors in response and allow workflow actions to continue"* so a 401/409/5xx doesn't throw a generic error.

**Button workflow "Generate & Send Royalty Summary"** (author_detail):
1. *Only when* `Search for NotificationLogs (author = Current Page Author, status is Pending or Processing, Created Date > Current date/time minus (minutes) 5):count is 0` (otherwise show alert "A summary is already being generated for this author").
2. Create a new NotificationLog: author = Current page Author, recipient_email = author's email, status = `Pending`, idempotency_key = `Current page Author's author_id & "-" & Current date/time:formatted as YYYYMMDDHHmm`.
3. Plugins > `n8n - TriggerRoyaltySummary`: author_id = Author's author_id; author_unique_id = Author's unique id; notification_log_id = Result of step 2's unique id; idempotency_key = Result of step 2's idempotency_key.
4. If the call returned an error (use the API call's error/status fields from "Result of step 3" in your editor): *Make changes to Result of step 2* > status = `Failed`, error_message = the error text, completed_at = Current date/time; show alert "Could not reach the automation service".
5. Otherwise show "Summary requested" and refresh. The log row's status turns Processing > Success/Failed when n8n PATCHes it. Make the notification list/log popup **auto-refresh** by a `Do every 5 seconds` workflow (Page is loaded > *Do every 5 seconds* > Display data/refresh) or by showing live `Search for NotificationLogs` (Bubble repeating groups update automatically after server changes).
- **Disable the button** while processing: button conditional *"This Button is not clickable"* when the page's latest log for this author is Pending/Processing.

**Bulk button** ("Generate Summaries for All Pending Authors", admin_dashboard):
- Eligible authors = `Search for Authors:filtered(Search for Books(author = This Author, royalty_pending > 0, status = Published & Live):count > 0)` (authors with only fully-paid or in-production books are skipped).
- Put steps 1-4 of the single-send workflow into a **Custom event** `send_one` (parameter: Author). It runs per author, so each one gets its own NotificationLog and idempotency key and is tracked independently.
- If your plan has backend workflows: *Schedule API workflow on a list* over the eligible authors, calling the same logic once per author.
- Free-plan alternative: button sets a custom state `queue` = eligible authors and `total` = `queue:count`; a page workflow *Do every 3 seconds, only when queue:count > 0* triggers `send_one` with `queue:first item`, then sets `queue` = `queue:items from #2`. Show progress as `total - queue:count` of `total`, and a final tally of Success/Failed from NotificationLog rows created in the last 10 minutes.

## Phase 6: Test, record, submit
Use `docs/TEST_PLAN.md`. Record 3-5 minutes (author portal, admin portal, author detail, trigger, n8n execution view, log update, privacy test).
