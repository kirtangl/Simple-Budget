'use strict';

// The stores the price-checker knows. More can be added: a file like these, listed here.
module.exports = Object.fromEntries([require('./woolworths'), require('./coles'), require('./aldi')].map((s) => [s.id, s]));
