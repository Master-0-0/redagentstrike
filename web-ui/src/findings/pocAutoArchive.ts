import { prepare, submit, type Prepared } from './api'
import { pocDraft } from './pocDraft'
import type { FindingInput, Gap, Receipt } from './types'
import type { PocScanReport } from '../network/types'

export type AutoArchiveJob = {
  id: string
  title: string
  target: string
  created_at: string
  status: 'queued' | 'uploading' | 'failed' | 'committed'
  report?: PocScanReport
  prepared?: Prepared
  receipt?: Receipt
  error?: string
}
const jobs = new Map<string, AutoArchiveJob>()
const listeners = new Set<() => void>()
const running = new Set<string>()
let snapshot: AutoArchiveJob[] = []
let initialized: Promise<void> | undefined
let database: Promise<IDBDatabase> | undefined

function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('workbench-poc-archive', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('jobs', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      database = undefined
      reject(new Error('浏览器本地归档队列不可用，请检查存储权限和空间'))
    }
  }))
}
async function savedJobs(): Promise<AutoArchiveJob[]> {
  const database = await db()
  return new Promise((resolve, reject) => {
    const request = database.transaction('jobs').objectStore('jobs').getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function persist(job: AutoArchiveJob) {
  const database = await db()
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('jobs', 'readwrite')
    tx.objectStore('jobs').put(job)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(new Error('待归档材料无法保存到浏览器，请检查存储空间后重试'))
    tx.onabort = () => reject(new Error('本地归档队列写入中断，请重试'))
  })
}
function publish(job: AutoArchiveJob) {
  jobs.set(job.id, job)
  snapshot = [...jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
  listeners.forEach((fn) => fn())
}
export const subscribeAutoArchive = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const autoArchiveSnapshot = () => snapshot
export function initializeAutoArchive() {
  return (initialized ??= savedJobs()
    .then((rows) => {
      for (const row of rows)
        publish(
          row.status === 'queued' || row.status === 'uploading'
            ? {
                ...row,
                status: 'failed',
                error: '上次归档未完成，材料已保留；点击重试会复用同一提交',
              }
            : row,
        )
    })
    .catch((error) => {
      initialized = undefined
      throw error
    }))
}

async function prepareJob(job: AutoArchiveJob): Promise<Prepared> {
  const report = job.report!
  const draft = await pocDraft(report, report.results[0])
  const uploads = draft.uploads ?? []
  const finding: FindingInput = {
    title: job.title,
    target: job.target,
    summary: 'PoC 模板命中，待人工复核。',
    severity: 'unknown',
    preconditions: '模板命中；实际利用前提尚未人工确认。',
    steps: [{ id: 'step-1', description: '查看已有模板扫描结果与证据。' }],
    expected_result: '目标不应出现模板定义的风险特征；具体安全边界待人工核对。',
    actual_result: '模板匹配条件成立，尚未人工确认漏洞。',
    agent_assessment: 'suspected',
    ...draft.finding,
  }
  const evidence_gaps: Gap[] = []
  if (!uploads.some((a) => a.kind === 'poc'))
    evidence_gaps.push({ category: 'poc', status: 'missing', reason: '未取得模板文件' })
  if (!uploads.some((a) => a.kind.startsWith('http_')) && !draft.network_refs?.length)
    evidence_gaps.push({
      category: 'http',
      status: 'missing',
      reason: '扫描结果未提供响应文件或明确网络引用',
    })
  if (!uploads.some((a) => a.kind.endsWith('_screenshot')))
    evidence_gaps.push({
      category: 'screenshot',
      status: 'missing',
      reason: '未生成响应截图；页面截图也未采集',
    })
  if (!uploads.some((a) => a.kind === 'tool_output'))
    evidence_gaps.push({ category: 'tool_output', status: 'missing', reason: '未保存扫描输出' })
  return prepare(
    {
      op: 'create',
      finding,
      source: { source_type: 'manual' },
      network_refs: draft.network_refs ?? [],
      evidence_gaps,
      occurrence_id: job.id,
      note: 'PoC 页命中后自动归档；不是 Agent 或人工确认。',
    },
    uploads,
  )
}

export async function retryAutoArchive(id: string) {
  if (running.has(id)) return
  running.add(id)
  const perform = async () => {
    let job = jobs.get(id)
    if (!job || job.status === 'committed') return
    try {
      // Another tab may have already prepared or committed the same queued item.
      const persisted = (await savedJobs()).find((row) => row.id === id)
      job = persisted ?? job
      if (job.status === 'committed') {
        publish(job)
        return
      }
      job = { ...job, status: 'uploading', error: undefined }
      await persist(job)
      publish(job)
      if (!job.prepared) {
        job = { ...job, prepared: await prepareJob(job) }
        // Persist the exact key and file copies before making any submission.
        await persist(job)
        publish(job)
      }
      const receipt = await submit(job.prepared!)
      if (!receipt.ok) throw new Error('未收到归档成功回执')
      job = {
        ...job,
        status: 'committed',
        receipt,
        report: undefined,
        prepared: undefined,
        error: undefined,
      }
      publish(job)
      try {
        await persist(job)
      } catch {
        publish({ ...job, error: '服务端已归档；本地回执保存失败，刷新后可用原提交重试确认。' })
      }
    } catch (error) {
      if (!job) return
      job = {
        ...job,
        status: 'failed',
        error: error instanceof Error ? error.message : '自动归档失败',
      }
      publish(job)
      try {
        await persist(job)
      } catch {
        publish({ ...job, error: `${job.error}；本地副本保存失败，请勿关闭此页面。` })
      }
    }
  }
  try {
    if (navigator.locks) await navigator.locks.request(`poc-auto-archive:${id}`, perform)
    else await perform()
  } finally {
    running.delete(id)
  }
}

export async function enqueuePocReport(report: PocScanReport) {
  await initializeAutoArchive()
  const scanId = report.scan_id || crypto.randomUUID()
  const ids: string[] = []
  for (const result of report.results.filter((result) => result.matched)) {
    const id = `${scanId}:${result.template_id}`
    if (jobs.has(id)) continue
    const job: AutoArchiveJob = {
      id,
      title: result.name,
      target: report.target,
      created_at: new Date().toISOString(),
      status: 'queued',
      report: { ...report, scan_id: scanId, results: [result] },
    }
    publish(job)
    try {
      await persist(job)
      ids.push(id)
    } catch (e) {
      publish({
        ...job,
        status: 'failed',
        error: `${e instanceof Error ? e.message : '本地存储失败'}；请勿关闭页面，修复后点击重试。`,
      })
    }
  }
  // Sequential, bounded attempts; a failed item never prevents other hits saving.
  for (const id of ids) await retryAutoArchive(id)
}
