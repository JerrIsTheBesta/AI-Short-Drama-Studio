/**
 * 剧本库存储
 *
 * 桌面端：用户所选保存目录/_scripts/
 *   index.json        剧本元数据清单
 *   <id>.md           每份剧本一份 Markdown
 * 浏览器：IndexedDB store `scripts`（每条约 100KB 以内，正文直接入库）
 */

import { toRaw } from 'vue'
import type { ScriptDoc } from '@/types'
import { desktop, isDesktop } from '@/services/desktop'
import * as idb from './idb'

const SCRIPTS_FOLDER = '_scripts'
const INDEX_FILE = 'index.json'

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value)))
}

async function scriptsDir(): Promise<string> {
  const root = await desktop().getRoot()
  return desktop().join(root, SCRIPTS_FOLDER)
}

async function indexPath(dir: string) {
  return desktop().join(dir, INDEX_FILE)
}

async function ensureDir(dir: string) {
  await desktop().writeText(await desktop().join(dir, '.keep'), '')
}

export async function listScriptDocs(): Promise<ScriptDoc[]> {
  if (!isDesktop()) return idb.listScripts()
  const dir = await scriptsDir()
  const p = await indexPath(dir)
  if (!(await desktop().exists(p))) return []
  try {
    const parsed = JSON.parse(await desktop().readText(p))
    const list = Array.isArray(parsed) ? (parsed as ScriptDoc[]) : []
    return list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  } catch {
    return []
  }
}

/** 写元数据清单（桌面端） */
export async function saveScriptMeta(doc: ScriptDoc): Promise<void> {
  if (!isDesktop()) return
  const dir = await scriptsDir()
  await ensureDir(dir)
  const list = await listScriptDocs()
  const idx = list.findIndex((item) => item.id === doc.id)
  if (idx >= 0) list[idx] = doc
  else list.unshift(doc)
  await desktop().writeText(await indexPath(dir), JSON.stringify(toPlain(list), null, 2))
}

/** 写正文 Markdown 并返回落盘路径（相对 _scripts） */
export async function saveScriptMarkdown(
  id: string,
  markdown: string
): Promise<string | undefined> {
  if (!isDesktop()) {
    await idb.putScriptText(id, markdown)
    return undefined
  }
  const dir = await scriptsDir()
  await ensureDir(dir)
  const rel = `${id}.md`
  const abs = await desktop().join(dir, rel)
  await desktop().writeText(abs, markdown)
  return rel
}

/** 一次性保存元数据 + 正文，返回实际落库的剧本 */
export async function saveScript(doc: ScriptDoc, markdown: string): Promise<ScriptDoc> {
  if (!isDesktop()) {
    await idb.putScriptRecord(doc, markdown)
    return { ...doc }
  }
  const rel = await saveScriptMarkdown(doc.id, markdown)
  const stored: ScriptDoc = { ...doc, fileRelPath: rel }
  await saveScriptMeta(stored)
  return stored
}

export async function loadScriptMarkdown(id: string): Promise<string> {
  if (!isDesktop()) return idb.getScriptText(id)
  const dir = await scriptsDir()
  const abs = await desktop().join(dir, `${id}.md`)
  if (!(await desktop().exists(abs))) return ''
  return desktop().readText(abs)
}

export async function deleteScriptDoc(id: string): Promise<void> {
  if (!isDesktop()) {
    await idb.delScript(id)
    return
  }
  const dir = await scriptsDir()
  await desktop().remove(await desktop().join(dir, `${id}.md`))
  const list = await listScriptDocs()
  await desktop().writeText(
    await indexPath(dir),
    JSON.stringify(
      toPlain(list.filter((item) => item.id !== id)),
      null,
      2
    )
  )
}

/** 桌面端：剧本文件绝对路径（用于在文件夹里打开） */
export async function scriptAbsPath(id: string): Promise<string | undefined> {
  if (!isDesktop()) return undefined
  const dir = await scriptsDir()
  const abs = await desktop().join(dir, `${id}.md`)
  return (await desktop().exists(abs)) ? abs : undefined
}

export async function scriptsDirPath(): Promise<string | undefined> {
  if (!isDesktop()) return undefined
  return scriptsDir()
}
