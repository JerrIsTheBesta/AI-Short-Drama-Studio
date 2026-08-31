/**
 * 桌面端本地 SQLite（node:sqlite），库文件在「文档/AI-Cut/app.db」。
 * 用来存模型密钥等用户配置，不走浏览器 localStorage。
 */
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

type Stmt = {
  run: (...params: unknown[]) => unknown
  get: (...params: unknown[]) => { value?: string } | undefined
}

type SqliteDb = {
  exec: (sql: string) => void
  prepare: (sql: string) => Stmt
  close: () => void
}

let db: SqliteDb | null = null
let filePath = ''

export function getDbPath() {
  return filePath
}

export async function openAppDb(root: string) {
  filePath = path.join(root, 'app.db')
  const mod = (await import('node:sqlite')) as {
    DatabaseSync: new (p: string) => SqliteDb
  }
  db = new mod.DatabaseSync(filePath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  migrateLegacySettingsJson(root)
  return filePath
}

function migrateLegacySettingsJson(root: string) {
  if (kvGet('settings')) return
  const jsonPath = path.join(root, 'settings.json')
  if (!existsSync(jsonPath)) return
  try {
    const text = readFileSync(jsonPath, 'utf8').trim()
    if (text) kvSet('settings', text)
  } catch {
    /* ignore broken json */
  }
}

export function kvGet(key: string): string | null {
  if (!db) return null
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
  return typeof row?.value === 'string' ? row.value : null
}

export function kvSet(key: string, value: string) {
  if (!db) throw new Error('sqlite 未打开')
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now())
}

export function closeAppDb() {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
  db = null
}
