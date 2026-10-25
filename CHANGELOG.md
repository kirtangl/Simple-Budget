# Changelog

Each version's notes become its GitHub release notes and show in Settings → Updates, so they're written for the household, under `### New`, `### Improved` and `### Fixed`. Anything for whoever runs the server goes in a paragraph after them.

## v0.9.13 (25 October 2026)

### New
- **Notifications bell.** A bell beside your account button (top left on a phone) gets a dot when there's something new: red for an alert, amber for a warning. Tap it to see the notices, newest first. Tap one to go where it points, or use **Mark all read** and **Clear all**. For now it tells you when a backup fails and when an update has been installed, and later updates will add more. Notices are deleted after 90 days.
- **Storage** under Settings → Backups shows how much room the database and the backups take, and how much space is left on the server.
- **Settings → Apps → Price Checker** shows whether the price checker is set up, running and using the right password, with the commands to add it if it isn't. **Set up the Coles button** is there too.

### Improved
- **Settings is grouped.** Your budget (Income, Accounts, Payees, Categories), Site (General), Appearance & Security, Backups & Updates (Updates, Backups and Advanced) and Apps (Price Checker). On a computer the groups are a list down the side. On a phone, Settings opens as that list, and each page has a back arrow. Old links and bookmarks still open the right page.
- **Backups have their own page.** The backups kept on the server, and downloading or restoring a backup file (which was under General), are now together under Settings → Backups.

## v0.9.12 (25 October 2026)

### New
- **Find prices puts the closest match first.** Results are sorted by how well they fit the product: its words and brand (CSR Brown Sugar before White Sugar), what it's matched to at your other stores, fewer extra words (Brown Sugar before Dark Brown Sugar), nothing made from it (Chicken Seasoning drops down), and the size nearest yours (430 g before 1 kg when there's no 500 g). Tap **Best match first** to sort by price per kg instead. The stores are still searched for the name alone.
- **Product pictures.** Find prices shows each store's picture beside its results, and the one you pick is kept (a small copy, a few KB) and shown on the list and in Saved products. Pictures are in backups. Coles pictures show too.
- **"Dearer per kg"** shows on the list when another store's pack costs less but more for the amount (a 400 g pack against your 500 g), so you can tell when the bigger pack is the better buy.
- **Due dots on Budget → Expenses.** Each bill has a dot by its schedule: green when it comes out this pay, blue next pay, and faint grey when it isn't due for a while. Savings spread over the year get a grey dot too. Hover over a dot to see which.
- **Keep in account breakdown.** Hover over an account's Keep in account figure on the Overview to see a card of what it's made of (tap it for the full popup): this pay's bills still to come, what's held for bills further ahead, the day the account is tightest, and the big bills coming up with their dates. Anything in the account above Keep is spare. Keep is rounded up to the whole dollar on the card, and the popup shows the exact amount. The popup also says that savings aren't included, so you can take a pay's savings out and keep at least Keep, and every bill is still covered.

### Improved
- **Things bought each at a store that prices by the kilo.** A Pack / each product with no weight for its size (like Onions, each) now has **About how much one weighs** in Edit product. A store that only gives a price per kg, like Aldi's loose onions at $3.49/kg, is then priced for one (about 200 g = $0.70) instead of the whole kilo. Aldi results marked "per kg" are now recognised as sold by the kilo too.
- **Shopping list rows** are redone. On a computer each item is two lines: the name with its size and price per kg, L or each, the aisle, the amount and the total, then a cheaper similar product on the left and a cheaper store on the right, so nothing runs into the amount any more. The cheaper store shows its price per pack, each or for the weight, its price per kg, and a green saving. The − and + are now one pill that doesn't move when the amount changes. On a phone each item folds to one line with its amount, total and small hints (⇆ for a cheaper similar product, the green saving); tap the arrow to open the amount, Set aisle, the cheaper store and the similar product.
- **Deposits this pay** is redone. Each account shows its transfer per pay on the left and **Keep in account** in large type on the right. Under that, a bar shows where the transfer goes: bills that have come out (orange), bills still to come (brown), savings (green) and anything extra (blue). Under the bar are how much in bills is left, the savings (now always shown, even $0), and whether the transfer is **Extra**, **Even** or **Over**. When it's over, a red mark shows where the transfer runs out. The heading shows how many accounts there are, with the total that goes in each pay on the right. The **?** beside the heading explains the colours, and an account with a buffer shows it beside its transfer, like "$940 per pay +10%", with a hover saying what it means. The bars are the same thin height as the rest of the page, and on a phone the card is laid out the same way, just smaller.
- **Keep in account turns amber** when it's more than that account's transfer, so none of this pay's deposit is spare.
- **Rounding and buffer are set per account.** Edit an account (Settings → Accounts) to pick its rounding and buffer, so one account can be rounded up to $10 with a buffer while another is exact. They've moved from Settings → General, and every account starts with what was set there, so no deposit changes.
- **Keep in account always looks 12 months ahead.** The "Should hold looks ahead" setting is gone, since the year-end options missed bills just after the year ended. An old choice of calendar or financial year is ignored.

## v0.9.11 (18 October 2026)

### New
- **Aisles in Edit product** are tidier. When a product is in the same place at every store location (like Dairy), it's one box saying so, with **Change**, and **Different at some stores? Set per location** to set them one by one. Otherwise each location is a row you tap to change, with **Not set** in orange, and **Set all the same** sets one aisle or category everywhere at once (adding the category to any location that hasn't got it).
- A **copy** button (the two-squares icon beside Check prices) copies what's left on the list as plain text, under a heading for each aisle in order, one item per line (like "Rolled oats 750 g ×2"), to paste into Notes or a message for the shop while the app can't be reached away from home.
- **Check prices** is redone, for what's on your list. Each item has a box for every store: automatic prices are dashed with a ✎ to type over them, prices you typed are solid, and **Not sold** is striped. The cheapest is coloured, and under each box is when it was checked, in green since the stores' Wednesday price change or orange before it. Each row has ↻ to refresh its automatic prices and 🔍 to find it at the stores (highlighted when it has typed prices that could be kept up to date instead). At the top are a search, **Out of date only** and **Refresh these**, with a key to what the boxes mean, and the bottom says how many prices are up to date. **Check all … saved products** opens Saved products for everything else.
- **Not sold**: picking **Not sold at …** in Find prices (or **Not sold here** under a price in Edit product) saves that in place of a price. Edit product and Check prices show it, and on the list that store says "Not sold here" instead of + price.
- **Find prices** (automatic price search) is redone. Each store is a tab across the top showing how it's going: a spinner while it searches, then **✓ Matched** or **Pick one**. Under it is that store's **likely matches**, sorted by price per kg (or L), each one line with its size, price per kg, **Special · was …** and **In store only**, a ≈ for a store's approximate weight, and ↗ to view it on the store's site. Things made from it, like pear juice or baby food, are tucked under **Show … other results**. **Not sold at …** is under the list, and **Next: …** steps to the next store.
- **Manage stores** is redone: each store is a card you can fold away, showing its locations and how many items have aisles at each ("Aisles not set" in orange). A ⋯ menu on the store has Rename, Search link, Colour and Delete, and one on each location has Set aisles…, Rename and Delete location. **+ Add a … location** sits under each store, and **+ Add a store chain** at the bottom.

### Improved
- **Where are you shopping?** shows each store's locations as tiles, with which one was used last and when each was last used (shared by the household). Tapping one picks it and closes; **Shop at …** keeps the one you're at. Adding, renaming and deleting moved to **Manage stores**.
- **Saved products** shows the list total beside **Close** and has smaller ×1 buttons, and the store picker, Manage stores and the item popup no longer leave an empty strip under their buttons.
- The **Sold by** buttons sit evenly in their box.
- **Add to Home Screen** gives a sharp icon in your theme's colours (it was blurry and always teal). The icon is picked when you add it, so to change its colour later, pick the theme, remove the home-screen app and add it again.
- **Dark home-screen icon** under Settings → Appearance gives a near-black icon with the ring in your theme's colour, to sit with an iPhone's dark icons (web apps can't give iOS a separate dark icon, so this is the one icon in every mode). It's saved on that device.
- On a phone, **Saved products** fits the screen and only the product list scrolls, so nothing is cut off at the bottom.
- On a phone, **Manage stores** and **Shop at …** in the store picker are full width, one under the other.
- Deleting a whole store now says plainly that it removes every one of its locations and the aisles set at them, not just one location.
- On a phone, the totals under the shopping list no longer leave gaps. Each total is on its own line with its amount on the right, and on a wider screen, like a tablet, Total shop, Spent so far and Still to buy share one line with Total after savings under them.
- When no store is picked on the Shopping tab, a banner above the list says so, with **+ Add a store location** (or **Choose store**). Prices on the list, totals and aisles all need one.

### Fixed
- After picking prices in Find prices, Edit product shows them (with today's check date) straight away. It used to show the old prices, and pressing Save put them back, which also left them showing as checked yesterday and out of date.
- "Checked today" and "yesterday" go by the calendar, not by 24 hours.
- Deposits are rounded **after** the buffer is added, so they're always a round number. For example, $301 with a 10% buffer and rounding up to $10 is now $340 (it was $341).
- **Saved products** no longer shows an error ("undefined is not an object") when the list has ticked-off items.
- A store product's size no longer shows twice when its name already says it, like "Tim Tam Value Pack 365g 365 g".

For whoever runs the server: nothing to do beyond **Update now**.

## v0.9.10 (18 October 2026)

### New
- Tapping something on the shopping list opens a simpler popup for **what's on this list**: how much, its price at every store for that much (cheapest first, marked **Best**), and a **Note for this shop** that's cleared with the item. Everything else about the product is behind **Edit product**.
- **Bought by weight**: fruit, veg and meat can be bought by the kg. On the list they're a weight, with − and + by your step (like 250 g) and quick picks (500 g, 1 kg, 1.5 kg, 2 kg or Other), or switch to **Count** for "6 bananas" using about what one weighs (filled in from Woolworths when it says).
- **Other sizes**: when a store sells the same product in another size, the popup says so with its price per kg or L, like "Woolworths also sells a 1 kg pack for $3.40 ($3.40/kg)". **Swap** uses that size for this shop only.
- **Cheaper similar** in the popup lists each store's close match, cheapest for the amount first (set apart when it's the one the list mentions), and each has **Swap** to buy it instead for this shop only. Tapping a cheaper similar on the list opens that item.
- **Refresh prices** in the popup checks just that product's prices, with a spinner then a tick for each store while it runs. When they were checked shows green if it's since the stores' Wednesday price change, orange if before.
- When Automatic price search matches something a store sells by the kg (like loose bananas), it offers to switch the product to **By weight**.
- Settings → Updates shows an update's **Extra steps** when it needs something done on the server too, with **Copy commands**. Save your app's folder under **Preferences → Server folder** and the commands include it.

### Improved
- **Edit product** has **Sold by** (Pack / each, Weight (kg) or Volume (L)), the usual amount and − / + step, each store's price (per kg for weighed things) with which store product it's for, a **Prices are up to date / Refresh now** bubble (or **Search and match** when prices aren't automatic yet), and the product's aisle at every store location, grouped by store, with **More stores** for any you've added.
- The shopping list is tidier: a cheaper price at another store shows under the item's price ("$2.75 at Coles"), a cheaper similar shows under its name in blue with a ⇆, and each category's saving reads "Save $… at other stores", all without the bubbles. Items with a note show a small note icon.
- Something new typed onto the list goes on as a pack, with a **Set up** tag until you've said how it's sold.
- Close matches and other sizes are compared by price per kg or L, so a 1.94 L bottle and a 2 L one can be.
- Refreshing prices searches each store again for the product, which also keeps its other size and close match up to date, in the same number of searches as before.

For whoever runs the server: nothing to do beyond **Update now**. Products you already have stay bought by the pack until you change them in Edit product.

## v0.9.9 (17 October 2026)

### New
- **Automatic price search** in a product looks it up on the Woolworths, Coles and Aldi websites at once. Tap **Use this** on the one you buy at each store (or **None of these**) and its price is saved, along with whether it's on special and its normal price. From then on its price can be kept up to date for you. This needs the new price-checker, which whoever runs the server turns on.
- When products on your list have prices from before the stores' Wednesday price changes, a banner says how many are out of date and when they were last checked. **Update** gets this week's prices for just what's on the list, shows each store's progress, then what changed (old → new), what couldn't be found (with **Find new match**), and what isn't matched yet.
- **Cheaper similar**: when another brand of the same kind and size costs less (often at Aldi), it shows under the product and on the list as a hint. It never changes Best buys or the totals.
- If a store asks you to prove you're a person, its page opens in the app so you can solve it yourself, then the check carries on. If it still won't, that store says **Try again later**.
- **Coles button**: Coles turns automatic price checkers away, so its prices come from a small extension for Brave or Chrome on your computer instead. Press it and it searches Coles for what's on your lists, a few seconds apart, in your own browser, and sends the prices back. Download it and see the steps under **Check prices → Coles button**.
- **Refresh prices** in Saved products gets the latest price for every product with an automatic price, whenever you like.

### Improved
- **Saved products** is now a list: each product's price at the store you're shopping at (marked **auto** or **manual**), the best price anywhere and where, and **+** to put it on the list. What's on the list is highlighted, with the list's total at the bottom and what it would be at the best prices. **Edit** shows a pencil and a bin beside each product, and a deleted one can be brought back with **Undo** for a few seconds.
- **Check prices** shows every product with a box for its price at each store, and **Auto** beside it to search the stores' websites for it. **Needs checking** shows just what has no price or an old one.
- The search's suggestions show each product's price at the store you're at and the best price elsewhere.
- Cheaper similar products stand out on the list in blue, and a button above the list says how many there are and lists them.
- Loose fruit and veg get the right price from Automatic price search. Woolworths and Coles sell bananas "each", so the price is worked out from their price per kg (at Woolworths, from the weight they say one weighs): 1 kg of bananas at $4.50/kg is saved as $4.50, not 81c. Aldi's per-kg prices work the same way.
- Automatic price search looks for the name alone (just "Bananas", not "Bananas 1000g"), and lists what's the same size as yours first.

For whoever runs the server: automatic prices need the new price-checker container (about 2 GB, since it has its own browser). See "Automatic prices" in the README to turn it on; without it, the app works as before. The price-checker visits the stores' home pages twice a week at random times, never solves a store's puzzle itself, and leaves a store alone for a while if it keeps asking.

## v0.9.8 (17 October 2026)

### New
- **Look up** beside each store's price in a product opens that store's website already searched for the product, so you can check its price in a tap. Woolworths, Coles and Aldi have it built in. For any store you add, give it a **Search link** under **Edit**.
- **Check prices**, above the list and in Saved products, shows one store at a time with the products that have no price there or an old one first, what's on the list before the rest. Type the new price, or press **Still right** if it hasn't changed.

### Improved
- Every price remembers when it was last checked ("Checked 2 weeks ago"), and prices older than four weeks show in orange with a **Still right** button.

For whoever runs the server: nothing to do beyond updating as usual. Prices you already have count as checked on the day you update.

## v0.9.7 (17 October 2026)

### New
- **Shopping**: a new tab with a shared shopping list, and one of your own under **Mine**. Type in the search box to find something on the list (type an item's full name and the list jumps to it and highlights it; the **✕** clears the box), or press **Add** to put it on; anything you've added before is suggested as you type. A bar shows how many you've got so far.
- The store you're at is the heading at the top, with its first letter in its colour. Press **Change store** to pick another. Woolworths, Coles and Aldi are there to start with, and **Add a store** adds others, like IGA. Each store can have several locations, and its own colour (Woolworths green, Coles red and Aldi blue to start). In the **Change store** popup, **Edit** changes a store's name and colour, the bin beside a store or location removes it, and **+ Another** adds a location.
- The list is split into folding sections by aisle, from 0 to 20, with named sections like Produce, Deli, Meat, Dairy and Freezer slotted in where they are in that store. **Edit categories** changes their names and order. The order takes decimals, so Produce 0.1, Bakery 0.2 and so on come before Aisle 1 in the order you set. **Collapse all** folds every section away, and **Expand all** opens them again.
- **Best buys** shows only what's cheapest (or the same price) at the store you're at, so you can shop one store, change store, and pick up the rest.
- New items start in **Unsorted**. Tap **Set aisle** once and the item is sorted at that store from then on. Every location remembers its own aisles, and an item can be marked as not sold at a store.
- Each item shows how many (×1, ×2 …) with − and + buttons. Tap an item to set its size and unit (like 2 L or 500 g) and its price at each store. A price can be each, or per kg, per 100 g, per L or per 100 mL, and the cost is worked out from the size: $10 per kg for 500 g is $5. Items with no price yet show a **+ price** link.
- Ticking something off greys it out and moves it under a folding **Got** line at the bottom of its section, with the first letter of who ticked it (in their colour) and the store it was bought at. Untick it if it was a mistake. **Clear ticked items** removes them once you're done, and keeps anything you didn't find on the list for next time. Ticking the last item asks whether to **Complete** the list (clear it for next time) or **Keep** it.
- Under the list, a summary shows the **Total shop**, what's been **Spent so far**, what's **Still to buy** at the store you're at, and the **Total after savings** if you buy what's left wherever it's cheapest. A coloured bar and a table break it down by store: spent, still to buy, and each store's total. When prices are the same, the store you're at is used. Each section's heading shows its total, with a green **Cheapest** tag when it could cost less elsewhere.
- **Saved products**, beside the search box, shows everything you've bought before as buttons under their aisles at your store. Tap to add, tap again for one more, or press **Edit** to change a product.
- The list updates by itself every few seconds, so when someone else ticks something off or adds something, you see it.

For whoever runs the server: nothing to do beyond updating as usual. The shopping list is part of backups (Download backup), and restoring an older backup leaves it as it is.

## v0.9.6 (17 October 2026)

### Improved
- Simple Budget now runs on the latest version of Express, the part that answers every page and button. Nothing should look or work differently. It keeps the app current, so future fixes and updates stay easy.

### Fixed
- A price change set for a future date can be cancelled: its "Coming up" line in a bill's price history now has a bin like the others.
- Moving an account up or down no longer changes the colours of your accounts. Each account now keeps the colour it shows today, until you pick another.

For whoever runs the server: nothing to do beyond updating as usual. Express moves from 4 to 5, and the code checker used by the build moves from ESLint 9 to 10.

## v0.9.5 (15 October 2026)

### New
- **Log out everywhere**: under Settings → Security, **Log out my other devices** ends your login on every device but this one, and **Log out everywhere** beside another login ends all of theirs, for example after a phone goes missing.

### Improved
- A device stays logged in for 30 days from when it was last used, instead of a year from when it logged in. A device you use regularly never asks again; one left behind stops working by itself.
- Passwords are stored with stronger protection. Each one is upgraded the next time it's used to log in, which logs that login out once on its other devices.
- Settings → Updates warns if this copy's updater still has the password every copy starts with, explains how much that matters, and gives the two commands that fix it. Until then, a red dot on Settings and on the Updates tab points the way (main login only). **Ignore** hides the dots and folds the warning to its heading, with a + to open it again.

For whoever runs the server: give the updater its own password if Settings → Updates asks (see "How the updater works" in the README). Then run `git pull` and `sudo docker compose up -d` once, so the updater runs the exact version this release names. Server backups are now readable only by the app. The build pins Node and every GitHub action to an exact version, Dependabot proposes updates to them, and only the publishing step can write images. The README now covers HTTPS at home, checking a branch's `.github` folder before releasing it, and the image name for forks.

## v0.9.4 (15 October 2026)

### Improved
- Every page shows the same deposit for each account as the Overview: Budget, Settings → Accounts and Analytics used to work it out their own way, and could count a loan whose term had ended, or leave out a bill starting part way through this cycle.
- **What if I pay extra?** on a loan now uses the same maths as the loan's other estimates, so even a small extra amount never moves the pay-off date later.
- "Paid this year" on a bill counts each payment at the price it was then. A bill that went from $100 to $120 in September now shows $440 paid since July, not $480.
- Loan estimates are worked out about five times faster, and remembered until something changes, so pages load quicker on a NAS or Raspberry Pi.
- Saving a goal with a new category (or a new colour for one) saves both together. Renaming or removing a category that only existed on its goals is done in one step too.
- Moving a goal category between Saving for and Paying back takes its goals with it.
- **Update amount** accepts $0, and its error messages say which box is wrong.

### Fixed
- Entering a price dated today or earlier under **Update amount** keeps a future price you'd already set. Only a new future price replaces it.
- Changing just a bill's end date (or start date) is checked against the other date, so a bill can't end before it starts and disappear. Moving a sub category into a category that already has one with the same name is refused.
- A loan whose term has ended, but isn't ticked Paid off, no longer shows a next repayment.

For whoever runs the server: loan dates more than 60 years ago are refused, and each list has a generous size limit (for example 2,000 bills and 500 loans), so a damaged backup file can't make the app crawl. The app finishes sending a backup download before it stops for an update, and a password reset waits a moment if the app is saving rather than failing.

## v0.9.3 (15 October 2026)

### Improved
- Password guessing is properly limited: each guess is counted before it's checked, so sending lots at once no longer gets past the "5 tries, then wait a minute" limit. The current password box under **Change my password** has the same limit.
- New passwords need at least 8 characters. Passwords you already have keep working.
- The main login can't be removed, and only the main login can change its own password. Every login can still add, rename or remove the others, and set a new password for one that's been forgotten.
- Restoring a downloaded backup is for the main login only, like restoring a server backup, and saves a copy of what was there first under Settings → Updates → **Backups**.
- Restoring a backup file that only has some sections (for example just categories) keeps your other bills linked to them by name, and tells you about any it couldn't match.
- Backups made with **Back up now** can be deleted, and up to 20 are kept.
- The app refuses changes that don't come from its own pages, so another website or app on the same server can't press its buttons for you.
- Your browser no longer keeps copies of the budget's data, so bank details don't stay on a shared computer after logging out.

### Fixed
- After a password reset, other logins carry on as normal. Before, everyone except the main login was stuck on "Choose a password".
- The "Choose a password" screen has a **Log out** button.
- After a password reset, the login page no longer shows the password. The reset command tells you instead.

For whoever runs the server: you can now set the main login's starting password with `START_PASSWORD=...` in `.env` (at least 8 characters). It's used on first setup and when the password is reset, and it's never shown in the app. To use it, run `git pull` in the app's folder so `docker-compose.yml` passes it on, then `sudo docker compose up -d`. `TRUST_PROXY=true` now only trusts proxies on the home network.

## v0.9.2 (15 October 2026)

### Fixed
- Removing a price or repayment change from a bill's or loan's history puts back how often it's paid, as well as the amount. Before, a bill changed from monthly to quarterly and then put back stayed quarterly at the old price, which threw out the deposits.
- Restoring a downloaded backup keeps each bill's and loan's own history. Before, a restored bill could show another bill's old prices, and removing one of them changed its price.
- Downloaded backups now include the price, repayment, balance and rate history, so restoring one brings the history back too. Older backup files still restore; their bills start a fresh history from their current amounts.
- A future price change that's missing its amount or its date can no longer stop every page from loading.
- Restoring the oldest of the server backups no longer deletes it.

The app's tests now run before every release is published and on every pull request, so a release can't go out with failing tests.

## v0.9.1 (14 October 2026)

### Improved
- The buttons at the bottom of every popup stay in view while you scroll, on desktop as well as phones. When a popup is long enough to scroll, a thin line sits above them.
- Expenses on the Overview show their account in a bubble of the account's colour, so it stands out more.
- Every bar on the Overview is the same thin size as the Expenses bar at the top.
- Paid bills on the Overview keep a green date again.
- Tap anywhere on an account under **Deposits this fortnight** to see its bank details, and rows light up when you point at them, like the rest of the Overview.
- Items on the Goals page light up when you point at them, like other rows you can tap.
- A bill's notes are shaded in its popup, so they stand out.
- Budget → Expenses and Savings on a computer: each account or category is its own tile, with its name (tap to fold it away), deposit and total across the top, so it's easy to tell the headings from the bills.
- On a computer, the whole top of the Budget page (title, Add button, tabs, and on Expenses and Savings the search, filters, bill count and column headings) stays put as you scroll. On phones the search, Filters and count stay at the top. There's also a **Sort by** next to **Group by**.
- Grouping by category shows each category in its own colour.

### Fixed
- The payee beside an account bubble on the Overview lines up with the account name on every computer.
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
