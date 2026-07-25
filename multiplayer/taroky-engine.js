/*
 * taroky-engine.js — authoritative, UI-agnostic rules engine for Czech Taroky.
 *
 * Pure logic: no DOM, no React, no timers. Runs identically in Node (server) and
 * the browser (for local prediction / AI). The server owns the ONE real state;
 * clients receive redacted views via viewFor().
 *
 * Usage:
 *   const T = require('./taroky-engine');           // Node
 *   let g = T.createGame({ seats: ['Ada','Bo','Cy','Di'], rng: Math.random });
 *   const res = T.applyAction(g, seatIndex, { type:'bid', level:0 });
 *   const view = T.viewFor(g, seatIndex);            // hides other hands
 *   const bot  = T.aiAction(g, seatIndex);           // suggest an action for a bot seat
 *
 * Seats are indices 0..3 in COUNTER-CLOCKWISE order of play. Seat 0 is the first
 * forehand of the match; the forehand rotates each deal. The client maps seat
 * indices to table positions however it likes.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // Node
  else root.TarokyEngine = api;                                             // browser
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- constants ----------
  const SEATS = [0, 1, 2, 3];
  const next = (i) => (i + 1) % 4;
  const orderFrom = (i) => [i, next(i), next(next(i)), next(next(next(i)))];

  function roman(n) {
    const map = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let r = '', x = n;
    for (const [v, s] of map) while (x >= v) { r += s; x -= v; }
    return r;
  }

  // ---------- deck ----------
  function buildDeck() {
    const d = [];
    for (let v = 1; v <= 21; v++) {
      const honour = v === 1 || v === 21;
      d.push({ id: 't' + v, kind: 'trump', label: roman(v), strength: v, points: honour ? 5 : 1, honour });
    }
    d.push({ id: 'tsk', kind: 'trump', label: 'Sk', strength: 22, points: 5, honour: true }); // Skýz, top trump
    // red suits: K,Q,C,J,4,3,2,1  |  black suits: K,Q,C,J,10,9,8,7
    const red = [['K', 8, 5], ['Q', 7, 4], ['C', 6, 3], ['J', 5, 2], [4, 4, 1], [3, 3, 1], [2, 2, 1], [1, 1, 1]];
    const blk = [['K', 8, 5], ['Q', 7, 4], ['C', 6, 3], ['J', 5, 2], [10, 4, 1], [9, 3, 1], [8, 2, 1], [7, 1, 1]];
    const mk = (suit, rows) => rows.forEach((r) => {
      const court = typeof r[0] === 'string';
      d.push({ id: suit[0] + r[0], kind: 'suit', suit, court: court ? r[0] : null, pip: court ? null : r[0], label: '' + r[0], str: r[1], points: r[2] });
    });
    mk('hearts', red); mk('diamonds', red); mk('spades', blk); mk('clubs', blk);
    return d;
  }

  function shuffle(a, rng) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor((rng || Math.random)() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const isTrump = (c) => c.kind === 'trump';
  const strengthOf = (c) => (c.kind === 'trump' ? c.strength : c.str);

  // ---------- bonuses / collections ----------
  const BONUS = {
    hrube:  { name: 'Hrubá', test: (t) => t >= 10,          val: 4 },
    tarocy: { name: 'Taroky', test: (t) => t === 8 || t === 9, val: 2 },
    bite:   { name: 'Bída',  test: (t) => t === 1 || t === 2, val: 2 },
    uni:    { name: 'Uni',   test: (t) => t === 0,          val: 4 },
    // "Marci Mode" extras — optional collections, enabled per table
    queenos:  { name: 'Quatros Queenos',  val: 3, marci: true },
    horsemen: { name: 'Herd of Horsemen', val: 2, marci: true },
    cluks:    { name: 'Clump of Cluks',   val: 1, marci: true },
    sixpack:  { name: 'Six Pack',         val: 2, marci: true },
    // pawnee (Pání) is honours-based, evaluated separately
  };
  // longest run of consecutive trumps in a hand (Skýz sits at 22, right above the Mond)
  function longestTrumpRun(hand) {
    const s = hand.filter(isTrump).map((c) => c.strength).sort((a, b) => a - b);
    let best = 0, run = 0, prev = null;
    for (const v of s) { run = (prev != null && v === prev + 1) ? run + 1 : 1; prev = v; if (run > best) best = run; }
    return best;
  }
  function evalBonuses(hand, marci) {
    const t = hand.filter(isTrump).length;
    const fp = hand.filter((c) => c.points === 5).length;
    const out = [];
    for (const key of ['hrube', 'tarocy', 'bite', 'uni']) if (BONUS[key].test(t)) out.push({ type: key, value: BONUS[key].val });
    const kings = hand.filter((c) => c.court === 'K').length;
    if (kings === 4) out.push({ type: 'rosanna', value: 4 });     // all four Kings — supersedes Pání
    else if (fp >= 4) out.push({ type: 'pawnee', value: 2 });
    // Trul: holds Pagát (I), Mond (XXI) and Skýz (22)
    if (hand.some((c) => isTrump(c) && c.strength === 1) && hand.some((c) => isTrump(c) && c.strength === 21) && hand.some((c) => isTrump(c) && c.strength === 22)) out.push({ type: 'trul', value: 2 });
    if (marci) {
      const courts = (r) => hand.filter((c) => c.court === r).length === 4;
      if (courts('Q')) out.push({ type: 'queenos', value: 3 });    // all four Queens
      if (courts('C')) out.push({ type: 'horsemen', value: 2 });   // all four Cavaliers/Knights
      if (courts('J')) out.push({ type: 'cluks', value: 1 });      // all four Jacks
      if (longestTrumpRun(hand) >= 6) out.push({ type: 'sixpack', value: 2 }); // 6+ consecutive trumps
    }
    return out;
  }

  // ---------- game creation ----------
  // opts: { seats:[name,name,name,name], rng?, chips?, forehand?, dealer?, aiLevel?:'novice'|'advanced' }
  function createGame(opts) {
    opts = opts || {};
    return {
      players: (opts.seats || [0, 1, 2, 3]).map((n, i) => ({ seat: i, name: '' + n, chips: opts.chips || 100 })),
      rng: opts.rng || Math.random,
      forehand: opts.forehand != null ? opts.forehand : 0,
      deal: 0,
      aiLevel: ['advanced', 'expert', 'insane', 'synthetic', 'hybrid'].includes(opts.aiLevel) ? opts.aiLevel : 'novice',
      marci: !!opts.marci,        // Marci Mode: the extra optional collections are live at this table
      phase: 'idle',
      log: [],
      result: null,          // set in scoring phase
    };
  }

  // Start (or re-deal) a hand. Mutates g, returns g.
  function newDeal(g) {
    const fore = g.deal === 0 ? g.forehand : next(g.forehand);
    const deck = shuffle(buildDeck(), g.rng);
    const hands = [[], [], [], []];
    let k = 0;
    for (const s of SEATS) { hands[s] = sortHand(deck.slice(k, k + 12)); k += 12; }
    Object.assign(g, {
      deal: g.deal + 1, forehand: fore, phase: 'bidding',
      hands, talon: deck.slice(48, 54), trick: [], lastTrick: null, leader: null, turn: null, playLog: [], trickHistory: [],
      mode: null, declarer: null, partner: null, solo: false,
      calledStrength: null, calledLabel: '', calledId: null, revealedPartner: false,
      captured: { decl: [], def: [] }, discardPile: [[], [], [], []], tricksWon: { decl: 0, def: 0 },
      bonuses: [], pagatUltimo: null, pagatLast: null, contra: null, rey: false, reyBy: null, pagatContra: false,
      f3: { setA: [], setB: [], showing: 'A', hand: 0, mult: 1, revealed: [] },
      // bidding bookkeeping:
      bidOrder: orderFrom(fore), bidIndex: 0, bid: { level: 0, seat: fore }, bidSeat: fore,
      // declare bookkeeping: which seats still owe a declaration submission
      declPending: [], declSubs: {},
      result: null,
    });
    g.log.push({ t: 'deal', forehand: fore });
    return g;
  }

  function sortHand(a) {
    const o = { hearts: 1, diamonds: 2, spades: 3, clubs: 4 };
    return a.slice().sort((x, y) => {
      const gx = isTrump(x) ? 0 : o[x.suit], gy = isTrump(y) ? 0 : o[y.suit];
      if (gx !== gy) return gx - gy;
      const sx = isTrump(x) ? x.strength : -x.str, sy = isTrump(y) ? y.strength : -y.str;
      return sx - sy;
    });
  }

  // ---------- trick evaluation ----------
  function valueInTrick(card, led) {
    const ledTrump = isTrump(led);
    if (isTrump(card)) return 1000 + card.strength;
    if (!ledTrump && card.suit === led.suit) return card.str;
    return -1;
  }
  function trickWinner(trick) {
    const led = trick[0].card;
    let best = trick[0], bv = valueInTrick(trick[0].card, led);
    for (let i = 1; i < trick.length; i++) {
      const v = valueInTrick(trick[i].card, led);
      if (v > bv) { bv = v; best = trick[i]; }
    }
    return best.seat;
  }
  function teamOf(g, seat) { return (seat === g.declarer || seat === g.partner) ? 'decl' : 'def'; }

  // Legal moves for a seat given the current trick (mode-aware).
  function legalMoves(g, seat) {
    const hand = g.hands[seat] || [];
    if (g.trick.length === 0) return hand.slice();
    const led = g.trick[0].card;
    if (g.mode === 'zebrak') {
      // must-overtake: if you can beat the current winner, you must
      const cw = trickWinner(g.trick);
      const cwVal = valueInTrick(g.trick.find((x) => x.seat === cw).card, led);
      let pool;
      if (isTrump(led)) { const t = hand.filter(isTrump); pool = t.length ? t : hand.slice(); }
      else { const f = hand.filter((c) => c.kind === 'suit' && c.suit === led.suit); pool = f.length ? f : hand.slice(); }
      const beat = pool.filter((c) => valueInTrick(c, led) > cwVal);
      return beat.length ? beat : pool;
    }
    // standard: follow suit, else must trump if void
    if (isTrump(led)) { const t = hand.filter(isTrump); return t.length ? t : hand.slice(); }
    const f = hand.filter((c) => c.kind === 'suit' && c.suit === led.suit);
    if (f.length) return f;
    const t = hand.filter(isTrump);
    return t.length ? t : hand.slice();
  }

  // ======================================================================
  //  ACTIONS
  //  applyAction(g, seat, action) -> { ok:boolean, error?:string }
  //  action.type: 'bid' | 'talonHand' | 'talonChoice' | 'discard' |
  //               'declare' | 'play' | 'nextDeal'
  // ======================================================================
  function applyAction(g, seat, a) {
    try {
      switch (a.type) {
        case 'bid':          return bid(g, seat, a.level);
        case 'talonHand':    return talonHand(g, seat, a.choice);      // 'keep1' | 'swap' | 'keep2' | 'back'
        case 'talonChoice':  return talonChoice(g, seat, a.choice);    // 'solo' | 'throwin'
        case 'discard':      return discard(g, seat, a.cardIds);
        case 'declare':      return declare(g, seat, a);               // {bonuses:[], ultimo:bool, contra:bool, rey:bool, pagatContra:bool}
        case 'play':         return play(g, seat, a.cardId);
        case 'nextDeal':     if (g.phase !== 'idle' && g.phase !== 'scoring') return { ok: false, error: 'hand in progress' }; newDeal(g); return { ok: true };
        default:             return { ok: false, error: 'unknown action ' + a.type };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ---- bidding (one pass; priority draw4=0 < zebrak=1 < pane=2 < forthree=3) ----
  function bid(g, seat, level) {
    if (g.phase !== 'bidding') return { ok: false, error: 'not bidding' };
    if (seat !== g.bidSeat) return { ok: false, error: 'not your turn to bid' };
    if (level > 0) {
      if (level <= g.bid.level) return { ok: false, error: 'must raise above current bid' };
      if (level === 2) { // Pané requires Páni (4+ five-point cards)
        const fp = g.hands[seat].filter((c) => c.points === 5).length;
        if (fp < 4) return { ok: false, error: 'Pané needs 4+ honours (Páni)' };
      }
      g.bid = { level, seat };
      g.log.push({ t: 'bid', seat, level });
    } else {
      g.log.push({ t: 'pass', seat });
    }
    g.bidIndex++;
    if (g.bidIndex >= 4) { resolveBid(g); }
    else { g.bidSeat = g.bidOrder[g.bidIndex]; }
    return { ok: true };
  }

  function resolveBid(g) {
    const lvl = g.bid.level;
    g.mode = lvl === 0 ? 'draw4' : lvl === 1 ? 'zebrak' : lvl === 2 ? 'pane' : 'forthree';
    g.declarer = g.bid.seat;
    g.bidSeat = null;
    if (g.mode === 'draw4') setupDraw4(g);
    else if (g.mode === 'zebrak') setupZebrak(g);
    else if (g.mode === 'pane') setupPane(g);
    else setupForThree(g);
  }

  // ---- draw4 ----
  function setupDraw4(g) {
    const fore = g.forehand, dh = g.hands[fore];
    const hasV = (v) => dh.some((c) => isTrump(c) && c.strength === v);
    let call = 19;
    if (hasV(19)) for (let v = 18; v >= 1; v--) if (!hasV(v)) { call = v; break; }
    g.calledStrength = call; g.calledLabel = roman(call);
    const ord = orderFrom(fore), talon = g.talon;
    g.hands[ord[0]] = g.hands[ord[0]].concat(talon.slice(0, 4));
    g.hands[ord[1]] = g.hands[ord[1]].concat([talon[4]]);
    g.hands[ord[2]] = g.hands[ord[2]].concat([talon[5]]);
    g.discardNeed = [0, 0, 0, 0];
    g.discardNeed[ord[0]] = 4; g.discardNeed[ord[1]] = 1; g.discardNeed[ord[2]] = 1;
    for (const s of SEATS) g.hands[s] = sortHand(g.hands[s]);
    // who still needs to discard?
    g.discardWaiting = SEATS.filter((s) => g.discardNeed[s] > 0);
    g.phase = 'discard';
  }

  // ---- zebrák ----
  function setupZebrak(g) {
    g.solo = true; g.partner = null; g.calledId = null;
    g.captured = { decl: [], def: [] };
    enterDeclare(g); // zebrák skips collections (none) — enterDeclare will fast-forward
  }

  // ---- pané + XX ----
  function setupPane(g) {
    const decl = g.declarer;
    let xx = null;
    for (const s of SEATS) { const f = g.hands[s].find((c) => isTrump(c) && c.strength === 20); if (f) { xx = s; g.calledId = f.id; break; } }
    g.partner = (xx != null && xx !== decl) ? xx : null;
    g.solo = g.partner == null;
    g.calledStrength = 20; g.calledLabel = 'XX';
    g.captured = { decl: [], def: g.talon.slice() }; // talon -> defenders' pile
    enterDeclare(g);
  }

  // ---- for three ----
  function setupForThree(g) {
    g.solo = true; g.partner = null; g.calledId = null;
    g.f3 = { setA: g.talon.slice(0, 3), setB: g.talon.slice(3, 6), showing: 'A', hand: 0, mult: 1, revealed: [] };
    g.phase = 'talonHand';
    g.turn = g.declarer;
  }
  function talonHand(g, seat, choice) {
    if (g.phase !== 'talonHand') return { ok: false, error: 'not talon-hand phase' };
    if (seat !== g.declarer) return { ok: false, error: 'only the caller chooses' };
    const f = g.f3;
    if (choice === 'swap') { if (f.showing !== 'A' || f.swapped) return { ok: false, error: 'nothing to swap' }; f.showing = 'B'; f.swapped = true; f.revealed = f.setA.slice(); return { ok: true }; } // rejected first three are public immediately
    let keep, mult, revealed, handNum;
    if (choice === 'keep1') { if (f.showing !== 'A') return { ok: false, error: 'first hand no longer available' }; keep = 'A'; mult = 1; handNum = 1; revealed = []; }
    else if (choice === 'keep2') { if (f.showing !== 'B') return { ok: false, error: 'second hand not drawn' }; keep = 'B'; mult = 2; handNum = 2; revealed = f.setA.slice(); }
    else if (choice === 'back') { if (f.showing !== 'B') return { ok: false, error: 'cannot go back — second hand not drawn' }; keep = 'A'; mult = 3; handNum = 3; revealed = f.setA.concat(f.setB); } // both rejected sets are public
    else return { ok: false, error: 'bad choice' };
    const keepSet = keep === 'A' ? f.setA : f.setB;
    const unused = keep === 'A' ? f.setB : f.setA;
    g.hands[g.declarer] = sortHand(g.hands[g.declarer].concat(keepSet));
    f.hand = handNum; f.mult = mult; f.revealed = revealed;
    g.captured = { decl: [], def: unused.slice() };
    g.discardNeed = [0, 0, 0, 0]; g.discardNeed[g.declarer] = 3;
    g.discardWaiting = [g.declarer];
    g.phase = 'discard';
    return { ok: true };
  }

  // ---- discard ----
  function discard(g, seat, cardIds) {
    if (g.phase !== 'discard') return { ok: false, error: 'not discard phase' };
    const need = g.discardNeed[seat] || 0;
    if (need === 0) return { ok: false, error: 'you have nothing to discard' };
    if (!g.discardWaiting.includes(seat)) return { ok: false, error: 'already discarded' };
    if (!cardIds || cardIds.length !== need) return { ok: false, error: 'discard exactly ' + need };
    const set = new Set(cardIds);
    const chosen = g.hands[seat].filter((c) => set.has(c.id));
    if (chosen.length !== need) return { ok: false, error: 'card not in hand' };
    if (chosen.some((c) => c.honour || c.court === 'K')) return { ok: false, error: 'cannot discard Kings or the three honours' };
    g.hands[seat] = sortHand(g.hands[seat].filter((c) => !set.has(c.id)));
    g.discardPile[seat] = chosen;
    g.discardWaiting = g.discardWaiting.filter((s) => s !== seat);
    if (g.discardWaiting.length === 0) afterDiscard(g);
    return { ok: true };
  }

  function afterDiscard(g) {
    if (g.mode === 'draw4') {
      // find who holds the called trump
      let holder = null;
      for (const s of SEATS) { const f = g.hands[s].find((c) => isTrump(c) && c.strength === g.calledStrength); if (f) { g.calledId = f.id; holder = s; break; } }
      if (holder === g.declarer) {
        // XIX drawn into declarer's own hand -> solo or throw-in (declarer decides)
        g.phase = 'talonChoice'; g.turn = g.declarer; return;
      }
      finishDraw4(g, holder);
    } else if (g.mode === 'forthree') {
      // caller's 3 discards go to their own (declaring) pile
      g.captured.decl = g.captured.decl.concat(g.discardPile[g.declarer]);
      enterDeclare(g);
    }
  }

  function talonChoice(g, seat, choice) {
    if (g.phase !== 'talonChoice') return { ok: false, error: 'not talon-choice phase' };
    if (seat !== g.declarer) return { ok: false, error: 'only the caller chooses' };
    if (choice === 'solo') { finishDraw4(g, null); return { ok: true }; }
    if (choice === 'throwin') {
      // pay 2 to each opponent, abandon the deal
      const delta = [0, 0, 0, 0];
      for (const s of SEATS) if (s !== g.declarer) { delta[s] += 2; delta[g.declarer] -= 2; }
      commitChips(g, delta);
      g.result = { kind: 'throwin', text: 'threw in the hand (XIX in talon)', delta, lines: ['Declarer threw in — paid 2 to each'] };
      g.phase = 'scoring';
      return { ok: true };
    }
    return { ok: false, error: 'bad choice' };
  }

  function finishDraw4(g, partner) {
    g.partner = partner; g.solo = partner == null;
    const cap = { decl: [], def: [] };
    for (const s of SEATS) { const dd = g.discardPile[s] || []; if (dd.length) cap[teamOf(g, s)] = cap[teamOf(g, s)].concat(dd); }
    g.captured = cap;
    enterDeclare(g);
  }

  // ---- declarations: collections + contra/rey + contra-pagát ----
  // Declarations happen in stages so contra is an INFORMED decision:
  //   stage 1 — everyone calls collections + pagát ultimo
  //   stage 2 — having seen all calls: defenders may contra, ultimo opponents may contra-pagát
  //   stage 3 — declaring side may rey (only exists if someone contra'd)
  function enterDeclare(g) {
    if (g.mode === 'zebrak') { enterPlay(g); return; }
    g.declStage = 1;
    g.declPending = SEATS.slice();
    g.declSubs = {};
    g.phase = 'declare';
  }
  function advanceDeclStage(g) {
    if (g.declStage === 1) { g.declStage = 2; g.declPending = SEATS.slice(); return; }   // pagát-ultimo window — everyone is asked so the holder isn't revealed
    if (g.declStage === 2) {
      const elig = SEATS.filter((s) => teamOf(g, s) === 'def' || (g.pagatUltimo != null && teamOf(g, s) !== teamOf(g, g.pagatUltimo)));
      if (elig.length) { g.declStage = 3; g.declPending = elig; return; }
    }
    if (g.declStage <= 3 && g.contra != null) {
      const elig = SEATS.filter((s) => teamOf(g, s) === 'decl');
      if (elig.length) { g.declStage = 4; g.declPending = elig; return; }
    }
    enterPlay(g);
  }
  function declare(g, seat, a) {
    if (g.phase !== 'declare') return { ok: false, error: 'not declare phase' };
    if (!g.declPending.includes(seat)) return { ok: false, error: 'already declared' };
    const hand = g.hands[seat];
    const stage = g.declStage || 1;
    if (stage === 1) {
      // collections — pagát ultimo has its own later window (after all bonuses, before contra)
      const eligible = evalBonuses(hand, g.marci).map((b) => b.type);
      const bonuses = (a.bonuses || []).filter((t) => eligible.includes(t));
      for (const t of bonuses) g.bonuses.push({ seat, type: t, value: (t === 'pawnee' || t === 'trul') ? 2 : (t === 'rosanna' ? 4 : BONUS[t].val) });
    } else if (stage === 2) {
      // pagát ultimo (only if you hold Pagát I) — called with every bonus on the table
      if (a.ultimo && hand.some((c) => isTrump(c) && c.strength === 1)) g.pagatUltimo = seat;
    } else if (stage === 3) {
      // contra: a defender doubles the standard payout (not on zebrák) — with all declarations visible
      if (a.contra && teamOf(g, seat) === 'def' && g.contra == null) g.contra = seat;
      // contra-pagát: an opponent of the ultimo caller doubles the pagát stake
      if (a.pagatContra && g.pagatUltimo != null && teamOf(g, seat) !== teamOf(g, g.pagatUltimo)) g.pagatContra = true;
    } else {
      // rey: declaring side re-doubles after a contra
      if (a.rey && teamOf(g, seat) === 'decl' && g.contra != null && !g.rey) { g.rey = true; g.reyBy = seat; }
    }
    g.declSubs[seat] = a;
    g.declPending = g.declPending.filter((s) => s !== seat);
    if (g.declPending.length === 0) advanceDeclStage(g);
    return { ok: true };
  }

  function enterPlay(g) {
    g.leader = g.mode === 'zebrak' ? g.declarer : g.forehand;
    g.turn = g.leader;
    g.trick = [];
    g.phase = 'playing';
  }

  // ---- play a card ----
  function play(g, seat, cardId) {
    if (g.phase !== 'playing') return { ok: false, error: 'not in play' };
    if (seat !== g.turn) return { ok: false, error: 'not your turn' };
    const card = g.hands[seat].find((c) => c.id === cardId);
    if (!card) return { ok: false, error: 'card not in hand' };
    if (!legalMoves(g, seat).some((c) => c.id === cardId)) return { ok: false, error: 'illegal card' };
    if (g.trick.length === 0) g.lastTrick = null; // starting a new trick clears the held one
    g.hands[seat] = g.hands[seat].filter((c) => c.id !== cardId);
    // public play history — fuels the advanced AI's card counting & void inference
    const ledCard = g.trick.length ? g.trick[0].card : card;
    (g.playLog || (g.playLog = [])).push({ seat, key: isTrump(card) ? 'T' : card.suit, led: isTrump(ledCard) ? 'T' : ledCard.suit, str: strengthOf(card), pts: card.points });
    g.trick.push({ seat, card });
    if (g.calledId && card.id === g.calledId && g.mode !== 'zebrak') g.revealedPartner = true;
    if (g.trick.length < 4) { g.turn = next(seat); return { ok: true }; }
    resolveTrick(g);
    return { ok: true };
  }

  function resolveTrick(g) {
    const win = trickWinner(g.trick);
    // Preserve the completed trick so clients can show it before it clears.
    g.lastTrick = { cards: g.trick.slice(), winner: win, seq: (g.trickSeq = (g.trickSeq || 0) + 1) };
    // full public record of the deal, for the end-of-hand review
    (g.trickHistory || (g.trickHistory = [])).push({ cards: g.trick.slice(), winner: win });
    const empty = g.hands[0].length === 0 && g.hands[1].length === 0 && g.hands[2].length === 0 && g.hands[3].length === 0;
    if (g.mode === 'zebrak') {
      g.trick = []; g.leader = win; g.turn = win;
      if (win === g.declarer) { scoreZebrak(g, false); return; } // beggar took a trick -> loses immediately
      if (empty) { scoreZebrak(g, true); return; }               // survived all tricks -> wins
      return;
    }
    const t = teamOf(g, win);
    g.captured[t] = g.captured[t].concat(g.trick.map((x) => x.card));
    g.tricksWon[t] = (g.tricksWon[t] || 0) + 1;
    if (empty) { const pe = g.trick.find((x) => isTrump(x.card) && x.card.strength === 1); if (pe) g.pagatLast = { seat: pe.seat, won: win === pe.seat }; }
    g.trick = []; g.leader = win; g.turn = win;
    if (empty) scoreHand(g);
  }

  // ---------- settlement ----------
  const sum = (arr) => arr.reduce((t, c) => t + c.points, 0);
  function settleGame(V, winners, losers, delta) {
    if (winners.length === 2 && losers.length === 2) { winners.forEach((s) => delta[s] += V); losers.forEach((s) => delta[s] -= V); return; }
    const wSolo = winners.length === 1;
    const solo = wSolo ? winners[0] : losers[0];
    const others = wSolo ? losers : winners;
    const sign = wSolo ? 1 : -1;
    delta[solo] += sign * V * others.length;
    others.forEach((o) => delta[o] -= sign * V);
  }

  function scoreHand(g) {
    const dp = sum(g.captured.decl), fp = sum(g.captured.def);
    const declTeam = SEATS.filter((s) => teamOf(g, s) === 'decl');
    const defTeam = SEATS.filter((s) => teamOf(g, s) === 'def');
    const declWin = dp > fp;
    const winners = declWin ? declTeam : defTeam, losers = declWin ? defTeam : declTeam;
    const winPts = Math.max(dp, fp);
    const div = (g.mode === 'pane' || g.mode === 'forthree') ? 3.33 : 5;
    const valat = g.tricksWon.decl === 12 || g.tricksWon.def === 12;
    let V = 2 + Math.max(0, Math.ceil((winPts - 53) / div));
    if (valat) V = 20;
    const stakeMult = g.rey ? 4 : (g.contra != null ? 2 : 1);
    const delta = [0, 0, 0, 0], lines = [];
    const nm = (arr) => arr.map((s) => g.players[s].name).join(' & ');
    if (g.contra != null) lines.push(g.rey ? 'Rey — payout ×4' : 'Contra — payout ×2');
    if (valat) lines.push('Valat — all twelve tricks! game value 20');

    if (g.mode === 'forthree') {
      const caller = g.declarer, others = SEATS.filter((s) => s !== caller);
      if (declWin) { delta[caller] += 3 * V * stakeMult; others.forEach((o) => delta[o] -= V * stakeMult); lines.push(nm([caller]) + ' — For three WON (' + (V * stakeMult) + ' each)'); }
      else { const m = g.f3.mult; delta[caller] -= 3 * V * m * stakeMult; others.forEach((o) => delta[o] += V * m * stakeMult); lines.push(nm([caller]) + ' — For three LOST' + (m > 1 ? ' (hand ' + g.f3.hand + ', ×' + m + ')' : '') + ' (' + (V * m * stakeMult) + ' each)'); }
    } else {
      settleGame(V * stakeMult, winners, losers, delta);
      lines.push(nm(winners) + ' take the deal — game value ' + (V * stakeMult));
    }

    // collections: everyone pays the caller
    g.bonuses.forEach((b) => {
      SEATS.forEach((s) => delta[s] += (s === b.seat ? 3 * b.value : -b.value));
      lines.push(g.players[b.seat].name + ' · ' + bonusName(b.type) + ' +' + (3 * b.value));
    });

    // pagát ultimo (± via settle; not affected by contra/rey, but by contra-pagát)
    if (g.pagatUltimo != null) {
      const c = g.pagatUltimo, ct = teamOf(g, c);
      const w = SEATS.filter((s) => teamOf(g, s) === ct), l = SEATS.filter((s) => teamOf(g, s) !== ct);
      const ok = g.pagatLast && g.pagatLast.seat === c && g.pagatLast.won;
      const pm = g.pagatContra ? 2 : 1;
      if (ok) { settleGame(4 * pm, w, l, delta); lines.push(g.players[c].name + ' · Pagát ultimo WON +' + (4 * pm) + (pm > 1 ? ' (contra pagát)' : '')); }
      else { settleGame(4 * pm, l, w, delta); lines.push(g.players[c].name + ' · Pagát ultimo failed −' + (4 * pm) + (pm > 1 ? ' (contra pagát)' : '')); }
    } else if (g.pagatLast) { // uncalled Pagát played on the last trick: ±2
      const s0 = g.pagatLast.seat, tt = teamOf(g, s0);
      const w = SEATS.filter((s) => teamOf(g, s) === tt), l = SEATS.filter((s) => teamOf(g, s) !== tt);
      if (g.pagatLast.won) { settleGame(2, w, l, delta); lines.push('Pagát won the last trick +2'); }
      else { settleGame(2, l, w, delta); lines.push('Pagát fell on the last trick −2'); }
    }

    commitChips(g, delta);
    g.result = { kind: 'hand', declPoints: dp, defPoints: fp, winnerNames: nm(winners), delta, lines: lines.filter(Boolean) };
    g.phase = 'scoring';
  }

  function scoreZebrak(g, success) {
    const z = g.declarer, others = SEATS.filter((s) => s !== z);
    const delta = [0, 0, 0, 0], lines = [];
    if (success) { delta[z] += 48; others.forEach((o) => delta[o] -= 16); lines.push(g.players[z].name + ' — Žebrák WON (+16 from each)'); }
    else { delta[z] -= 48; others.forEach((o) => delta[o] += 16); lines.push(g.players[z].name + ' — Žebrák LOST (−16 to each)'); }
    commitChips(g, delta);
    g.result = { kind: 'zebrak', success, delta, lines };
    g.phase = 'scoring';
  }

  function commitChips(g, delta) { SEATS.forEach((s) => g.players[s].chips += delta[s]); }
  function bonusName(t) { return t === 'pawnee' ? 'Pání' : t === 'trul' ? 'Trul' : t === 'rosanna' ? 'Rosanna' : (BONUS[t] ? BONUS[t].name : t); }

  // ======================================================================
  //  REDACTED VIEW  (what one seat is allowed to see)
  // ======================================================================
  function viewFor(g, seat) {
    const v = {
      you: seat, deal: g.deal, phase: g.phase, forehand: g.forehand, turn: g.turn,
      marci: !!g.marci,
      mode: g.mode, declarer: g.declarer,
      // partner hidden until the called card is played (or scoring)
      partner: (g.revealedPartner || g.phase === 'scoring') ? g.partner : null,
      // solo is a DISCOVERED fact, not an announcement: public only for inherently solo contracts
      // (žebrák, for-three), once the called card falls, at scoring — or to the solo player himself.
      solo: (g.mode === 'zebrak' || g.mode === 'forthree' || g.revealedPartner || g.phase === 'scoring' || seat === g.declarer) ? g.solo : false,
      calledLabel: g.calledLabel, aiLevel: g.aiLabel || g.aiLevel || 'novice',
      contra: g.contra, rey: g.rey, reyBy: (g.reyBy != null ? g.reyBy : null), pagatContra: g.pagatContra, pagatUltimo: g.pagatUltimo,
      players: g.players.map((p) => ({ seat: p.seat, name: p.name, chips: p.chips, cards: g.hands ? g.hands[p.seat].length : 0 })),
      hand: g.hands ? g.hands[seat] : [],
      trick: g.trick, lastTrick: g.lastTrick || null, leader: g.leader,
      trickHistory: g.phase === 'scoring' ? (g.trickHistory || []) : undefined,
      bid: g.bid, bidSeat: g.bidSeat,
      declPending: g.declPending, bonuses: g.bonuses, declStage: g.declStage || 1,
      pagatUltimo: g.pagatUltimo != null ? g.pagatUltimo : null, contraBy: g.contra != null ? g.contra : null,
      result: g.phase === 'scoring' ? g.result : null,
      log: g.log.slice(-20),
    };
    if (g.phase === 'discard') { v.discardNeed = g.discardNeed ? g.discardNeed[seat] : 0; v.discardWaiting = g.discardWaiting; }
    // the declarer pondering solo-vs-throw-in (drew his own XIX) must look like an ordinary discard pause
    if (g.phase === 'talonChoice' && seat !== g.declarer) { v.phase = 'discard'; v.discardNeed = 0; v.discardWaiting = [g.declarer]; }
    if (g.phase === 'talonHand' && seat === g.declarer) { v.f3Showing = g.f3.showing === 'A' ? g.f3.setA : g.f3.setB; v.f3Set = g.f3.showing; }
    if (g.f3 && g.f3.revealed && g.f3.revealed.length) v.revealedTalon = g.f3.revealed; // rejected talon is public
    if (g.phase === 'talonChoice') v.talonChoiceSeat = g.declarer;
    // what actions can THIS seat legally take right now?
    v.legal = seat === g.turn && g.phase === 'playing' ? legalMoves(g, seat).map((c) => c.id) : [];
    return v;
  }

  // ======================================================================
  //  BASIC AI  (server fills empty seats with bots)
  //  Returns an action object for `seat`, or null if it's not their move.
  // ======================================================================
  const minBy = (a, f) => a.reduce((x, y) => (f(y) < f(x) ? y : x));
  const maxBy = (a, f) => a.reduce((x, y) => (f(y) > f(x) ? y : x));

  // ---------- synthetic AI: Advanced's brain with a tunable weight vector ----------
  // DEFAULT_W reproduces Advanced exactly. SYN_W starts as the EVOLVED weights
  // (paired-seed self-play tournaments vs Advanced) powering aiLevel 'synthetic'.
  const DEFAULT_W = {
    pullMinLen: 4,        // boss-trump pull needs this many trumps
    desperateTricks: 5,   // "late" = this many tricks left
    desperateGap: 24,     // "close" = within this many card points
    feedPtsW: 100,        // points-vs-strength weight when feeding the partner
    cheapPtsW: 100,       // points-vs-strength weight when playing cheap
    kingFirstRound: 1,    // risk kings on a suit's first round (0/1)
    pagatShed: 1,         // shed the pagat onto the partner's winning trick (0/1)
    soloHold: 60,         // pitch penalty for suits a solo opponent still follows
    trumpSpendPen: 400,   // reluctance to spend a trump when a suit card wins
    despTrickPts: 3,      // desperate: trick points that justify the surest winner
    hammerLen: 1,         // keep leading trumps after own Taroky/Hrubá (0/1)
    keepBoss: 1,          // never feed away a boss trump (0/1)
    f3A: 10, f3B: 9, f3C: 8,   // for-three bid: raw trumps / trumps with 2 honours / with top2+king
    contraA: 9, contraB: 8, contraC: 6, // contra: raw trumps / with 3 fives / with 2 voids+XX
    reyTr: 10,            // rey answer: trump count
    pagatContraTr: 7,     // contra a pagat-ultimo call: trump count
    paneTr: 5,            // pané bid: minimum trumps alongside the Pání
  };
  let SYN_W = Object.assign({}, DEFAULT_W, {
    // EVOLVED weights — 18 generations of paired-seed self-play vs Advanced
    // (960-deal evals), validated at +18.2 chips/100 deals on 3,200 unseen deals.
    pullMinLen: 8, feedPtsW: 51, cheapPtsW: 81, pagatShed: 0, soloHold: 26,
    despTrickPts: 2, desperateTricks: 2, desperateGap: 28, trumpSpendPen: 1224,
    kingFirstRound: 0, f3A: 12, f3B: 8, f3C: 7, contraA: 8, contraB: 7, contraC: 9,
    reyTr: 11, pagatContraTr: 7,
  });
  function setSyntheticWeights(w) { SYN_W = Object.assign({}, DEFAULT_W, w || {}); }
  function wOf(g) { return (g.aiLevel === 'synthetic' || g.aiLevel === 'hybrid') ? SYN_W : DEFAULT_W; }

  function aiAction(g, seat) {
    switch (g.phase) {
      case 'bidding':
        if (g.bidSeat !== seat) return null;
        return { type: 'bid', level: aiBidLevel(g, seat) };
      case 'talonHand':
        if (g.declarer !== seat) return null;
        return { type: 'talonHand', choice: 'keep1' }; // bots keep the first three
      case 'talonChoice':
        if (g.declarer !== seat) return null;
        return { type: 'talonChoice', choice: 'solo' };
      case 'discard': {
        if (!g.discardWaiting.includes(seat)) return null;
        const need = g.discardNeed[seat];
        if (g.aiLevel === 'expert' || g.aiLevel === 'insane') {
          const cand = solveDiscard(g, seat);
          if (cand && cand.length === need) return { type: 'discard', cardIds: cand.map((c) => c.id) };
        }
        const pool = g.hands[seat].filter((c) => !c.honour && c.court !== 'K');
        let cand;
        if (g.aiLevel !== 'novice') {
          // discard to CREATE VOIDS: empty the shortest suits first so we can ruff early,
          // then bank HIGH point cards (discards count toward our own pile \u2014 safe points)
          const len = { hearts: 0, diamonds: 0, spades: 0, clubs: 0 };
          for (const c of g.hands[seat]) if (!isTrump(c)) len[c.suit]++;
          cand = pool.slice().sort((a, b) =>
            (isTrump(a) ? 1 : 0) - (isTrump(b) ? 1 : 0) ||           // never break trumps voluntarily
            (isTrump(a) ? 0 : len[a.suit]) - (isTrump(b) ? 0 : len[b.suit]) || // shortest suit first
            b.points - a.points || strengthOf(a) - strengthOf(b)).slice(0, need);
        } else {
          cand = pool.slice().sort((a, b) => (isTrump(a) ? 1 : 0) - (isTrump(b) ? 1 : 0) || a.points - b.points || strengthOf(a) - strengthOf(b)).slice(0, need);
        }
        return { type: 'discard', cardIds: cand.map((c) => c.id) };
      }
      case 'declare': {
        if (!g.declPending.includes(seat)) return null;
        const hand = g.hands[seat];
        const tr = hand.filter(isTrump).length, fp = hand.filter((c) => c.points === 5).length;
        const adv = g.aiLevel !== 'novice';
        const stage = g.declStage || 1;
        if (stage === 1) {
          const bonuses = evalBonuses(hand, g.marci).map((b) => b.type);         // bots declare everything they hold
          return { type: 'declare', bonuses };
        }
        if (stage === 2) return { type: 'declare', ultimo: false };     // bots never stake the ultimo
        if (stage === 3) {
          // informed contra: all stage-1 calls are now public
          const declSideLen = g.bonuses.some((b) => teamOf(g, b.seat) === 'decl' && (b.type === 'taroky' || b.type === 'hrube'));
          const anyLen = g.bonuses.some((b) => b.type === 'taroky' || b.type === 'hrube');
          // suits I am void in — each is a color I can kill with trumps
          const voids = ['hearts', 'diamonds', 'spades', 'clubs'].filter((su) => !hand.some((c) => !isTrump(c) && c.suit === su)).length;
          // novice doubles eagerly; advanced doubles from real strength — a trump wall of my own,
          // or 6+ trumps killing 2+ colors when nobody has declared trump length — never into one
          let contra;
          if ((g.aiLevel === 'expert' || g.aiLevel === 'insane') && teamOf(g, seat) === 'def' && g.contra == null) {
            // hybrid: the trump-counting heuristic is a proven trigger, the solver is a second opinion.
            // (Solver-only proved too shy: its truncated lookahead regresses projections toward 53.)
            const heur = !declSideLen && ((tr >= 9 || (tr >= 8 && fp >= 3)) || (tr >= 6 && voids >= 2 && !anyLen && hand.some((c) => isTrump(c) && c.strength >= 20)));
            contra = heur || (!declSideLen && solveDealValue(g, seat) <= 49);
          } else {
            const W = wOf(g);
            contra = teamOf(g, seat) === 'def' && g.contra == null &&
              (adv ? (!declSideLen && ((tr >= W.contraA || (tr >= W.contraB && fp >= 3)) || (tr >= W.contraC && voids >= 2 && !anyLen && hand.some((c) => isTrump(c) && c.strength >= 20))))
                   : (tr >= 7 || fp >= 4));
          }
          const pagatContra = g.pagatUltimo != null && teamOf(g, seat) !== teamOf(g, g.pagatUltimo) && (adv ? (tr >= wOf(g).pagatContraTr && hand.some((c) => isTrump(c) && c.strength >= 20)) : (tr >= 5));
          return { type: 'declare', contra, pagatContra };
        }
        const rey = teamOf(g, seat) === 'decl' && g.contra != null && !g.rey &&
          ((g.aiLevel === 'expert' || g.aiLevel === 'insane') ? solveDealValue(g, seat) >= 61
           : (adv ? (tr >= wOf(g).reyTr) : (tr >= 8)));
        return { type: 'declare', rey };
      }
      case 'playing':
        if (g.turn !== seat) return null;
        return { type: 'play', cardId: (g.aiLevel === 'insane' ? aiPlayInsane(g, seat)
          // the solver can't read intent: answer a human partner's opening trump signal first
          : g.aiLevel === 'expert' ? (signalPlay(g, seat, aiMemory(g), legalMoves(g, seat)) || aiPlayExpert(g, seat))
          // hybrid: evolved-synthetic play, pivoting to a determinized endgame solve at 4 cards —
          // by then the void map + fallen-card memory constrain the worlds tightly, so 24 samples are cheap and sharp
          : (g.aiLevel === 'hybrid' && g.hands[seat].length <= 4) ? aiPlayExpert(g, seat, 24, 30)
          : (g.aiLevel === 'advanced' || g.aiLevel === 'synthetic' || g.aiLevel === 'hybrid') ? aiPlayAdvanced(g, seat) : aiPlay(g, seat)).id };
      default:
        return null;
    }
  }

  function aiBidLevel(g, seat) {
    const hand = g.hands[seat];
    const tr = hand.filter(isTrump).length, fp = hand.filter((c) => c.points === 5).length;
    const hasK = hand.some((c) => c.court === 'K'), hasQ = hand.some((c) => c.court === 'Q');
    const lvl = g.bid.level;
    if (g.aiLevel !== 'novice') {
      const hi = hand.filter((c) => isTrump(c) && c.strength >= 18).length;   // XVIII+, Mond, Skýz
      const hasJ = hand.some((c) => c.court === 'J');
      const top2 = hand.some((c) => isTrump(c) && c.strength >= 21);           // Mond or Skýz
      const W = wOf(g);
      // For-three is hugely +EV with a trump monster (measured ~95% win at 10 trumps),
      // and still strong at 8 trumps when backed by a top honour and a king
      if ((tr >= W.f3A || (tr >= W.f3B && hi >= 2) || (tr >= W.f3C && top2 && hasK)) && lvl < 3) return 3;
      // Pané: skip when forehand or holding the XIX — those hands usually win the ordinary
      // contract anyway, without the risk of the XX turning up in the talon and forcing a 1v3
      const paneRisky = seat === g.forehand || hand.some((c) => isTrump(c) && c.strength === 19);
      if (fp >= 4 && tr >= W.paneTr && lvl < 2 && !paneRisky) return 2;       // Páni + decent trumps -> Pané
      if (tr === 0 && fp === 0 && !hasK && !hasQ && !hasJ && lvl < 1) return 1; // Žebrák only on a true bust
      return 0;
    }
    if (tr >= 10 && lvl < 3) return 3;                             // monster -> For three
    if (fp >= 4 && tr >= 6 && lvl < 2) return 2;                   // Páni + trumps -> Pané
    if (tr <= 1 && !hasK && !hasQ && fp === 0 && lvl < 1) return 1; // misère hand -> Žebrák
    return 0;                                                      // pass
  }

  function aiPlay(g, seat) {
    const legal = legalMoves(g, seat);
    const str = strengthOf;
    if (g.mode === 'zebrak') {
      const led = g.trick[0] ? g.trick[0].card : null;
      if (seat === g.declarer) { // beggar: duck
        if (!led) return minBy(legal, str);
        const cw = trickWinner(g.trick), cv = valueInTrick(g.trick.find((x) => x.seat === cw).card, led);
        const safe = legal.filter((c) => valueInTrick(c, led) <= cv);
        return safe.length ? maxBy(safe, str) : minBy(legal, str);
      }
      // defender: lead low; take cheaply unless certain (last to play), then dump highest
      if (!led) return minBy(legal, str);
      const cw = trickWinner(g.trick), cv = valueInTrick(g.trick.find((x) => x.seat === cw).card, led);
      const beats = legal.filter((c) => valueInTrick(c, led) > cv);
      if (beats.length) return g.trick.length === 3 ? maxBy(beats, str) : minBy(beats, str);
      return minBy(legal, str);
    }
    // standard trick AI
    if (g.trick.length === 0) { const nt = legal.filter((c) => !isTrump(c)); const pool = nt.length ? nt : legal; return minBy(pool, (c) => c.points * 100 + str(c)); }
    const led = g.trick[0].card, cw = trickWinner(g.trick);
    const cv = valueInTrick(g.trick.find((x) => x.seat === cw).card, led);
    const mine = teamOf(g, seat), wt = teamOf(g, cw), last = g.trick.length === 3;
    const beats = legal.filter((c) => valueInTrick(c, led) > cv);
    if (wt === mine) { if (last) { const safe = legal.filter((c) => valueInTrick(c, led) <= cv); const pool = safe.length ? safe : legal; return maxBy(pool, (c) => c.points); } return minBy(legal, (c) => c.points * 100 + str(c)); }
    if (beats.length) return minBy(beats, (c) => c.points * 100 + str(c) + (isTrump(c) ? 400 : 0));
    return minBy(legal, (c) => c.points * 100 + str(c));
  }

  // ---------- advanced AI: card counting, void inference, partner feeding ----------
  // Everything here is inferred from PUBLIC information only (the play history).
  function aiMemory(g) {
    const voids = [{}, {}, {}, {}];                 // voids[seat][suit|'T'] = true once they failed to follow
    const fallen = new Set();                       // trump strengths already played
    const suitCount = { hearts: 0, diamonds: 0, spades: 0, clubs: 0 };
    const followed = [{}, {}, {}, {}];              // followed[seat][suit] = times they followed that suit
    const trumpsPlayed = [0, 0, 0, 0];
    const maxBelief = [22, 22, 22, 22];             // upper bound on each seat's best remaining trump
    const log = g.playLog || [];
    let winSeat = -1, winKey = null, winStr = 0;
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      if (i % 4 === 0) { winSeat = e.seat; winKey = e.key; winStr = e.str; }
      else {
        // played a trump UNDER the opposing winner on a trump trick: they almost
        // certainly cannot beat it — cap our belief about their best trump
        if (e.key === 'T' && winKey === 'T' && e.str < winStr && teamOf(g, e.seat) !== teamOf(g, winSeat))
          maxBelief[e.seat] = Math.min(maxBelief[e.seat], winStr - 1);
        const v = e.key === 'T' ? 1000 + e.str : (e.key === e.led ? e.str : 0);
        const wv = winKey === 'T' ? 1000 + winStr : winStr;
        if (v > wv) { winSeat = e.seat; winKey = e.key; winStr = e.str; }
      }
      if (e.key === 'T') { fallen.add(e.str); trumpsPlayed[e.seat]++; }
      else { suitCount[e.key]++; if (e.key === e.led) followed[e.seat][e.key] = (followed[e.seat][e.key] || 0) + 1; }
      if (e.key !== e.led) voids[e.seat][e.led] = true;
    }
    // discard-based void priors: whoever discarded 3-4 cards (the forehand/declarer)
    // almost certainly created ~2 voids; a 1-2 card discard, at least one
    const discards = SEATS.map((s) => (g.discardPile && g.discardPile[s]) ? g.discardPile[s].length : 0);
    const prior = SEATS.map((s) => (discards[s] >= 3 ? 2 : discards[s] >= 1 ? 1 : 0));
    const SUITN = ['hearts', 'diamonds', 'spades', 'clubs'];
    // "likely void": proven, or an unspent discard prior on a suit they have never followed once it's been led
    const likelyVoid = (s, su) => {
      if (voids[s][su]) return true;
      const known = SUITN.filter((x) => voids[s][x]).length;
      return prior[s] > known && !followed[s][su] && suitCount[su] >= 1;
    };
    const likelyRuff = (s, su) => likelyVoid(s, su) && !voids[s]['T'];
    return { voids, fallen, suitCount, followed, maxBelief, discards, trumpsPlayed, likelyVoid, likelyRuff };
  }
  // ---------- reading a human partner's opening signal ----------
  // A forehand who leads a SMALL trump on the first trick is asking "who is my partner?" while
  // announcing trump length and good colors: they want the opponents' trumps pulled so their
  // kings and long suits come home late. The partner's duty is to WIN that trick and hand the
  // lead straight back with high trumps. Used by every level above novice.
  function signalPlay(g, seat, mem, legal) {
    if (g.mode !== 'draw4' || g.calledId == null || g.partner !== seat) return null;
    // only HUMAN forehands are read this way — bots don't signal, and answering a bot's
    // incidental small-trump lead just burns the called trump early (measured -8 chips/100)
    if (!g.humans || !g.humans[g.declarer]) return null;
    const log = g.playLog || [];
    if (!log.length) return null;
    const first = log[0];
    if (first.seat !== g.declarer || first.key !== 'T' || first.str < 2 || first.str > 12) return null;
    const str = strengthOf;
    const myTr = legal.filter(isTrump);
    if (!myTr.length) return null;
    // did the forehand announce 8+ trumps (Taroky/Hrubá)? then the Skýz answers first, XIX next
    const declLen = (g.bonuses || []).some((b) => b.seat === g.declarer && (b.type === 'taroky' || b.type === 'hrube'));
    const skyz = myTr.find((c) => c.strength === 22);
    const called = myTr.find((c) => c.id === g.calledId);
    if (g.trick.length === 0) {
      if (called) return called;                          // come straight back with the called trump
      const myTop = Math.max.apply(null, myTr.map((c) => c.strength));
      const opps = SEATS.filter((s) => s !== seat && teamOf(g, s) !== 'decl');
      // opponents demonstrably cannot win a trump trick: keep hammering from the top
      if (opps.every((s) => mem.voids[s]['T'] || mem.maxBelief[s] < myTop)) {
        const np = myTr.filter((c) => c.strength > 1);   // never lead the Pagát
        if (np.length) return maxBy(np, str);
      }
      return null;
    }
    if (log.length >= 4) return null;                    // only the signal trick itself is forced
    const led = g.trick[0].card;
    const cw = trickWinner(g.trick);
    const cv = valueInTrick(g.trick.find((x) => x.seat === cw).card, led);
    const wins = myTr.filter((c) => valueInTrick(c, led) > cv);
    if (!wins.length) return null;
    if (g.trick.length === 3) return minBy(wins, str);   // in the back: take it as cheaply as possible
    if (skyz && declLen) return skyz;                    // answer the announced length with the Skýz
    return called || minBy(wins, str);                   // first/second seat: play the called trump
  }

  function topOutstanding(g, seat, mem) {           // highest trump not yet fallen and not in my own hand
    const mine = new Set(g.hands[seat].filter(isTrump).map((c) => c.strength));
    for (let v = 22; v >= 1; v--) if (!mem.fallen.has(v) && !mine.has(v)) return v;
    return 0;
  }
  function aiPlayAdvanced(g, seat) {
    if (g.mode === 'zebrak') return aiPlay(g, seat); // the beggar game keeps its dedicated logic
    const W = wOf(g);
    const legal = legalMoves(g, seat); const str = strengthOf;
    const mem = aiMemory(g); const myTeam = teamOf(g, seat);
    const SUITNAMES = ['hearts', 'diamonds', 'spades', 'clubs'];
    const isMate = (s) => teamOf(g, s) === myTeam;
    const soloOpp = (g.solo && !isMate(g.declarer)) ? g.declarer : null;
    const outTop = topOutstanding(g, seat, mem);
    // score awareness: how are we doing vs the 53/54-point cliff?
    const oppTeamKey = myTeam === 'decl' ? 'def' : 'decl';
    const myPts = g.captured[myTeam].reduce((t, c) => t + c.points, 0);
    const oppPts = g.captured[oppTeamKey].reduce((t, c) => t + c.points, 0);
    const tricksLeft = g.hands[seat].length;
    // late and behind: worth gambling — flipping a narrow loss to a narrow win swings the whole game value
    // (defenders win the 53-53 tie, so a tied DECLARING team is losing)
    const behind = myTeam === 'decl' ? myPts <= oppPts : myPts < oppPts;
    const desperate = tricksLeft <= W.desperateTricks && behind && (oppPts - myPts) <= W.desperateGap;
    const cruising = myPts >= (myTeam === 'def' ? 53 : 54); // mathematically won on points: take zero risks
    // did my side declare trump length (Taroky/Hrubá)? that's public info — and a mandate to pull trumps.
    // An OPPONENT'S declared length flips it: leading trumps into their wall only drains us and the partner.
    const declaredLen = (g.bonuses || []).some((b) => isMate(b.seat) && (b.type === 'taroky' || b.type === 'hrube'));
    const oppDeclaredLen = (g.bonuses || []).some((b) => !isMate(b.seat) && (b.type === 'taroky' || b.type === 'hrube'));
    // can some opponent still hold a trump?
    const oppMayHoldTrump = SEATS.some((s) => s !== seat && !isMate(s) && !mem.voids[s]['T']) && outTop > 0;
    const goingUltimo = g.pagatUltimo === seat; // never shed the Pagát if we promised ultimo
    // valat alarm: our side has taken NO tricks and the hand is running out — losing every
    // trick costs a 20-chip valat, so buying even one worthless trick is hugely +EV
    const valatRisk = (g.tricksWon && (g.tricksWon[myTeam] || 0) === 0) && tricksLeft <= 6;
    // partner declared Bide (1-2 trumps): until those trumps are gone they must follow trump
    // and cannot grease our trump tricks — against a long-trump opponent, wait them out
    const mate = SEATS.find((s) => s !== seat && isMate(s));
    const mateBite = mate != null && (g.bonuses || []).some((b) => b.seat === mate && b.type === 'bite');
    const mateHasTrump = mate != null && !mem.voids[mate]['T'] && mem.trumpsPlayed[mate] < 2;
    const sig = signalPlay(g, seat, mem, legal);
    if (sig) return sig;
    if (g.trick.length === 0) {
      const myTr = legal.filter(isTrump); const nt = legal.filter((c) => !isTrump(c));
      const myTop = myTr.length ? Math.max.apply(null, myTr.map((c) => c.strength)) : 0;
      // declaring side holding the boss trump with length: pull with the CHEAPEST trump that still beats everything outstanding.
      // "Boss" counts belief too: if every opponent has shown trump-void or under-trumped below our top, our top is boss in practice.
      const oppsAll = SEATS.filter((s) => s !== seat && !isMate(s));
      const bossByBelief = myTop > 0 && oppsAll.every((s) => mem.voids[s]['T'] || mem.maxBelief[s] < myTop);
      if (myTeam === 'decl' && !oppDeclaredLen && outTop > 0 && myTr.length >= W.pullMinLen && (myTop > outTop || bossByBelief)) {
        const pullers = myTr.filter((c) => c.strength > outTop);
        return pullers.length ? minBy(pullers, str) : maxBy(myTr, str);
      }
      // we (or partner) declared Taroky/Hrubá: keep hammering trumps while opponents may hold any —
      // it clears the way home for our kings and short suits. Never lead the Pagát; boss first if we have it.
      if (W.hammerLen && declaredLen && !oppDeclaredLen && oppMayHoldTrump && myTr.length) {
        const nonPagat = myTr.filter((c) => c.strength > 1);
        const lead = myTop > outTop ? minBy(myTr.filter((c) => c.strength > outTop), str)
                                    : (nonPagat.length ? maxBy(nonPagat, str) : null);
        if (lead) return lead;
      }
      // behind late: cash the boss trump \u2014 a guaranteed trick, and the partner can feed it points
      if (desperate && myTop > outTop && outTop > 0) return minBy(myTr.filter((c) => c.strength > outTop), str);
      // valat alarm on lead: cash a boss trump NOW if we have one
      if (valatRisk && myTop > outTop && myTr.length) return minBy(myTr.filter((c) => c.strength > outTop), str);
      // a partner shown (or likely) void in a suit and not out of trumps can ruff: feed our fattest card there —
      // but only when the partner plays LAST and neither opponent has shown void in that suit (their ruff is then decisive)
      const ord = orderFrom(seat);
      if (isMate(ord[3]) && !mem.voids[ord[3]]['T'])
        for (const su of SUITNAMES) if (mem.likelyVoid(ord[3], su) && !mem.voids[ord[1]][su] && !mem.voids[ord[2]][su]) { const cs = nt.filter((c) => c.suit === su); if (cs.length) return maxBy(cs, (c) => c.points * W.feedPtsW - str(c)); }
      // against a solo player: lead low, prefer suits they are VOID in only if our card is worthless (force a ruff, drain their trumps)
      if (soloOpp != null) { const cheapest = nt.length ? minBy(nt, (c) => c.points * W.cheapPtsW + str(c)) : null; if (cheapest && cheapest.points <= 1 && mem.voids[soloOpp][cheapest.suit]) return cheapest; }
      const pool = nt.length ? nt : legal;
      // suit exhaustion: count how many of a suit's 8 cards remain outside my hand.
      // A lead in a nearly-dead suit pulls trumps from the void hands — do that deliberately
      // with worthless cards when we hold the big trumps, never with a pointy card.
      const outstanding = (su) => 8 - mem.suitCount[su] - g.hands[seat].filter((c) => !isTrump(c) && c.suit === su).length;
      const holdBig = myTop > outTop && myTr.length >= 2;
      const mateLast = isMate(ord[3]);
      return minBy(pool, (c) => {
        let v = c.points * W.cheapPtsW + str(c);
        if (!isTrump(c)) {
          const out = outstanding(c.suit);
          const oppRuffs = SEATS.some((s) => s !== seat && !isMate(s) && mem.likelyRuff(s, c.suit));
          if (c.points >= 4 && (out <= 3 || oppRuffs)) v += 300;            // points into a likely ruff: bad
          if (c.points >= 4 && !mateLast) v += 80;                          // an opponent acts last: they harvest
          if (c.points >= 4 && mateLast) v -= 40;                           // partner acts last: points can come home
          if (c.points <= 1 && out <= 3 && oppRuffs && holdBig) v -= 120;   // cheap drain lead while our trumps stay boss: good
        }
        return v;
      });
    }
    const led = g.trick[0].card; const ledKey = isTrump(led) ? 'T' : led.suit;
    const cw = trickWinner(g.trick); const winCard = g.trick.find((x) => x.seat === cw).card;
    const cv = valueInTrick(winCard, led); const last = g.trick.length === 3;
    const after = orderFrom(g.leader).slice(g.trick.length + 1);
    const beats = legal.filter((c) => valueInTrick(c, led) > cv);
    const oppAfter = after.filter((s) => !isMate(s));
    // can any remaining opponent still beat the current winner? (void-aware, count-aware, belief-aware)
    const oppCanBeat = oppAfter.some((s) => {
      const vd = mem.voids[s];
      if (isTrump(winCard)) return !vd['T'] && outTop > winCard.strength && mem.maxBelief[s] > winCard.strength;
      return !vd[ledKey] || !vd['T'];
    });
    if (teamOf(g, cw) === myTeam) {
      // partner winning safely and we hold the Pagát among our legal cards: shed it home
      // (5 points banked AND no last-trick disaster) — unless we're committed to ultimo
      if (!goingUltimo && W.pagatShed && (last || !oppCanBeat)) {
        const pagat = legal.find((c) => isTrump(c) && c.strength === 1);
        if (pagat && valueInTrick(pagat, led) <= cv) return pagat;
      }
      // partner already winning: feed points in last seat — or gamble a feed when behind late
      if (last || (desperate && !cruising)) {
        const safe = legal.filter((c) => valueInTrick(c, led) <= cv);
        let pool = safe.length ? safe : legal;
        // never spend a trump that is (or just became) BOSS — e.g. the XXI once the Skýz has fallen:
        // it is a guaranteed future trick; feed the next-fattest card instead
        const keep = W.keepBoss ? pool.filter((c) => !(isTrump(c) && c.strength > outTop)) : pool;
        if (keep.length) pool = keep;
        return maxBy(pool, (c) => c.points * W.feedPtsW - str(c));
      }
      // not last: play cheap — but if the partner is unbeatable, first get a threatened
      // King/court card home now (grease): its suit may be ruffed out from under us later
      const under = legal.filter((c) => valueInTrick(c, led) <= cv);
      if (!oppCanBeat && under.length) {
        const opps = SEATS.filter((s) => s !== seat && !isMate(s));
        const fat = maxBy(under, (c) => c.points * W.feedPtsW - str(c));
        if (fat.points >= 4 && !isTrump(fat) && opps.some((s) => mem.voids[s][fat.suit] && !mem.voids[s]['T'])) return fat;
        return minBy(under, (c) => c.points * W.cheapPtsW + str(c));
      }
      return minBy(legal, (c) => c.points * W.cheapPtsW + str(c));
    }
    // opponent winning — will a partner ruff behind us? (trick not yet trumped, partner plays last,
    // void in the led suit and still holding trumps: their ruff is then guaranteed to win)
    const killer = !isTrump(winCard) && after.length && isMate(after[after.length - 1]) && mem.likelyVoid(after[after.length - 1], ledKey) && !mem.voids[after[after.length - 1]]['T'];
    if (killer && !beats.length) return maxBy(legal, (c) => c.points * W.feedPtsW - str(c)); // feed the kill
    // partner's ruff behind is PROVEN and we hold fat safe cards: grease the coming kill
    // even though we could win ourselves — the points come home either way, and our winner is saved
    if (killer && beats.length && mem.voids[after[after.length - 1]][ledKey]) {
      const fat = maxBy(legal, (c) => c.points * W.feedPtsW - str(c));
      if (fat.points >= 4 && valueInTrick(fat, led) <= cv) return fat;
    }
    if (beats.length) {
      const trickPts = g.trick.reduce((t, x) => t + x.card.points, 0);
      // valat alarm: take this trick with the SUREST winner — any trick beats a 20-chip valat
      if (valatRisk && (last || !oppCanBeat || tricksLeft <= 3)) return maxBy(beats, (c) => valueInTrick(c, led) * 1000 - c.points);
      // partner still owes trumps after calling Bide: duck cheap trump tricks against a long-trump
      // opponent — win them later, once the partner can throw us grease instead of following
      if (mateBite && mateHasTrump && ledKey === 'T' && oppDeclaredLen && trickPts <= 4 && !desperate && !last) {
        const duck = legal.filter((c) => valueInTrick(c, led) <= cv);
        if (duck.length) return minBy(duck, (c) => c.points * W.cheapPtsW + str(c));
      }
      // ruff fight: we ruff a suit an opponent BEHIND us likely also ruffs — push a trump that
      // tops their believed best (or force out their biggest), instead of ruffing cheap and losing the points
      if (ledKey !== 'T' && beats.some(isTrump) && trickPts >= 2) {
        const fighters = oppAfter.filter((s) => mem.likelyRuff(s, ledKey));
        if (fighters.length) {
          const oppMax = Math.max.apply(null, fighters.map((s) => mem.maxBelief[s]));
          const over = beats.filter((c) => isTrump(c) && c.strength > oppMax);
          if (over.length) return minBy(over, str);
          return maxBy(beats.filter(isTrump), str);
        }
      }
      // only mates behind: just take the lead — the cheapest winner is enough, never push high
      if (!oppAfter.length) return minBy(beats, (c) => c.points * W.cheapPtsW + str(c) + (isTrump(c) ? W.trumpSpendPen : 0));
      // first time this suit is led: risk the King — it usually walks, and a king that hides at home
      // often dies to a ruff later anyway. Skip when an opponent behind is a certain OR likely ruff
      // (proven void, or a discarder who has never followed this suit).
      if (W.kingFirstRound && !isTrump(led) && mem.suitCount[ledKey] === 0 && !isTrump(winCard)) {
        const king = beats.find((c) => !isTrump(c) && c.points === 5);
        const ruffRisk = oppAfter.some((s) => mem.likelyRuff(s, ledKey));
        if (king && !ruffRisk) return king;
      }
      // behind late on a pointy trick: take it with our SUREST winner, not the cheapest
      if (desperate && trickPts >= W.despTrickPts && oppCanBeat && !last) return maxBy(beats, (c) => valueInTrick(c, led) * 1000 - c.points);
      return minBy(beats, (c) => c.points * W.cheapPtsW + str(c) + (isTrump(c) ? W.trumpSpendPen : 0));
    }
    // can't win: pitch — but against a solo player HOLD the suits they still follow (win the endgame),
    // and throw from suits they would ruff anyway
    return minBy(legal, (c) => {
      let v = c.points * W.cheapPtsW + str(c);
      if (soloOpp != null && !isTrump(c) && !mem.voids[soloOpp][c.suit]) v += W.soloHold;
      return v;
    });
  }

  // ======================================================================
  //  DOUBLE-DUMMY SOLVER — powers the 'insane' (perfect info) and 'expert'
  //  (determinized, no peeking at who holds what) AI levels.
  // ======================================================================
  // Value = card points the DECLARING team captures in the remaining play,
  // plus a pagát-last-trick term scaled to ~chip value. Decl seats maximize,
  // defenders minimize. Žebrák uses its own value: 100 if the beggar is ever
  // forced to take a trick (defender success), 0 if he ducks them all.
  function simLegal(sim, seat) { return legalMoves({ hands: sim.hands, trick: sim.trick, mode: sim.mode }, seat); }
  function ddEval(sim) {
    // out of time / depth: assume the remaining points split evenly
    let rem = 0;
    for (let s = 0; s < 4; s++) for (const c of sim.hands[s]) rem += c.points;
    for (const x of sim.trick) rem += x.card.points;
    return rem / 2;
  }
  function ddTrickClose(sim, done, win) {
    // value contribution of a just-completed trick (standard modes)
    let pts = 0, pagat = null;
    for (const x of done) { pts += x.card.points; if (x.card.kind === 'trump' && x.card.strength === 1) pagat = x; }
    let bonus = 0;
    if (pagat && !sim.hands[0].length && !sim.hands[1].length && !sim.hands[2].length && !sim.hands[3].length) {
      // pagát on the last trick: ±W to the pagát player's team, expressed in decl points
      bonus = (win === pagat.seat ? 1 : -1) * (sim.isDecl[pagat.seat] ? sim.pagatW : -sim.pagatW);
    }
    return (sim.isDecl[win] ? pts : 0) + bonus;
  }
  function ddSearch(sim, alpha, beta, tricksDone) {
    if ((++sim.nodes & 127) === 0 && Date.now() > sim.deadline) sim.timeUp = true;
    const seat = sim.turn;
    if (sim.trick.length === 0) {
      if (!sim.hands[seat].length) return 0;                       // nothing left
      if (sim.timeUp || tricksDone >= sim.plyTricks) return sim.zebrak ? 0 : ddEval(sim);
      if (sim.tt) {
        sim.key = seat + '|' + sim.hands.map((h) => h.map((c) => c.id).join(',')).join('|');
        const hit = sim.tt.get(sim.key);
        if (hit !== undefined) return hit;
      }
    }
    const moves = simLegal(sim, seat);
    const led = sim.trick.length ? sim.trick[0].card : null;
    if (moves.length > 1) moves.sort((a, b) => (led ? valueInTrick(b, led) - valueInTrick(a, led) : (b.kind === 'trump' ? 900 + b.strength : b.str) - (a.kind === 'trump' ? 900 + a.strength : a.str)));
    const maximizing = sim.zebrak ? seat !== sim.declSeat : sim.isDecl[seat];
    let best = maximizing ? -Infinity : Infinity;
    const key = (sim.trick.length === 0 && sim.tt) ? sim.key : null;
    for (const card of moves) {
      const hand = sim.hands[seat];
      hand.splice(hand.indexOf(card), 1);
      sim.trick.push({ seat, card });
      let val;
      if (sim.trick.length === 4) {
        const win = trickWinner(sim.trick);
        const done = sim.trick;
        const savedTurn = sim.turn;
        sim.trick = []; sim.turn = win;
        if (sim.zebrak) val = win === sim.declSeat ? 100 : ddSearch(sim, alpha, beta, tricksDone + 1);
        else val = ddTrickClose(sim, done, win) + ddSearch(sim, alpha, beta, tricksDone + 1);
        sim.trick = done; sim.turn = savedTurn;
        sim.trick.pop();
      } else {
        sim.turn = next(seat);
        val = ddSearch(sim, alpha, beta, tricksDone);
        sim.turn = seat;
        sim.trick.pop();
      }
      hand.push(card);
      if (maximizing) { if (val > best) best = val; if (best > alpha) alpha = best; }
      else { if (val < best) best = val; if (best < beta) beta = best; }
      if (alpha >= beta) break;
    }
    if (key && !sim.timeUp) sim.tt.set(key, best);
    return best;
  }
  function makeSim(g, hands, budgetMs) {
    const tricksLeft = Math.max.apply(null, hands.map((h) => h.length));
    return {
      hands, trick: g.trick.slice(), turn: g.turn, mode: g.mode,
      isDecl: SEATS.map((s) => teamOf(g, s) === 'decl'),
      zebrak: g.mode === 'zebrak', declSeat: g.declarer,
      pagatW: g.pagatUltimo != null ? 20 : 10,
      plyTricks: tricksLeft <= 7 ? 99 : 3,          // exact endgame, 3-trick lookahead early
      deadline: Date.now() + budgetMs, nodes: 0, timeUp: false,
      tt: tricksLeft <= 7 ? new Map() : null, key: null,
    };
  }
  // Root: evaluate each of MY legal moves under a sim; returns [{card,val}] where higher = better for me.
  function ddRoot(g, seat, hands, budgetMs) {
    const sim = makeSim(g, hands, budgetMs);
    const moves = simLegal(sim, seat);
    const maximizing = sim.zebrak ? seat !== sim.declSeat : sim.isDecl[seat];
    const scored = [];
    for (const card of moves) {
      const hand = sim.hands[seat];
      hand.splice(hand.indexOf(card), 1);
      sim.trick.push({ seat, card });
      let val;
      if (sim.trick.length === 4) {
        const win = trickWinner(sim.trick);
        const done = sim.trick; const savedTurn = sim.turn;
        sim.trick = []; sim.turn = win;
        if (sim.zebrak) val = win === sim.declSeat ? 100 : ddSearch(sim, -Infinity, Infinity, 1);
        else val = ddTrickClose(sim, done, win) + ddSearch(sim, -Infinity, Infinity, 1);
        sim.trick = done; sim.turn = savedTurn; sim.trick.pop();
      } else {
        sim.turn = next(seat);
        val = ddSearch(sim, -Infinity, Infinity, 0);
        sim.turn = seat; sim.trick.pop();
      }
      hand.push(card);
      scored.push({ card, val: maximizing ? val : -val });
    }
    return scored;
  }
  // 'insane': perfect information — solves on the TRUE hands.
  function aiPlayInsane(g, seat) {
    const lm = legalMoves(g, seat);
    if (lm.length === 1) return lm[0];
    const scored = ddRoot(g, seat, g.hands.map((h) => h.slice()), 380);
    if (!scored.length) return legalMoves(g, seat)[0];
    let best = scored[0];
    for (const s of scored) if (s.val > best.val + 1e-9) best = s;
    // among near-equal moves, prefer what the strong heuristic would do
    const h = aiPlayAdvanced(g, seat);
    for (const s of scored) if (s.card.id === h.id && s.val >= best.val - 0.5) return s.card;
    return best.card;
  }
  // 'expert': no peeking — samples plausible worlds consistent with public info
  // (played cards, hand counts, shown voids, the called trump's whereabouts),
  // solves each, and plays the card that does best on average.
  function aiPlayExpert(g, seat, worlds, budget) {
    worlds = worlds || 16; budget = budget || 40;
    const legal = legalMoves(g, seat);
    if (legal.length === 1) return legal[0];
    const mem = aiMemory(g);
    const pool = [];
    for (const s of SEATS) if (s !== seat) for (const c of g.hands[s]) pool.push(c);
    const counts = SEATS.map((s) => (s === seat ? 0 : g.hands[s].length));
    const others = SEATS.filter((s) => s !== seat);
    const calledUnseen = g.calledId && !g.revealedPartner && pool.some((c) => c.id === g.calledId);
    const votes = new Map(); legal.forEach((c) => votes.set(c.id, 0));
    for (let w = 0; w < worlds; w++) {
      // random deal of the unseen pool, then repair void violations by swapping
      let deal = null;
      for (let attempt = 0; attempt < 12 && !deal; attempt++) {
        const bag = pool.slice();
        for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
        const d = {}; let k = 0;
        for (const s of others) { d[s] = bag.slice(k, k + counts[s]); k += counts[s]; }
        let ok = true;
        for (let pass = 0; pass < 30; pass++) {
          let moved = false;
          for (const s of others) {
            for (let i = 0; i < d[s].length && ok; i++) {
              const c = d[s][i]; const ck = isTrump(c) ? 'T' : c.suit;
              if (!mem.voids[s][ck]) continue;
              let fixed = false;
              for (const o of others) {
                if (o === s || mem.voids[o][ck]) continue;
                const j = d[o].findIndex((x) => { const xk = isTrump(x) ? 'T' : x.suit; return !mem.voids[s][xk]; });
                if (j >= 0) { const tmp = d[s][i]; d[s][i] = d[o][j]; d[o][j] = tmp; moved = true; fixed = true; break; }
              }
              if (!fixed) ok = false;
            }
            if (!ok) break;
          }
          if (!ok || !moved) break;
        }
        // final check
        if (ok) for (const s of others) for (const c of d[s]) { const ck = isTrump(c) ? 'T' : c.suit; if (mem.voids[s][ck]) { ok = false; break; } }
        if (ok) deal = d;
      }
      if (!deal) { deal = {}; let k = 0; for (const s of others) { deal[s] = pool.slice(k, k + counts[s]); k += counts[s]; } }
      const hands = SEATS.map((s) => (s === seat ? g.hands[seat].slice() : deal[s].slice()));
      // teams in this world: the partner is whoever holds the called card
      let g2 = g;
      if (calledUnseen) { g2 = Object.create(g); const p = SEATS.find((s) => hands[s].some((c) => c.id === g.calledId)); if (p !== undefined) g2.partner = p; }
      const scored = ddRoot(g2, seat, hands, budget);
      for (const s of scored) votes.set(s.card.id, votes.get(s.card.id) + s.val);
    }
    let best = legal[0];
    for (const c of legal) if (votes.get(c.id) > votes.get(best.id)) best = c;
    return best;
  }

  // ---- solver-assisted deal decisions (expert & insane): discard and contra/rey ----
  // Sample one plausible arrangement of the cards I can't see (insane just takes the truth).
  function sampleHandsFor(g, seat, cheat) {
    if (cheat) return { hands: g.hands.map((h) => h.slice()), partner: g.partner };
    const others = SEATS.filter((s) => s !== seat);
    const pool = [];
    for (const s of others) for (const c of g.hands[s]) pool.push(c);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    const hands = []; let k = 0;
    for (const s of SEATS) { if (s === seat) hands.push(g.hands[seat].slice()); else { hands.push(pool.slice(k, k + g.hands[s].length)); k += g.hands[s].length; } }
    // the partner in THIS world is whoever holds the called card
    let partner = g.partner;
    if (g.calledId != null && !g.revealedPartner) {
      const p = SEATS.find((s) => hands[s].some((c) => c.id === g.calledId));
      if (p !== undefined) partner = (p === g.declarer ? null : p);
    }
    return { hands, partner };
  }
  // Expected card points for the DECLARING side over the whole play (plus already-banked decl points).
  function solveDealValue(g, seat) {
    const cheat = g.aiLevel === 'insane';
    const W = cheat ? 1 : 6;
    let tot = 0;
    for (let w = 0; w < W; w++) {
      const world = sampleHandsFor(g, seat, cheat);
      const g2 = Object.create(g); g2.partner = world.partner;
      const sim = makeSim(g2, world.hands, cheat ? 250 : 70);
      sim.trick = []; sim.turn = g2.mode === 'zebrak' ? g2.declarer : g2.forehand;
      sim.plyTricks = Math.min(sim.plyTricks, 4);
      tot += ddSearch(sim, -Infinity, Infinity, 0);
    }
    return sum(g.captured.decl) + tot / W;
  }
  // Pick the best discard by trying candidate sets against the same sampled worlds.
  function solveDiscard(g, seat) {
    const need = g.discardNeed[seat];
    const hand = g.hands[seat];
    const pool = hand.filter((c) => !c.honour && c.court !== 'K');
    if (pool.length <= need) return pool.slice(0, need);
    const len = { hearts: 0, diamonds: 0, spades: 0, clubs: 0 };
    for (const c of hand) if (!isTrump(c)) len[c.suit]++;
    const voidCmp = (a, b) => (isTrump(a) ? 1 : 0) - (isTrump(b) ? 1 : 0) || (isTrump(a) ? 0 : len[a.suit]) - (isTrump(b) ? 0 : len[b.suit]) || b.points - a.points || strengthOf(a) - strengthOf(b);
    const cands = []; const seen = new Set();
    const add = (arr) => { const c = arr.slice(0, need); if (c.length === need) { const key = c.map((x) => x.id).sort().join(','); if (!seen.has(key)) { seen.add(key); cands.push(c); } } };
    add(pool.slice().sort(voidCmp));                                                                                             // voids first, then points
    add(pool.slice().sort((a, b) => (isTrump(a) ? 1 : 0) - (isTrump(b) ? 1 : 0) || b.points - a.points || strengthOf(a) - strengthOf(b))); // bank the fattest points
    add(pool.slice().sort((a, b) => (isTrump(a) ? 1 : 0) - (isTrump(b) ? 1 : 0) || a.points - b.points || strengthOf(a) - strengthOf(b))); // ditch chaff, keep points in hand
    for (const su of ['hearts', 'diamonds', 'spades', 'clubs']) {                                                                // force each achievable void
      if (len[su] > 0 && len[su] <= need) {
        const base = pool.filter((c) => !isTrump(c) && c.suit === su);
        add(base.concat(pool.filter((c) => base.indexOf(c) < 0).sort(voidCmp)));
      }
    }
    if (cands.length === 1) return cands[0];
    const iAmDecl = seat === g.declarer || (g.calledId != null && hand.some((c) => c.id === g.calledId));
    const cheat = g.aiLevel === 'insane';
    const worlds = []; const W = cheat ? 1 : 5;
    for (let w = 0; w < W; w++) worlds.push(sampleHandsFor(g, seat, cheat));
    // other seats may not have discarded yet in the sampled world — trim them heuristically
    const trim = (h, s) => {
      let n = (s !== seat && g.discardWaiting.includes(s)) ? (g.discardNeed[s] || 0) : 0;
      if (!n) return h;
      const drop = new Set(h.filter((c) => !c.honour && c.court !== 'K' && !isTrump(c)).sort((a, b) => a.points - b.points || strengthOf(a) - strengthOf(b)).slice(0, n).map((c) => c.id));
      if (drop.size < n) for (const c of h.filter((x) => isTrump(x) && !x.honour).sort((a, b) => a.strength - b.strength)) { if (drop.size >= n) break; drop.add(c.id); }
      return h.filter((c) => !drop.has(c.id));
    };
    let best = cands[0], bestVal = -Infinity;
    for (const cand of cands) {
      const ids = new Set(cand.map((c) => c.id));
      const banked = iAmDecl ? cand.reduce((t, c) => t + c.points, 0) : 0;
      let tot = 0;
      for (const world of worlds) {
        const hands = world.hands.map((h, s) => (s === seat ? h.filter((c) => !ids.has(c.id)) : trim(h.slice(), s)));
        const g2 = Object.create(g); g2.partner = world.partner;
        const sim = makeSim(g2, hands, cheat ? 120 : 35);
        sim.trick = []; sim.turn = g2.mode === 'zebrak' ? g2.declarer : g2.forehand;
        sim.plyTricks = Math.min(sim.plyTricks, 4);
        tot += ddSearch(sim, -Infinity, Infinity, 0);
      }
      const declPts = banked + tot / W;
      const val = iAmDecl ? declPts : -declPts;
      if (val > bestVal) { bestVal = val; best = cand; }
    }
    return best;
  }

  return {
    createGame, newDeal, applyAction, viewFor, aiAction, setSyntheticWeights,
    // exposed for tests / advanced use:
    buildDeck, legalMoves, trickWinner, evalBonuses, teamOf, roman, SEATS,
  };
});
