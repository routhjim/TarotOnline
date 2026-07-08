# Taroky wire protocol

Transport: **WebSocket**, one JSON object per message. The server is
authoritative — clients send **actions**, never state, and receive **redacted
views** (a player only ever sees their own hand).

## Client → Server

| type | fields | when |
|------|--------|------|
| `join` | `roomId`, `name`, `seat?` | on connect. `seat` is an optional 0–3 request; server assigns the first free seat otherwise. |
| `start` | — | deal the next hand (allowed while `phase` is `idle` or `scoring`). |
| `action` | `action: {…}` | make a move as your seat (see below). |

### `action` payloads (validated by the engine)

| `action.type` | fields | legal during phase |
|---------------|--------|--------------------|
| `bid` | `level` (0 pass/draw-4, 1 Žebrák, 2 Pané, 3 For-three) | `bidding`, when `bidSeat === you` |
| `talonHand` | `choice`: `keep1` \| `swap` \| `keep2` \| `back` | `talonHand` (For-three caller) |
| `talonChoice` | `choice`: `solo` \| `throwin` | `talonChoice` (draw-4 caller drew the XIX) |
| `discard` | `cardIds: string[]` (exactly the required count) | `discard`, if you owe a discard |
| `declare` | `bonuses: string[]`, `ultimo: bool`, `contra: bool`, `rey: bool`, `pagatContra: bool` | `declare` — **every** seat submits exactly one |
| `play` | `cardId: string` | `playing`, when `turn === you` |
| `nextDeal` | — | `scoring` |

`declare` is the post-discard window: each player submits their collections
(`bonuses` — the engine keeps only the ones you actually hold), optional
`ultimo` (needs the Pagát I), `contra` (a defender doubling the payout),
`rey` (declaring side re-doubling after a contra), and `pagatContra`
(an opponent doubling a called pagát ultimo). Play begins once all four have
submitted.

## Server → Client

| type | fields |
|------|--------|
| `joined` | `roomId`, `seat`, `seats` (names) |
| `state` | `view` — the redacted game view for your seat (see below) |
| `reject` | `error`, `action` (your action was illegal / out of turn) |
| `error` | `error` (protocol-level problem) |

### The `view` object (`viewFor(game, seat)`)

```jsonc
{
  "you": 2, "deal": 3, "phase": "playing", "forehand": 1, "turn": 2,
  "mode": "draw4", "declarer": 1,
  "partner": null,            // stays null until the called card is played
  "solo": false, "calledLabel": "XIX",
  "contra": null, "rey": false, "pagatContra": false, "pagatUltimo": null,
  "players": [ { "seat":0,"name":"North","chips":104,"cards":6 }, … ],
  "hand": [ { "id":"t21","kind":"trump","label":"XXI","strength":21,"points":5,"honour":true }, … ],
  "trick": [ { "seat":1,"card":{…} }, … ],
  "leader": 1, "bid": {"level":0,"seat":1}, "bidSeat": null,
  "declPending": [], "bonuses": [ {"seat":0,"type":"tarocy","value":2} ],
  "legal": ["t3","h4"],       // card ids you may legally play right now
  "result": null,             // populated only in the scoring phase
  "log": [ … last 20 events … ]
}
```

Hidden information the server withholds from a view: other players' `hand`
arrays (only counts are sent), and `partner` until the called trump is played.
When `phase === "talonHand"` and you are the caller, `view.f3Showing` holds the
three cards currently offered. Rejected talon cards that become public appear in
`view.revealedTalon`.

## Turn flow (one hand)

```
newDeal → bidding → { draw4 | zebrak | pane | forthree }
  draw4:    → discard → [talonChoice if XIX in talon] → declare → playing → scoring
  forthree: → talonHand → discard → declare → playing → scoring
  pane:     → declare → playing → scoring
  zebrak:   → playing → scoring        (no talon, no declarations)
scoring → (nextDeal) → newDeal …   forehand rotates each deal
```
