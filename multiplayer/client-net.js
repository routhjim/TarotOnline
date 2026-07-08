/*
 * client-net.js — thin networking adapter for the browser client.
 *
 * Bridges the WebSocket protocol to your UI. It does NOT contain game rules —
 * the server is authoritative. You render whatever `onState(view)` gives you and
 * call the send helpers when the local player acts.
 *
 * Integration with the existing single-player UI (Taroky.dc.html):
 *   The DC keeps all rules in its Component class. For online play you instead
 *   render from `view` (server truth) and replace the local mutators:
 *     - bidding buttons      -> net.bid(level)
 *     - talon shop buttons   -> net.talonHand('keep1'|'swap'|'keep2'|'back')
 *     - solo/throw-in        -> net.talonChoice('solo'|'throwin')
 *     - confirm discards     -> net.discard(selectedCardIds)
 *     - declarations panel    -> net.declare({bonuses, ultimo, contra, rey, pagatContra})
 *     - clicking a hand card -> net.play(cardId)      (enabled only if view.legal.includes(cardId))
 *     - "Deal next hand"     -> net.nextDeal()
 *   Seat->table-position mapping is a pure view concern: rotate so `view.you`
 *   sits at the bottom.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TarokyNet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function connect(url, opts) {
    opts = opts || {};
    const ws = new WebSocket(url);
    const api = {
      seat: null, seats: null, view: null,
      onState: opts.onState || function () {},
      onJoined: opts.onJoined || function () {},
      onReject: opts.onReject || function () {},
      onError: opts.onError || function () {},
      onOpen: opts.onOpen || function () {},
      onClose: opts.onClose || function () {},
    };

    ws.onopen = () => api.onOpen();
    ws.onclose = () => api.onClose();
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'state') { api.view = msg.view; api.seat = msg.view.you; api.onState(msg.view); }
      else if (msg.type === 'joined') { api.seat = msg.seat; api.seats = msg.seats; api.onJoined(msg); }
      else if (msg.type === 'reject') api.onReject(msg);
      else if (msg.type === 'error') api.onError(msg);
    };

    const raw = (o) => ws.send(JSON.stringify(o));
    const act = (action) => raw({ type: 'action', action });

    // lobby
    api.join = (roomId, name, seat) => raw({ type: 'join', roomId, name, seat });
    api.start = () => raw({ type: 'start' });
    api.nextDeal = () => act({ type: 'nextDeal' });
    // moves
    api.bid = (level) => act({ type: 'bid', level });
    api.talonHand = (choice) => act({ type: 'talonHand', choice });
    api.talonChoice = (choice) => act({ type: 'talonChoice', choice });
    api.discard = (cardIds) => act({ type: 'discard', cardIds });
    api.declare = (d) => act(Object.assign({ type: 'declare', bonuses: [], ultimo: false, contra: false, rey: false, pagatContra: false }, d));
    api.play = (cardId) => act({ type: 'play', cardId });

    api.close = () => ws.close();
    api._ws = ws;
    return api;
  }

  return { connect };
});
