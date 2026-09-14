export type QualityPreset = {
  height: 480 | 720 | 1080 | 1440;
  fps: 5 | 15 | 24 | 25 | 30 | 60;
};

export type IceInfo = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type CreateRoomRequest = {
  previews?: boolean;
  password: string;
  hostPassword: string;
  forceTcp: boolean;
  showViewers: boolean;
  nickname: string;
};

export type CreateRoomResponse = {
  roomId: string;
  token: string;
  livekitUrl: string;
  publicUrl: string;
  forceTcp: boolean;
  showViewers: boolean;
  iceServers: IceInfo[];
  ingestToken: string;
};

export type JoinRoomRequest = {
  password: string;
  nickname: string;
};

export type JoinRoomResponse = {
  roomId: string;
  token: string;
  livekitUrl: string;
  forceTcp: boolean;
  showViewers: boolean;
  iceServers: IceInfo[];
  watchToken: string;
};
