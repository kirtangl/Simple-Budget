# Simple Budget: notes for Claude

A self-hosted household budget for two people, following Australian conventions (AUD, BSB, BPAY, pay cycles, financial year July–June). The README is the user guide; this file is how to work on it.

## Working with the owner

- The owner isn't a developer. Explain things in plain words, lead with the answer, and give exact commands to copy when something needs the terminal (usually `sudo docker compose ...` in the app's folder on their server).
- The repository is **public**. Use made-up data only in tests, screenshots, examples and docs. Never real names, amounts, accounts or email addresses.
- Keep the `Co-Authored-By` line on commits.
- Code changes go through a pull request. The owner merges and publishes releases themselves.

## How it's built

- Node 22, Express, `node:sqlite` (one database file), and a plain-JavaScript single-page app with no build step.
- `src/server.js`: app setup, security headers, the Host allowlist, the Updates, Backups and Advanced routes, and the version (`APP_VERSION` or package.json).
- `src/api.js`: budget data routes, input checks (`T.*`), and JSON backup export and import.
- `src/budget.js`: pay cycles and the deposit and "keep in account" maths. `src/db.js`: migrations (append only, never edit an old one).
- `src/auth.js`: the main login (stored in settings, id 0) and extra logins, cookies, and the login rate limit.
- `src/config.js`: server settings. `.env` wins over values saved in Settings → Advanced.
- `src/updates.js`: checks GitHub releases and the image registry, and asks the updater (Watchtower) to install. `src/backups.js`: database copies in `data/backups`, and restore.
- `public/app.js`: the whole UI (`html` template helper, escaped unless `raw`). `public/styles.css`: every colour is a theme variable (`--brand`, `--card`, `--line`, `--paid`, `--danger`...), so new UI must use them and work in every theme, light and dark.
- Money is integer cents everywhere.

## Checking changes

- `npm test` runs every test (node:test). Add tests for new behaviour.
- For UI changes, run the app and look at it: `PORT=3000 DB_FILE=/tmp/sb.db npm start` (default password `simplebudget`). Check desktop and phone widths and at least one light and one dark theme.

## Versions and releases

- Bump `version` in package.json and package-lock.json, and add a CHANGELOG entry, with every change that's released.
- CHANGELOG entries are the release notes and show in Settings → Updates, so write them for the household, under `### New`, `### Improved` and `### Fixed` (bullets). Server instructions go in a paragraph after them.
- Publishing a GitHub release builds the image `ghcr.io/kirtangl/simple-budget` (`.github/workflows/release-image.yml`), tagged with the version, `beta` (every release) and `latest` (full releases only). A release published with empty notes gets its CHANGELOG section.
- To test a pull request: publish a pre-release from its branch (e.g. `v0.9.0-beta.1`). The test copy (`IMAGE_TAG=beta`) offers it under Update now. Then merge and publish the full release from `main`.

## The owner's two copies

- **Live**: `IMAGE_TAG=latest`, port 3000. Real data, so never point it at betas or branch builds.
- **Test**: `CONTAINER_NAME=simple-budget-test`, `HOST_PORT=3001`, `APP_CHANNEL=test` (only a label), `IMAGE_TAG=beta`.
- Both run the updater container (Watchtower) for one-click updates. After pulling new code into a copy's folder, `sudo docker compose up -d` applies changes to `docker-compose.yml`.
