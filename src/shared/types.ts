export type QualityPreset = {
  height: 480 | 720 | 1080 | 1440;
  fps: 5 | 15 | 30 | 60;
};

export type IceInfo = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type CreateRoomRequest = {
  password: string;
  hostPassword: string;
  forceTcp: boolean;
  nickname: string;
};

export type CreateRoomResponse = {
  roomId: string;
  token: string;
  livekitUrl: string;
  publicUrl: string;
  forceTcp: boolean;
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
  iceServers: IceInfo[];
  watchToken: string;
};
