document.documentElement.dataset.theme =
  localStorage.getItem("ezscreenshare.theme") === "light" ? "light" : "dark";
// Must run before livekit-client. SOCKS/Tor-like proxies only allow 443;
// LiveKit advertises TURNS on 21117 and default Google/Twilio STUN.
// Keep only TURNS :443 so ICE does not stall on UDP STUN through SOCKS.
(function () {
  var host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return;
  var turnHost = /^share\./i.test(host) ? host.replace(/^share\./i, "turn.") : "turn." + host;
  var TURNS = "turns:" + turnHost + ":443?transport=tcp";
  function rewriteUrl(u) {
    u = String(u);
    if (/^stun:/i.test(u)) return null;
    if (/^turns?:/i.test(u) || /:21117\b/.test(u)) return TURNS;
    return u;
  }
  function rewrite(init) {
    if (!init) return init;
    var next = {};
    for (var k in init) next[k] = init[k];
    var servers = init.iceServers || [];
    var out = [];
    for (var i = 0; i < servers.length; i++) {
      var s = servers[i];
      var copy = {};
      for (var k in s) copy[k] = s[k];
      var urls = s.urls || s.url;
      if (!urls) continue;
      var list = Array.isArray(urls) ? urls : [urls];
      var kept = [];
      for (var j = 0; j < list.length; j++) {
        var u = rewriteUrl(list[j]);
        if (u && kept.indexOf(u) === -1) kept.push(u);
      }
      if (!kept.length) continue;
      var needsCred = kept.some(function (u) {
        return /^turns?:/i.test(u);
      });
      if (needsCred && !(copy.username && copy.credential)) continue;
      copy.urls = kept;
      delete copy.url;
      out.push(copy);
    }
    next.iceServers = out;
    try {
      console.info("[ezscreenshare] iceServers", JSON.stringify(next.iceServers));
    } catch (e) {}
    return next;
  }
  var Orig = window.RTCPeerConnection;
  if (!Orig) return;
  var origSet = Orig.prototype.setConfiguration;
  if (origSet) {
    Orig.prototype.setConfiguration = function (cfg) {
      return origSet.call(this, rewrite(cfg));
    };
  }
  window.RTCPeerConnection = class extends Orig {
    constructor(init) {
      super(rewrite(init));
    }
  };
})();
