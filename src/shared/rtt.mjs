// WebRTC reports RTT in seconds. 0 means "not measured yet", and a report often
// contains that 0 alongside the real selected-pair RTT. Taking the minimum
// makes the displayed ping flicker between 0 and the actual value.
export function positiveRttMs(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const ms = Math.round(seconds < 10 ? seconds * 1000 : seconds);
  if (ms <= 0 || ms > 60_000) return undefined;
  return ms;
}

export function selectRttMs(stats) {
  let nominated;
  let succeeded;
  let remote;
  for (const rec of stats) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.type === "candidate-pair") {
      const ms = positiveRttMs(rec.currentRoundTripTime);
      if (ms == null) continue;
      if (rec.nominated || rec.selected) {
        if (nominated == null) nominated = ms;
      } else if (rec.state === "succeeded") {
        if (succeeded == null) succeeded = ms;
      }
    } else if (rec.type === "remote-inbound-rtp") {
      const ms = positiveRttMs(rec.roundTripTime);
      if (ms != null && remote == null) remote = ms;
    }
  }
  return nominated ?? succeeded ?? remote;
}
