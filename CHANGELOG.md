# Changelog

Each version's notes become its GitHub release notes and show in Settings → Updates, so they're written for the household, under `### New`, `### Improved` and `### Fixed`. Anything for whoever runs the server goes in a paragraph after them.

## v0.9.1 (14 October 2026)

### Improved
- The buttons at the bottom of every popup stay in view while you scroll, on desktop as well as phones. When a popup is long enough to scroll, a thin line sits above them.
- Expenses on the Overview show their account in a bubble of the account's colour, so it stands out more.
- Every bar on the Overview is the same thin size as the Expenses bar at the top.

### Fixed
- The bars are back on **Deposits this fortnight**: green for the bills that have come out of each account, red for what's still to come out.

## v0.9.0 (13 October 2026)

### New
- See what's saved in goals for each account, in green: on the Overview deposits, on the Goals page, and on the Budget → Savings tab with the goals listed under each account.
- Goals and repayments remember who added them, shown as their name in their colour, or Shared. Switch between **Mine** and **Everyone's** on the Goals page, or with the small person button on the Overview.
- Price reviews: give a bill a review date, like an insurance renewal. Once it passes, the Overview asks if the price has changed, with **Update price**, **Remind me in 7 days** and **Skip until next year**.
- Price history: every change to a bill's amount is kept from now on, and shown as a curved chart when you open the bill. Tap a point for its date and amount. A price set for a future date shows in orange.
- Loan history: changes to a loan's repayment and rate are marked on its chart with dotted lines, and **History** lists them all. Each balance you enter is a point on an orange **Actual** line, drawn against your plan and carried on to pay-off at your current repayments. Hover or tap a point to see the estimate it replaced.
- **Update amount**: a small popup for a new price, from the price tag button on each expense or the bill's popup on the Overview. **Takes effect from** can be backdated, or set ahead so the price changes on that day.
- **Update balance**: a small popup for a loan's statement balance, rate and repayment, beside Edit.
- Back-dated prices slot into a bill's history in date order, so you can fill in what it used to cost. The newest price is still the one used.
- Remove a history entry added by mistake with the bin beside it. Removing the newest one puts the bill or loan back to the one before. Long histories show the latest 5, with **Show more**.
- Delete a loan from the Loans page, after an "Are you sure?".
- Adding a loan that started in the past with no balance asks whether to work the balance out from the minimum repayments (the amount borrowed plus interest, spread evenly over the term).

### Improved
- Popups for a bill, loan or account have the same buttons in the same places: Update (blue), Edit (green) and Close (red) at the top, and again at the bottom with Close on the right. They stay dim until you point at them. The buttons on each Loans page card match. Every other popup and question has the red ✕ at the top too, so a long form opened by mistake is one tap to close.
- On the Goals page, tap an item to edit it. Paid back shows in green, and Still owed and Still to go in red.

### Fixed
- The payee name under each bill on the Overview lines up with the account name.
- A loan's balance chart now comes down with the repayments from the start date, meeting the balance you entered, instead of climbing with interest and then dropping. Repayments before the next due date are counted too.

## v0.8.1 (12 October 2026)

### New
- Wait a day before offering updates: a new version shows up 24 hours after it's released, so one that's pulled never reaches you. Turn it on under Settings → Updates → Preferences.
- Choose how often to check for updates, from every hour to once a day.
- Choose how many automatic backups to keep: 5, 10 or 20.

### Improved
- The Channel line on the Updates page no longer has a "change" link, since it's set on the server.

## v0.8.0 (12 October 2026)

### New
- Settings → Updates shows backups of your data, with Restore. One is made before every update, and **Back up now** makes one any time.
- Preferences for updates: turn automatic checks off, or include beta versions.
- After an update, a welcome card says it went smoothly and where the backup is.

### Improved
- Settings → Updates is one card that changes with what's happening, and shows each step of an update as it goes.
- Release notes show what's new, improved and fixed, for the new version and the one you're on.
- A dot on the Updates tab when there's an update waiting.
- The Settings tabs sit together in one strip, like Budget and Goals, and fit on a phone without scrolling.
- A beta built from a pull request can be installed on the test copy with **Update now**, and shows its own version number.
- A version published in the last few minutes shows as on its way until it's ready to install, and an update that never starts says so instead of waiting forever.

## v0.7.1 (12 October 2026)

### Improved
- Updates only offer versions this copy can actually install.
- Test copies show which release track they follow, and the README explains how to turn one back into a normal copy.

### Fixed
- Copies on `latest` are no longer offered beta builds.

## v0.7.0 (12 October 2026)

### New
- One-click updates: **Update now** in Settings → Updates installs the new version and restarts the app, with no terminal. Your data is backed up first, and the page reloads by itself when it's done.
- Each release comes ready-made, so updating no longer builds the app on your server.

### Improved
- Restarts and updates take seconds instead of half a minute.

**Moving to v0.7.0** (once, from the terminal): in each copy's folder, `git fetch origin main && git reset --hard origin/main`, add `IMAGE_TAG=beta` to the test copy's `.env`, then `sudo docker compose up -d --build`. That also starts the updater. From then on, use **Update now**.

## v0.6.1 (12 October 2026)

Fixes from a code review and security audit, and a new **Settings → Advanced** tab.

- **Settings → Advanced**: the server settings that used to need `.env` (extra web addresses, reverse proxy, secure cookies, build tag, where to check for updates and a GitHub token) can be changed in the app. The tab sits apart in red, starts locked behind a warning and an "I understand" tick, and only the main login can save. Anything set in `.env` still wins and shows as locked.

- **Security**
  - The login limit can no longer be dodged by pretending to be a different address, and lots of wrong guesses from anywhere now slow everyone down for a minute.
  - The app only answers to home-network addresses, so a website can't trick a browser into reading the budget. **If you open it through your own domain, add it in Settings → Advanced (open the app by its IP address to get there) or to `ALLOWED_HOSTS` in `.env`.**
  - Pages are sent with security headers (no framing by other sites, a content security policy).
  - Colours are checked before they're saved, and only a backup restore can send a large file.
- **Fixes**
  - A pay frequency or rounding like "constructor" could be saved and break every page. Settings and restores now only accept the real options.
  - Restoring a backup with an empty entry gives a warning instead of failing.
  - "Keep in account" no longer counts deposits for bills that haven't started yet.
  - The loan calculator no longer counts expenses that have ended or not started.
  - Dates must be between 1900 and 2199, amounts can't be negative, and an end date can't be before the start date.
  - Typing "6.5%" as an interest rate no longer clears the rate, and "1,5" is no longer read as $15.
  - Logging out and pressing Back no longer shows the budget.
  - Double-tapping Save on a goal no longer adds the money twice.
  - Rows that open an edit form can be reached with the keyboard (Tab, then Enter).
  - An app left open overnight moves on to the new day when you come back to it.
  - "Copy commands" on the Updates page works over plain http, and "Last checked" shows the right day.
  - Editing a login saves nothing if part of it isn't right.

## v0.6.0 (12 October 2026)

- **Updates**: the app checks GitHub for new releases. An **Update** tag and a dot on the profile button show when one is out, and **Settings → Updates** has the release notes and how to update.
- The project is now public, starting from a fresh history.

## v0.5.1 (12 October 2026)

- The version shows in the profile menu. A test copy (`APP_CHANNEL=test`) or a beta version (e.g. `0.6.0-beta.1`) gets a **Test** or **Beta** tag in the header and page title.
- A test copy can run next to the live one: set `CONTAINER_NAME` and `HOST_PORT` in `.env` (see the README).
- The test and live copies no longer log each other out. Existing logins carry over.

## v0.5.0 (12 October 2026)

The first release.

- **Overview**: the current pay cycle with what to deposit into each account, every bill due with paid / to pay status, loans, and the goals that need attention. **Analytics** adds a cash-flow diagram, a 12-month outlook and spending breakdowns.
- **Budget**: Expenses, Savings and Loans, which together set each account's deposit. Search, filters, grouping and a reset button on the lists.
- **Loans**: scheduled and budgeted repayments, statement balances, offset, fixed-rate reminders, a detail view with a balance chart and a "pay extra" slider, and a loan calculator.
- **Goals**: Saving for and Paying back, with suggested amounts per fortnight, quick add, and a Completed list.
- **Logins**: one budget, any number of passwords, each with its own name, icon colour and theme.
- **Appearance**: seven themes plus a Custom theme with a live preview. The logo and tab icon follow the theme.
- Backup and restore, Docker setup, and works on phones and desktops.
