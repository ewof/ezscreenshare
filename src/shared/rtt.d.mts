export type RttSample = {
  type?: string;
  currentRoundTripTime?: number;
  roundTripTime?: number;
  nominated?: boolean;
  selected?: boolean;
  state?: string;
};

export function positiveRttMs(seconds: number | undefined | null): number | undefined;
export function selectRttMs(stats: Iterable<RttSample>): number | undefined;
