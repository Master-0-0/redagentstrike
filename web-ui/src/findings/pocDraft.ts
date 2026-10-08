import { fetchPocTemplate } from '../network/api'
import type { PocScanReport, PocScanResult } from '../network/types'
import { api } from './api'
import type { Draft, NetworkRef, Upload } from './types'
export async function pocDraft(report: PocScanReport, result: PocScanResult): Promise<Draft> {
  const uploads: Upload[] = [
    {
      file: new File(
        [
          JSON.stringify(
            {
              scan_id: report.scan_id,
              target: report.target,
              template_id: result.template_id,
              matched: result.matched,
              attempts: result.attempts,
            },
            null,
            2,
          ),
        ],
        'scan-result.json',
        { type: 'application/json' },
      ),
      kind: 'tool_output',
      capture_method: 'poc_scan_result',
      step_ids: ['step-1'],
    },
  ]
  const template = await fetchPocTemplate(result.template_id)
  uploads.push({
    file: new File([template.content], result.id + '.yaml', { type: 'text/plain' }),
    kind: 'poc',
    capture_method: 'poc_template_at_archive_time',
    description: '归档时读取的模板；扫描执行关联见 scan-result.json。',
    step_ids: ['step-1'],
  })
  if (result.body !== null)
    uploads.push({
      file: new File([result.body], 'response.txt', { type: 'text/plain' }),
      kind: 'http_response',
      capture_method: 'poc_response_text',
      step_ids: ['step-1'],
    })
  if (result.image) {
    const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(result.image)
    if (!match) throw new Error('扫描图片不是可归档的 PNG/JPEG 数据')
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))
    uploads.push({
      file: new File([bytes], `response.${match[1]}`, { type: `image/${match[1]}` }),
      kind: 'response_screenshot',
      capture_method: 'poc_response_screenshot',
      step_ids: ['step-1'],
    })
  }
  const ids = new Set<string>()
  result.attempts.forEach((a) =>
    a.transport_attempts?.forEach((r) => {
      if (r.network_event_id) ids.add(r.network_event_id)
      r.network_requests?.forEach((n) => {
        if (n.network_event_id) ids.add(n.network_event_id)
      })
    }),
  )
  const network_refs: NetworkRef[] = await Promise.all(
    [...ids].map(async (event_id) => {
      const event = await api<{ run_id: string }>(`/network/events/${encodeURIComponent(event_id)}`)
      if (!event.run_id) throw new Error('无法确认网络事件 Run，请手工核实引用')
      return { event_id, run_id: event.run_id, step_ids: ['step-1'] }
    }),
  )
  return {
    finding: {
      title: result.name,
      target: report.target,
      summary: `模板 ${result.template_id}：${result.matched ? '命中，仍需人工复核' : '未命中或请求失败'}。`,
      severity: ['info', 'low', 'medium', 'high', 'critical'].includes(result.severity)
        ? result.severity
        : 'unknown',
      actual_result:
        result.attempts
          .map((a) => `${a.method} ${a.url} → ${a.status ?? a.error ?? '未知'}`)
          .join('\n') || '没有请求结果',
      steps: [{ id: 'step-1', description: `查看已有模板扫描结果 ${result.template_id}` }],
      agent_assessment: 'suspected',
    },
    uploads,
    network_refs,
  }
}
