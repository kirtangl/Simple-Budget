# Simple Budget

A simple, self-hosted household budgeting app built around one idea: **every pay, put a set amount into each account**, and that amount is worked out from the bills each account has to cover.

It works on phones and desktops (add it to your home screen for an app-like feel), and runs on any machine that can run Docker.

## What it does

- **Overview → This pay**: opens on the current pay cycle, with **‹ ›** buttons to step back through past pays or ahead to future ones.
  - Three summary cards: **Combined income** (green), **Total expenses** due this pay (red) and **Remaining income** after deposits (blue). Tap **Show incomes** for a table of every income, and tap a row to edit it.
  - Every expense, saving and loan repayment due in the pay cycle, with its account's colour dot, filterable with an **All / To pay / Paid** switch and account chips. A monthly bill set for a day the month doesn't have (the 29th to 31st) comes out on the month's last day, with a note saying so. Tap one for its details (what's been paid this financial and calendar year, account or policy number, reference) and an **Edit** button. Paid ones are greyed out but stay in view, because bills sometimes come out a day or two late.
  - On a desktop, the Expenses tile is as tall as the deposits and loans beside it, and its list scrolls between the fixed heading and the to pay / paid totals at the bottom (phones show the whole list). Paid bills have a tick, and a Today line separates them from what's still to come.
  - How much to deposit into each account. Hover over or tap an account to see its BSB and account number, and copy them with one tap. Each account also shows its bills and savings separately, what's still to come out this cycle, and about how much it should be holding today so that, with the deposits still to come, every bill over the next 12 months (or to the end of the financial or calendar year) can be paid. Accounts with nothing in them this cycle fold away. Loans show alongside, with how much has been paid off of the amount borrowed and the next due date; tap one for its detail view: balance and pay-off date, how it's paid, the total cost split into paid and still to pay, a balance-over-time chart against the bank's schedule, a **What if I pay extra?** slider, interest this financial year, and details such as offset balance, fixed-rate end date, fees and break fees.
  - The goals and debts that need attention most: overdue or due soonest first.
- **Overview → Analytics**: a colour-coded cash-flow diagram, per cycle, per month or over 12 months (each income in its own colour → combined income → categories, savings and what's left), a line chart of income, expenses and savings for the next 12 months (hover or tap a month for its figures), expense distribution by category, deposits by account, and your biggest expenses.
- **Expenses**: add, edit, pause or delete bills. Each one has a payee, category, sub category, account, amount and frequency (weekly, fortnightly, monthly, every 2, 3 or 6 months, or yearly), plus the day it comes out. Each bill is marked with its account's colour, and the list can be searched, filtered by account or by when it's next due, and grouped, with a **Reset** button to clear it all. New payees, categories and accounts can be created straight from the expense form, and an existing name is picked instead of making a duplicate. Tick **Temporary** to give an expense or saving an end date (and optional start date); it stops after that.
- **Savings**: regular amounts you put aside, in whichever accounts you like. They're added to that account's deposit but kept out of Total expenses. Each is either a regular amount or a **yearly target** (say $1,000 a year) split evenly across each budget cycle. Each can have an optional goal, showing roughly how many cycles it takes to get there. Tick **Include in expenses** to also list a saving with the expenses each cycle. An expense can be switched to a saving (and back) with the **Type** box.
- **Menu**: four sections. **Overview**, **Budget** (tabs for Expenses, Savings and Loans: everything that sets your deposits), **Goals** (tabs for Saving for and Paying back) and **Settings**. On phones they sit in a bar along the bottom. Each section remembers the tab you last opened, and a red dot on Goals means something you're paying back is overdue.
- **Goals** (Saving for) and **Paying back**: summary cards (saved or paid back, still to go, and how much a fortnight keeps every dated item on track), then a card per group with a colour bar down the side. Each item has one status chip (due date, overdue or firm), a progress bar, a next-step line ("Put aside $X a fortnight to make it", "Needs $X now") and a **+ Add** button that opens a small panel with suggested amounts. The **⋯** menu removes money, marks an item done, edits or deletes it. Done items move to a collapsible **Completed** list with an Undo. The Paying back count turns orange when something is due within 3 days and red when overdue.
- **Loans**: mortgages, car and personal loans with the amount borrowed, interest rate, start date and term (or end date), the account repayments come from, and two repayments: the **scheduled** one the lender requires (how often, amount and a due date; the amount is calculated for you, or set your own), and an optional **budgeted** one you actually pay (for example $700 a fortnight towards $1,400 due monthly). The budgeted repayments go in the expenses list and deposits, and the Loans tab shows how much is budgeted towards the next due date. Estimates follow the budgeted repayments. Add the balance from a statement and the day interest is charged to keep the estimates close: balance today, pay-off date and interest still to pay. Repayments are added to the account's deposit (untick **Include repayments in the budget** if you'd rather keep it as an expense). A **Loan calculator** estimates the repayment for a new loan and the most you could borrow while keeping all your commitments under a share of income (70% by default). These are estimates, not financial advice.
- **Household menu** (top right): shows who's logged in, with links to Appearance, Security, Settings and Log out.
- **Logins** (Settings → Security): everyone shares the same budget, but each person can have their own password, name, icon colour and theme. There's no username: the password says who you are.
- **Appearance** (Settings → Appearance): match the device's light or dark setting (the default), pick Light, Dark, Warm, Ocean, Slate or Midnight, or make a **Custom** theme with a colour picker for every colour and a live preview of the Overview. The theme is saved to your login, so it follows you to any device. The logo and browser tab icon take the theme's accent colour.
- **Settings**: income (after-tax amount per pay and how often it's paid; tick **Temporary** to give it an end date; before-tax and super optional; untick **Include in budget income** for money that shouldn't pay the bills, which then shows as **Other income**), accounts (with BSB and account number; type the BSB as 6 digits and the dash is added for you), payees (an account or policy number, then BPAY with biller code and reference, bank transfer with account name, bank, BSB, account number and reference, Direct Debit with a reference, or other), categories and sub categories, the budget cycle (weekly, fortnightly, monthly or every so many days) and a day a cycle starts, which can differ from how often you're paid: income paid fortnightly is shown as its monthly total on a monthly budget, with the fortnightly amount beside it, deposit rounding and buffer, how far ahead the "should hold" estimate looks (12 months, or to the end of the financial or calendar year), and backup and restore. The tabs are split into setting up the budget (Income, Accounts, Payees, Categories) and the app itself (General, Appearance, Security).

### How the deposit per account is calculated

1. Each bill, saving and loan repayment is converted to a per-cycle amount: `amount × times per year ÷ cycles per year` (26 on a fortnightly budget, 52 weekly, 12 monthly). Income is averaged the same way. For example, a $300 monthly bill is $300 × 12 ÷ 26 = $138.46 a fortnight.
2. The per-pay amounts for everything paid from the account are added up.
3. The account's **total** is rounded up (not each bill), using the **Rounding** setting:
   - **Exact**: $293 stays $293
   - **Round up to $5**: $293 becomes $295
   - **Round up to $10** (the default): $293 becomes $300, and $301 becomes $310
4. The **Buffer** percentage (0 to 20%, default 0%) is added on top of the rounded amount. For example, $310 with a 10% buffer is **$341**.

Both settings are under **Settings → General**, or tap **change** next to the rounding note on the Overview.

Big yearly bills are spread evenly across the year, so in the pay one comes out, an account can show "more than the deposit". That's expected, because the money has been building up in that account over earlier pays.

## Running it with Docker (recommended)

You need [Docker](https://docs.docker.com/get-docker/) with Docker Compose.

```sh
git clone https://github.com/kirtangl/Simple-Budget.git
cd Simple-Budget
cp .env.example .env        # optional: change TZ if you're not in Queensland
docker compose up -d
```

This downloads the ready-made image and starts two containers: the app, and a small updater that installs new versions when you press **Update now** (see [Updating](#updating)). To build from the code in this folder instead, use `docker compose up -d --build`.

Then open `http://<your-server>:3000` and log in with the default password **`simplebudget`**. You'll be asked to choose your own password straight away.

First steps once you're in:

1. **Settings → General**: pick any pay day (cycles are counted every 14 days from it) and choose your rounding and buffer.
2. **Settings → Accounts**: add your bank accounts.
3. **Settings → Income**: add each person's fortnightly after-tax pay.
4. **Expenses**: add your bills.

To update, press **Update now** in Settings → Updates (see [Updating](#updating)).

### Passwords and logins

The first password is the **main** login. Add a login for each person under **Settings → Security**, each with its own password. Change your own password there too; doing that logs your login out on every other device. Any login can set a new password for another one that's been forgotten.

Forgot the main password? Reset it back to `simplebudget` from the server:

```sh
docker compose exec budget node src/reset-password.js
```

You'll be asked to choose a new password the next time you log in. Other logins aren't affected.

### Settings (`.env`)

Most of these can also be changed in the app under **Settings → Advanced** (behind a warning, main login only). A value set in `.env` always wins and shows there as "Set in .env".

| Variable         | What it does                                                                 | Default              |
|------------------|------------------------------------------------------------------------------|----------------------|
| `TZ`             | Your timezone, so bills flip to "paid" on the right day.                     | `Australia/Brisbane` |
| `SECURE_COOKIES` | Set to `true` if you put the app behind HTTPS (e.g. a reverse proxy).        | `false`              |
| `ALLOWED_HOSTS`  | Extra web addresses the app answers to, comma separated, e.g. `budget.example.com`. See below. | none |
| `TRUST_PROXY`    | Only behind a reverse proxy: its address (e.g. `172.18.0.1`), or `1`, so the login limit sees each visitor's real address. | off |

The app only answers to home-network addresses: an IP address like `192.168.1.20`, `localhost`, a plain name like `nas`, and names ending in `.local`, `.lan`, `.home.arpa`, `.internal` or `.ts.net` (Tailscale). This stops a website on the internet from tricking your browser into reading the budget. If you open the app through your own domain (a reverse proxy or a Cloudflare Tunnel), add that domain in **Settings → Advanced** (open the app by its IP address to get there) or to `ALLOWED_HOSTS`, or you'll see "Simple Budget doesn't answer to ...".

### Your data and backups

Everything is stored in one SQLite database file inside the Docker volume `budget-data`. It survives restarts and updates.

- **Backup and restore**: Settings → General → **Download backup** saves your accounts, income, payees, categories, expenses, goals, debts and settings as a JSON file. **Restore from backup** loads one back in and **replaces** what's there. Passwords and logins aren't included or changed. This is also handy for starting over: wipe the volume (`docker compose down -v`), start again, and restore.
- **Older backups keep working**: each file records its format version. When a newer app expects data an older file doesn't have, it fills in the defaults, and any section missing from the file is left as it is.
- **Full database copy**: `docker compose cp budget:/app/data/budget.db ./budget-backup.db`

### Updating

**Settings → Updates** shows this copy's version, the latest release on GitHub and its release notes, with a **Check now** button. The app also checks every few hours by itself. When there's a newer version, an **Update** tag appears beside the profile button, which also gets a dot, and the menu offers **Update to vX.Y.Z**.

Press **Update now** (main login only) and the app:

1. saves a copy of the database to `backups/` in its data volume (the newest five are kept),
2. asks the updater container to download the new image and restart the app on it.

It takes a minute or two and the page reloads by itself. Your data stays in its volume and everyone stays logged in.

Each release is built into an image at `ghcr.io/kirtangl/simple-budget` by a GitHub Action. `IMAGE_TAG` in `.env` picks which one a copy follows:

| `IMAGE_TAG` | Follows |
|---|---|
| `latest` (default) | Full releases |
| `beta` | Every release, including pre-releases like `0.8.0-beta.1` |
| `0.7.0` | Stays on that version (to go back after a bad update: set it, then `sudo docker compose up -d`). Update now is off. |

The app only offers what `IMAGE_TAG` can install, so a `latest` copy is never offered a beta. Settings → Updates says which one a copy follows. After changing `IMAGE_TAG`, run `sudo docker compose up -d` in the copy's folder.

**From the terminal** (or if you'd rather not run the updater): `git pull`, then `sudo docker compose pull && sudo docker compose up -d`. To build from the code instead, `sudo docker compose up -d --build`.

**How the updater works:** it's [Watchtower](https://github.com/nicholas-fedor/watchtower), which needs the Docker socket to restart containers. It only acts when the app asks (no schedule), only touches this copy (its scope is `CONTAINER_NAME`), and its port isn't published, so only the app can reach it. `UPDATER_TOKEN` in `.env` sets the password between the two if you'd like your own. To do without it, remove the `updater` service from `docker-compose.yml`; the app then shows the terminal commands instead.

No setup is needed for update checks. GitHub allows about 60 checks an hour without a login, far more than the app uses. If you run a private fork, add a fine-grained token with read-only **Contents** access as `GITHUB_TOKEN=...` and set `UPDATE_REPO=owner/name` (or set both in Settings → Advanced).

### Running a test copy alongside

Clone the repo a second time into another folder (each folder gets its own database volume), and give it its own name and port in that folder's `.env`:

```sh
git clone https://github.com/kirtangl/Simple-Budget.git simple-budget-test
cd simple-budget-test
cp .env.example .env
echo "CONTAINER_NAME=simple-budget-test" >> .env
echo "HOST_PORT=3001" >> .env
echo "APP_CHANNEL=test" >> .env
echo "IMAGE_TAG=beta" >> .env
docker compose up -d
```

The test copy runs at `http://<your-server>:3001` with its own data. To try live data in it, download a backup from the live app and restore it into the test one.

The two test settings do different jobs:

| Setting | What it does | Where |
|---|---|---|
| `APP_CHANNEL=test` | The **Test** tag in the header and page title, so you can tell the copies apart. Only a label. | `.env`, or Build tag in Settings → Advanced if it isn't in `.env` |
| `IMAGE_TAG=beta` | Which versions it's offered and installs: pre-releases too. Also keeps it from sharing an image with the live copy. | `.env` only (Docker reads it before the app starts) |

To try a branch, `git checkout <branch> && git pull`, then `sudo docker compose up -d --build`; **Update now** later puts it back on the newest release.

To turn a test copy into a normal one, remove the `APP_CHANNEL` and `IMAGE_TAG` lines from its `.env` (keep `CONTAINER_NAME` and `HOST_PORT` while the live copy runs alongside), then `sudo docker compose up -d`.

### Using it away from home

The app is meant to run on your home network. To reach it from outside, put it behind something that adds HTTPS, such as [Tailscale](https://tailscale.com/), a Cloudflare Tunnel, or a reverse proxy like Caddy, and turn on **Secure cookies** in Settings → Advanced (or set `SECURE_COOKIES=true`). If it's reached through your own domain, add it there too (or to `ALLOWED_HOSTS`). Don't expose port 3000 directly to the internet.

## Running without Docker

You need Node.js 22.13 or newer.

```sh
npm install
npm start
```

The database is created at `data/budget.db`. Log in with `simplebudget` and choose a new password. To reset it, run `node src/reset-password.js`.

## For developers

- **Backend**: Node.js + Express with the built-in `node:sqlite` module, so there are no native dependencies to compile. Money is stored as whole cents.
- **Frontend**: plain HTML, CSS and JavaScript in `public/`, with no build step.
- **API**: everything the app does goes through a JSON API under `/api` (`/api/data`, `/api/cycle?offset=N`, and CRUD endpoints for `accounts`, `payees`, `categories`, `subcategories`, `expenses`, `incomes`, `goals`, `loans`, plus `me` and `logins`). That keeps the door open for native phone apps later.
- **Backups**: the format is documented in `src/api.js`. If you change it, bump `BACKUP_FORMAT_VERSION` and add an upgrade step so older files still restore.
- **Tests**: `npm test` runs them. They include a made-up household whose deposits were worked out by hand.

```
src/
  server.js   app setup, static files, login
  auth.js     logins (hashed passwords), themes per login and the login cookie
  api.js      JSON API
  budget.js   pay-cycle maths (pure functions)
  db.js       SQLite schema, migrations and default categories
public/       the web app
test/         node:test tests
```
