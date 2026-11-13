# Same Brain?

Meet people nearby through a five question quiz. Version 0.2 (test build).

## What is in this version

- Anonymous play with a random nickname, after an 18+ confirmation
- Short profile: age range, what you are here for, three interests
- Radar of people online within your radius (1 to 50 km), rough distance only
- Five question game with a match score, reactions and rematch
- "Keep talking": a private chat opens only if both players say yes
- Timed chat for new matches, then "Add friend" (again only if both say yes)
- Chat filter: numbers, links, emails, social accounts and explicit words are blocked
- Friends list with chat that has no time limit
- Daily five questions answered alone, used to suggest nearby people who think like you
- Waves for suggested people who are offline
- Phone sign up in TEST MODE (no SMS is sent, the code is shown on screen)
- Plans as a TEST SWITCH (no payment): Free 3 min / 1 friend, Plus $3 10 min / 5 friends,
  Unlimited $8. When two people chat, the longer plan covers both.
- Block and report
- Activity page at /admin
- robots.txt, sitemap.xml and page descriptions for search engines

Not in yet: photos, real SMS, real payments, a database.

## Settings (environment variables)

| Name | What it does |
|---|---|
| `ADMIN_KEY` | Password for the activity page. Open `/admin?key=YOUR_KEY`. Without it the page is off. |
| `GOOGLE_VERIFY` | The code from Google Search Console's "HTML tag" method, to prove you own the site. |
| `DATA_FILE` | Where the state file is saved. Default `data/state.json`. |

On Render: open the service, go to Environment, add the variable, save.

## Try it on your computer

    node server.js

Open http://localhost:3000/?demo in two browser tabs. `?demo` skips the location
prompt, pretends you are in Beirut, and treats each tab as a separate person.
To see the activity page locally, start it with a key:

    set ADMIN_KEY=test123 && node server.js      (Windows Command Prompt)

then open http://localhost:3000/admin?key=test123

## Limits of this test build

- Data is kept in memory and saved to a file every 30 seconds. Render's free plan has
  no permanent disk, so players, friends and activity numbers reset whenever the
  service restarts, redeploys, or wakes up after sleeping.
- The free Render service sleeps after 15 minutes without visitors and takes about
  a minute to wake up.
- One server process, sized for dozens of people, not thousands.
- Positions are rounded to about 100 m on the server and never sent to other people.

## Files

- `server.js` the server: matching by distance, games, chats, friends, activity page
- `questions.json` the question bank, edit freely
- `public/index.html` the whole app screen
