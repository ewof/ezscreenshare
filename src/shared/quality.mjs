// Screen-share bitrate ceilings. "smooth" is the older cap, which lets a 1080p
// stream look soft because the encoder may use far less than the resolution
// needs. "sharp" matches a 1080p30 screen preset (5 Mb/s). "max" raises it further.
const SCALE = { smooth: 1, sharp: 2, max: 3 };

const AUDIO_BITRATE = {
  speech: 32_000,
  standard: 96_000,
  high: 160_000,
  max: 256_000,
};

export function pictureQuality(value) {
  return value === "smooth" || value === "sharp" || value === "max" ? value : "max";
}

export function audioQuality(value) {
  return value === "speech" || value === "standard" || value === "high" || value === "max" ? value : "speech";
}

function baseVideoBitrate(height, fps) {
  const table = {
    480: { 5: 350_000, 15: 500_000, 24: 700_000, 25: 700_000, 30: 700_000, 60: 1_000_000 },
    720: { 5: 500_000, 15: 800_000, 24: 1_000_000, 25: 1_050_000, 30: 1_200_000, 60: 2_000_000 },
    1080: { 5: 800_000, 15: 1_400_000, 24: 1_800_000, 25: 1_900_000, 30: 2_500_000, 60: 4_000_000 },
    1440: { 5: 1_200_000, 15: 2_200_000, 24: 3_200_000, 25: 3_400_000, 30: 4_000_000, 60: 6_000_000 },
  };
  const row = height <= 480 ? table[480] : height <= 720 ? table[720] : height <= 1080 ? table[1080] : table[1440];
  return row[fps] ?? row[30] ?? 1_200_000;
}

export function videoBitrate(height, fps, picture) {
  const mode = pictureQuality(picture);
  const cap = mode === "max" ? 12_000_000 : 8_000_000;
  return Math.min(cap, Math.round(baseVideoBitrate(height, fps) * SCALE[mode]));
}

export function compatVideoBitrate(height, fps, picture) {
  const mode = pictureQuality(picture);
  return Math.min(videoBitrate(height, fps, mode), mode === "smooth" ? 4_000_000 : 8_000_000);
}

export function audioBitrate(quality) {
  return AUDIO_BITRATE[audioQuality(quality)];
}

export function degradationFor(picture) {
  return pictureQuality(picture) === "smooth" ? "maintain-framerate" : "maintain-resolution";
}

export function contentHintFor(fps, picture) {
  if (pictureQuality(picture) !== "smooth") return "detail";
  return fps >= 24 ? "motion" : "detail";
}
