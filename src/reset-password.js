'use strict';

// Forgot the password? Run this to put it back to the default ("simplebudget").
// The app will ask for a new one at the next login. With Docker:
//   docker compose exec budget node src/reset-password.js

const path = require('node:path');
const { openDatabase } = require('./db');
const { resetPassword, DEFAULT_PASSWORD } = require('./auth');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'budget.db');
resetPassword(openDatabase(dbFile));
console.log(`Password reset to "${DEFAULT_PASSWORD}". Log in with it and you'll be asked to choose a new one.`);
