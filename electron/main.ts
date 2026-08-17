/// <reference types="vite-plugin-electron/electron-env" />
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  Menu
} from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const mainDir = path.dirname(fileURLToPath(import.meta.url))

function resolvePreload() {
  for (const name of ['preload.cjs', 'preload.js', 'preload.mjs']) {
    const p = path.join(mainDir, name)
    if (existsSync(p)) return p
  }
  return path.join(mainDir, 'preload.js')
}

function mimeOf(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.mov':
      return 'video/quicktime'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.m4a':
      return 'audio/mp4'
    default:
      return 'application/octet-stream'
  }
}

/** <video> 需要 206 + Range，否则自定义协议往往只播前半段就停 */
function fileRangeResponse(filePath: string, request: Request) {
  if (!existsSync(filePath)) return new Response('not found', { status: 404 })
  const size = statSync(filePath).size
  const mime = mimeOf(filePath)
  const range = request.headers.get('range')
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
    if (!m) return new Response('invalid range', { status: 416 })
    const start = m[1] ? Number(m[1]) : 0
    const end = m[2] ? Number(m[2]) : size - 1
    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start >= size ||
      start > end
    ) {
      return new Response('range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` }
      })
    }
    const clampedEnd = Math.min(end, size - 1)
    const stream = createReadStream(filePath, { start, end: clampedEnd })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${clampedEnd}/${size}`,
        'Content-Length': String(clampedEnd - start + 1)
      }
    })
  }
  const stream = createReadStream(filePath)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size)
    }
  })
}

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
    title: '剧流 Studio',
    backgroundColor: '#0a0a14',
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const sendMax = () => {
    win.webContents.send('window:maximized', win.isMaximized())
  }
  win.on('maximize', sendMax)
  win.on('unmaximize', sendMax)

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(mainDir, '../dist/index.html'))
  }
  win.webContents.on('did-finish-load', () => {
    console.log('[electron] preload', resolvePreload(), 'desktop api via preload.cjs')
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  await ensureDir(defaultRoot())

  protocol.handle('aicuts', (request) => {
    try {
      const u = new URL(request.url)
      const filePath = u.searchParams.get('path')
      if (!filePath) return new Response('missing path', { status: 400 })
      return fileRangeResponse(filePath, request)
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

  function senderWin(e: Electron.IpcMainInvokeEvent) {
    return BrowserWindow.fromWebContents(e.sender)
  }

  ipcMain.handle('window:minimize', (e) => {
    senderWin(e)?.minimize()
  })
  ipcMain.handle('window:toggleMaximize', (e) => {
    const win = senderWin(e)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', (e) => {
    senderWin(e)?.close()
  })
  ipcMain.handle('window:isMaximized', (e) => senderWin(e)?.isMaximized() ?? false)

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((err) => {
  console.error('[electron] startup failed', err)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
