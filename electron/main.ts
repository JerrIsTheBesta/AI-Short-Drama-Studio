/// <reference types="vite-plugin-electron/electron-env" />
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  net
} from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aicuts',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  }
])

const ROOT_NAME = 'AI-Cut'

function defaultRoot() {
  return path.join(app.getPath('documents'), ROOT_NAME)
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true })
}

function slugName(name: string, id: string) {
  const s = (name || 'project')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48)
  return `${s}_${id}`
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: 'AI Cut',
    backgroundColor: '#0a0a14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(async () => {
  await ensureDir(defaultRoot())

  protocol.handle('aicuts', (request) => {
    try {
      const u = new URL(request.url)
      const filePath = u.searchParams.get('path')
      if (!filePath) return new Response('missing path', { status: 400 })
      return net.fetch(pathToFileURL(filePath).toString())
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
  })

  ipcMain.handle('desktop:getRoot', async () => {
    const root = defaultRoot()
    await ensureDir(root)
    return root
  })

  ipcMain.handle('desktop:ensureProjectDir', async (_e, name: string, id: string) => {
    const dir = path.join(defaultRoot(), slugName(name, id))
    await ensureDir(path.join(dir, 'assets', 'images'))
    await ensureDir(path.join(dir, 'assets', 'videos'))
    await ensureDir(path.join(dir, 'assets', 'audio'))
    await ensureDir(path.join(dir, 'thumbs'))
    return dir
  })

  ipcMain.handle('desktop:listProjectDirs', async () => {
    const root = defaultRoot()
    await ensureDir(root)
    const names = await fs.readdir(root, { withFileTypes: true })
    const out: string[] = []
    for (const d of names) {
      if (!d.isDirectory()) continue
      const jsonPath = path.join(root, d.name, 'project.json')
      if (existsSync(jsonPath)) out.push(path.join(root, d.name))
    }
    return out
  })

  ipcMain.handle('desktop:readText', async (_e, filePath: string) => {
    return fs.readFile(filePath, 'utf8')
  })

  ipcMain.handle('desktop:writeText', async (_e, filePath: string, text: string) => {
    await ensureDir(path.dirname(filePath))
    await fs.writeFile(filePath, text, 'utf8')
  })

  ipcMain.handle('desktop:readBuffer', async (_e, filePath: string) => {
    const buf = await fs.readFile(filePath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })

  ipcMain.handle('desktop:writeBuffer', async (_e, filePath: string, data: ArrayBuffer) => {
    await ensureDir(path.dirname(filePath))
    await fs.writeFile(filePath, Buffer.from(data))
  })

  ipcMain.handle('desktop:exists', async (_e, filePath: string) => existsSync(filePath))

  ipcMain.handle('desktop:remove', async (_e, filePath: string) => {
    await fs.rm(filePath, { recursive: true, force: true })
  })

  ipcMain.handle('desktop:join', (_e, parts: string[]) => path.join(...parts))

  ipcMain.handle('desktop:pickFiles', async (_e, filters?: Electron.FileFilter[]) => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? undefined, {
      properties: ['openFile', 'multiSelections'],
      filters: filters ?? [{ name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'mp3', 'wav'] }]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('desktop:pickDirectory', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win ?? undefined, {
      properties: ['openDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('desktop:openPath', async (_e, filePath: string) => {
    return shell.openPath(filePath)
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
