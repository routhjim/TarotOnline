/*
 * smoke-test.js — headless proof the engine runs and stays money-conservative.
 *   node smoke-test.js
 * Plays many full deals with all-bot seats and asserts total chips never drift
 * from 400 (4 × 100) and no action ever crashes.
 */
const T = require('./taroky-engine');

function playDeal(g) {
  let guard = 0;
  while (g.phase !== 'scoring' && guard++ < 500) {
    let acted = false;
    for (let seat = 0; seat < 4; seat++) {
      const a = T.aiAction(g, seat);
      if (a) { const r = T.applyAction(g, seat, a); if (!r.ok) throw new Error('rejected: ' + r.error + ' (' + JSON.stringify(a) + ')'); acted = true; break; }
    }
    if (!acted) throw new Error('deadlock in phase ' + g.phase);
  }
  if (g.phase !== 'scoring') throw new Error('deal never finished');
}

const N = Number(process.argv[2] || 500);
const g = T.createGame({ seats: ['North', 'East', 'South', 'West'] });
const modes = {};
for (let i = 0; i < N; i++) {
  T.newDeal(g);
  playDeal(g);
  const total = g.players.reduce((t, p) => t + p.chips, 0);
  if (total !== 400) throw new Error('chip drift! total=' + total + ' after deal ' + (i + 1) + ' mode=' + g.mode);
  modes[g.mode] = (modes[g.mode] || 0) + 1;
}
console.log('OK — ' + N + ' deals, chips conserved at 400 throughout.');
console.log('contract mix:', modes);
console.log('final chips:', g.players.map((p) => p.name + ':' + p.chips).join('  '));
