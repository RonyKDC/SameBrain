# Same Brain?

A quiz game you play with people nearby. Version 0.1 (test build).

## What is in this version

- Anonymous play with a random nickname, after an 18+ confirmation
- Location from the browser, radius slider from 1 to 50 km
- Radar and list of nearby players with a rough distance only
- Challenge, accept or decline, five questions, match score
- Ready-made reactions only (no free text), rematch
- Leaderboard for players within your radius
- Block, and report (reports are printed in the server log)
- Practice bot for when nobody is around

Not in yet: registration, phone verification, chat, paid contact exchange.

## Try it on your computer

You need Node.js 18 or newer. There is nothing to install.

    node server.js

Open http://localhost:3000/?demo in two browser tabs. `?demo` skips the location
prompt and pretends you are in Beirut, and treats each tab as a separate player.

## Put it online for free (Render)

Phones only share their location with HTTPS sites, so real testing needs hosting.

1. Create a free account on github.com and a new empty repository.
2. Upload everything in this folder to it ("Add file" > "Upload files"; drag the
   `public` folder in as a folder).
3. Create a free account on render.com and choose New > Web Service.
4. Connect the GitHub repository.
5. Settings: Language `Node`, Build command `npm install`, Start command
   `node server.js`, Instance type `Free`.
6. Create the service. After a minute or two you get an address like
   https://same-brain.onrender.com. Open it on two phones.

## Limits of this test build

- Everything is kept in memory. Players, scores and blocks reset when the server
  restarts. The free Render service sleeps after 15 minutes without visitors and
  takes about a minute to wake up, which also resets it.
- One server process, tuned for dozens of players, not thousands.
- Positions are rounded to about 100 m on the server and never sent to other
  players. They only receive a distance rounded to the kilometre.

## Files

- `server.js` game server (rooms, matching by distance, duels)
- `questions.json` the question bank, edit freely
- `public/index.html` the whole app screen
