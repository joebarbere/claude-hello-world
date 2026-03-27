const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronKafka', {
  onWeatherEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('kafka:weather-event', listener);
    return () => ipcRenderer.removeListener('kafka:weather-event', listener);
  },

  onStatusChange: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('kafka:status', listener);
    return () => ipcRenderer.removeListener('kafka:status', listener);
  },

  onError: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('kafka:error', listener);
    return () => ipcRenderer.removeListener('kafka:error', listener);
  },

  getStatus: () => ipcRenderer.invoke('kafka:get-status'),

  reconnect: () => ipcRenderer.invoke('kafka:reconnect'),
});
