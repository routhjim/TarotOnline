# Taroky — online multiplayer handoff

Everything a developer needs to take the single-player Taroky game
(`../Taroky.dc.html`) online. The **rules engine is already extracted and
framework-agnostic**, so the hard part — a faithful, money-correct implementation
of Czech Taroky with bidding, contracts, contra/rey and chip settlement — is
done and unit-verified.

## What's here

| file | role |
|------|------|
| `taroky-engine.js` | Pure, UI-agnostic rules engine. No DOM/React/timers. Runs in Node **and** the browser. This is the authority. |
| `server.js` | Reference authoritative server (Node + `ws`): rooms, seats, bot-fill, per-player redacted state push. |
| `client-net.js` | Thin browser WebSocket adapter that bridges the protocol to your UI. |
| `PROTOCOL.md` | The wire protocol (messages + the redacted `view` shape). |
| `smoke-test.js` | Headless self-play that proves chips stay conserved (money never leaks). |
| `package.json` | `npm start` (server) and `npm run smoke`. |

## Run it

```bash
cd multiplayer
npm install
npm run smoke      # 500 headless deals; asserts chip conservation. Fast sanity check.
npm start          # ws://localhost:8080
```

Open two browser tabs, point a client at `ws://localhost:8080`, `join` the same
`roomId`, and the two empty seats stay as bots until more humans join.

## Ready-to-use client

`../Taroky Online.dc.html` is a **complete networked client** — the full ornate
table, but every control is driven by the server `view` and every move is sent
as an action (it inlines the same logic as `client-net.js`). Open it, enter your
name + server URL (`ws://localhost:8080`) + room, and Connect. It renders your
hand only, hides the partner until the called card falls, and shows bidding,
the talon shop, declarations/contra/rey, play and scoring — all authoritative.
It has been verified end-to-end against the engine (full hands, chips conserved,
redacted views). Point its Server field at your deployed `wss://…` URL to play
online. (Being a Design Component, it loads `support.js`; serve the two files
together, or bundle to a single standalone HTML the same way as the offline
build.)

## Architecture

```
        ┌── browser (client-net.js + your UI) ──┐        actions
Player →│  renders `view`, sends actions        │ ───────────────►┐
        └───────────────────────────────────────┘                 │
                        ▲  redacted `view` (your hand only)        ▼
                        └─────────────────────────────  server.js (authoritative)
                                                          holds ONE game state
                                                          via taroky-engine.js
                                                          fills empty seats w/ bots
```

**Server-authoritative** is essential here because Taroky has hidden information
(each player's hand, the secret partner). The server sends every client only
`viewFor(game, seat)` — their own hand, public table state, and their currently
legal moves. Clients cannot see other hands, and the partner stays hidden until
the called card is played. Every action is validated by the engine; illegal or
out-of-turn actions are rejected.

## The engine API (taroky-engine.js)

```js
const T = require('./taroky-engine');
let g = T.createGame({ seats: ['Ada','Bo','Cy','Di'] }); // 4 names/ids, 100 chips each
T.newDeal(g);                                            // deal a hand -> phase 'bidding'
T.applyAction(g, seat, action);   // -> { ok, error? }   validate + mutate
T.viewFor(g, seat);               // -> redacted view for that seat
T.aiAction(g, seat);              // -> a suggested action for a bot seat (or null)
```

Seats are indices **0–3 in counter-clockwise order of play**; the forehand
rotates each deal. Actions and phases are documented in `PROTOCOL.md`.

## Rules implemented (all in the engine)

- 54-card deck; follow-suit / must-trump; counter-clockwise play.
- Bidding: **draw-4 < Žebrák < Pané+XX < For-three** (one pass, highest wins).
- Draw-4: talon 4+1+1, secret partner = holder of the **XIX** (or the next-lower
  trump the forehand lacks); if the forehand draws the called trump from the
  talon → **play solo** or **throw in** (pay 2 each, redeal).
- **Žebrák** (beggar): no talon, must-overtake, ±16 each, hand ends the instant
  the beggar takes a trick.
- **Pané + XX**: talon → defenders' pile, partner = XX holder (solo if XX is
  buried or the caller holds it), game value `2 + ⌈(winner−53)/3.33⌉`.
- **For-three**: solo talon shop — 1st hand (×1) / 2nd (×2) / 3rd (×3, on a
  **loss**); rejected talon revealed; `/3.33` value.
- Collections (everyone pays the caller): Hrubá 4, Taroky 2, Bída 2, Uni 4,
  Pání 2. **Pagát ultimo** ±4; uncalled Pagát on the last trick ±2.
- **Contra** ×2 / **Rey** ×4 on the standard payout (not Žebrák, not pagát);
  **Contra-pagát** ×2 on a pagát ultimo. **Valat** (all 12 tricks) = value 20.
- Settlement is team-size-aware (2v2 pool, solo pays/collects from all three)
  and always chip-conservative (verified by `smoke-test.js`).

## Wiring the existing UI

`../Taroky.dc.html` currently owns the rules in its `Component` class. To go
online, keep the **visuals** and replace the local mutators with `client-net.js`
sends, rendering from the server `view` instead of local state (see the mapping
comment at the top of `client-net.js`). Rotate the table so `view.you` is at the
bottom. Because the engine is the same code, you can also run it client-side for
optimistic prediction if you want zero input latency.

## Production checklist (not included — deliberately)

This is a clean reference, not a hardened service. Before shipping add:

- **Identity & auth** (accounts or signed guest tokens) and **reconnect tokens**
  so a dropped player resumes their seat instead of being replaced by a bot.
- **Persistence**: move room/game state to Redis or a DB; the reference keeps it
  in memory (lost on restart, single process only).
- **Scaling**: sticky-route a room to one process, or centralize state in Redis.
- **Anti-cheat/rate-limiting**: the server already never trusts client state, but
  add message rate limits and input schemas (e.g. `zod`).
- **Spectators, chat, timeouts** (auto-play or forfeit on a turn clock).
- **Packaging as a native desktop app** (your other ask): wrap
  `../Taroky-standalone.html` — or an online build — in **Tauri** or **Electron**
  (`electron .` / `tauri build`) to produce a real installer. The standalone file
  already runs offline; the wrapper just gives it a window and an icon.

## License

MIT — do what you like.
