# Changelog

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

## v0.7.1 (12 October 2026)

- The versions offered in Settings → Updates follow `IMAGE_TAG`, so a copy is only offered what **Update now** can install. A copy on `latest` is never offered a beta, whatever its build tag, and one kept on a fixed version says so. Settings → Updates shows which releases a copy follows.
- The README explains the test copy's two settings (`APP_CHANNEL` is the label, `IMAGE_TAG` picks the versions) and how to turn a test copy back into a normal one.

## v0.7.0 (12 October 2026)

- **One-click updates**: **Update now** in Settings → Updates installs a new version and restarts the app, with no terminal. A copy of the database is saved to `backups/` first, and the page reloads by itself when it's done. Main login only.
- Each release is published as a ready-made image (`ghcr.io/kirtangl/simple-budget`), so installing and updating no longer builds on your server. `IMAGE_TAG` picks releases (`latest`), pre-releases too (`beta`), or a fixed version.
- The app stops straight away when Docker asks it to (restarts and updates take seconds, not 30).

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
