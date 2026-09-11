'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// The visualizer card gets exactly these doors and nothing else.
contextBridge.exposeInMainWorld('panel', {
  onState: (fn) => ipcRenderer.on('panel:state', (_e, s) => fn(s)),
  onLevel: (fn) => ipcRenderer.on('panel:level', (_e, v) => fn(v)),
  send: (channel) => {
    const allowed = ['panel:stop', 'panel:discard', 'panel:hide', 'panel:ask-discard', 'panel:keep']
    if (allowed.includes(channel)) ipcRenderer.send(channel)
  }
})
