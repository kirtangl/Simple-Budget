'use strict';

// Forgot the main password? Run this to put it back to its starting password:
// START_PASSWORD from .env if it's set, otherwise the default ("simplebudget"),
// which the app asks you to change at the next login. With Docker:
//   docker compose exec budget node src/reset-password.js
// The password is only shown here, never on the login page, because the
// household's data is already in the app.

const path = require('node:path');
const { openDatabase } = require('./db');
const { resetPassword } = require('./auth');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'budget.db');
const db = openDatabase(dbFile);
const start = resetPassword(db);
console.log(start.fromEnv
  ? 'The main password is back to START_PASSWORD from your .env file.'
  : `The main password is back to "${start.password}". Log in with it and you'll be asked to choose a new one.`);

// A login you don't recognise here could be someone else's way in.
const others = db.prepare('SELECT name FROM logins ORDER BY name COLLATE NOCASE').all().map((l) => l.name);
console.log(others.length
  ? `Other logins, which still work as before: ${others.join(', ')}. Remove any you don't recognise in Settings → Security.`
  : 'There are no other logins.');
