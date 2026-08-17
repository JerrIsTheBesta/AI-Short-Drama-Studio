import { contextBridge, ipcRenderer } from 'electron'

export type DesktopAPI = {
  isDesktop: true
  getRoot: () => Promise<string>
  ensureProjectDir: (name: string, id: string) => Promise<string>
  listProjectDirs: () => Promise<string[]>
  readText: (filePath: string) => Promise<string>
  writeText: (filePath: string, text: string) => Promise<void>
  readBuffer: (filePath: string) => Promise<ArrayBuffer>
  writeBuffer: (filePath: string, data: ArrayBuffer) => Promise<void>
  exists: (filePath: string) => Promise<boolean>
  remove: (filePath: string) => Promise<void>
  join: (...parts: string[]) => Promise<string>
  pickFiles: (filters?: { name: string; extensions: string[] }[]) => Promise<string[]>
  pickDirectory: () => Promise<string | null>
  openPath: (filePath: string) => Promise<string>
}

const api: DesktopAPI = {
  isDesktop: true,
  getRoot: () => ipcRenderer.invoke('desktop:getRoot'),
  ensureProjectDir: (name, id) => ipcRenderer.invoke('desktop:ensureProjectDir', name, id),
  listProjectDirs: () => ipcRenderer.invoke('desktop:listProjectDirs'),
  readText: (filePath) => ipcRenderer.invoke('desktop:readText', filePath),
  writeText: (filePath, text) => ipcRenderer.invoke('desktop:writeText', filePath, text),
  readBuffer: (filePath) => ipcRenderer.invoke('desktop:readBuffer', filePath),
  writeBuffer: (filePath, data) => ipcRenderer.invoke('desktop:writeBuffer', filePath, data),
  exists: (filePath) => ipcRenderer.invoke('desktop:exists', filePath),
  remove: (filePath) => ipcRenderer.invoke('desktop:remove', filePath),
  join: (...parts) => ipcRenderer.invoke('desktop:join', parts),
  pickFiles: (filters) => ipcRenderer.invoke('desktop:pickFiles', filters),
  pickDirectory: () => ipcRenderer.invoke('desktop:pickDirectory'),
  openPath: (filePath) => ipcRenderer.invoke('desktop:openPath', filePath)
}

contextBridge.exposeInMainWorld('desktop', api)
