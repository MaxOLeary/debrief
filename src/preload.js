'use strict'
const { contextBridge, ipcRenderer } = require('electron')

// The recorder page gets exactly these four doors and nothing else.
contextBridge.exposeInMainWorld('recorder', {
  onStart: (fn) => ipcRenderer.on('recorder:start', (_e, opts) => fn(opts)),
  onStop: (fn) => ipcRenderer.on('recorder:stop', () => fn()),
  send: (channel, payload) => {
    const allowed = ['recorder:ready', 'recorder:started', 'recorder:stopped', 'recorder:error', 'recorder:log', 'recorder:level']
    if (allowed.includes(channel)) ipcRenderer.send(channel, payload)
  },
  chunk: (bytes) => ipcRenderer.invoke('recorder:chunk', bytes)
})
