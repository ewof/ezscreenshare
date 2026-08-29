import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ez", {
  isElectron: true,
  getSources: () => ipcRenderer.invoke("ez:getSources"),
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
