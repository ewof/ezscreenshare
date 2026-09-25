export type PictureQuality = "smooth" | "sharp" | "max";
export type AudioQuality = "speech" | "standard" | "high" | "max";

export function pictureQuality(value: unknown): PictureQuality;
export function audioQuality(value: unknown): AudioQuality;
export function videoBitrate(height: number, fps: number, picture?: unknown): number;
export function compatVideoBitrate(height: number, fps: number, picture?: unknown): number;
export function audioBitrate(quality?: unknown): number;
export function degradationFor(picture?: unknown): "maintain-framerate" | "maintain-resolution";
export function contentHintFor(fps: number, picture?: unknown): "motion" | "detail";
