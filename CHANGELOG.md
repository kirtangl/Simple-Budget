# Changelog

## v0.6.1 (12 October 2026)

Fixes from a code review and security audit.

- **Security**
  - The login limit can no longer be dodged by pretending to be a different address, and lots of wrong guesses from anywhere now slow everyone down for a minute.
  - The app only answers to home-network addresses, so a website can't trick a browser into reading the budget. **If you open it through your own domain, add it to `ALLOWED_HOSTS` in `.env`.**
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
