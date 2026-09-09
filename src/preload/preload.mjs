import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ez", {
  isElectron: true,
  platform: process.platform,
  audioSelectionVersion: 1,
  beginMacAudio: (selection) => ipcRenderer.invoke("ez:beginMacAudio", selection),
  onMacAudio: (callback) => {
    const data = (_event, packet) => callback(packet);
    ipcRenderer.on("ez:macAudioData", data);
    ipcRenderer.on("ez:macAudioError", data);
    return () => {
      ipcRenderer.removeListener("ez:macAudioData", data);
      ipcRenderer.removeListener("ez:macAudioError", data);
    };
  },
  getSources: () => ipcRenderer.invoke("ez:getSources"),
  setCaptureAudio: (on) => ipcRenderer.invoke("ez:setCaptureAudio", on),
  setCapture: (id, audio) => ipcRenderer.invoke("ez:setCapture", id, audio),
  monitorHint: () => ipcRenderer.invoke("ez:monitorHint"),
  copyText: (text) => ipcRenderer.invoke("ez:copyText", text),
  listAudioSources: () => ipcRenderer.invoke("ez:listAudioSources"),
  beginMonitorCapture: (sourceId) => ipcRenderer.invoke("ez:beginMonitorCapture", sourceId),
  endMonitorCapture: (prev) => ipcRenderer.invoke("ez:endMonitorCapture", prev),
  releaseAudioTap: () => ipcRenderer.invoke("ez:releaseAudioTap"),
  getServerUrl: () => ipcRenderer.invoke("ez:getServerUrl"),
  setServerUrl: (url) => ipcRenderer.invoke("ez:setServerUrl", url),
});
