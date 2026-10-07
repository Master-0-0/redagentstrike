import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { archiveFinding } from './archive.ts'
import { ARCHIVE_GUIDANCE } from './guidance.ts'
export const name = 'dsh-findings'
export const inject = ['tools', 'systemPrompt']
export function apply(ctx: Context, config: { apiUrl?: string; timeoutMs?: number } = {}) {
  // The host system-prompt registry is layered by the enabling preset's scope.
  ctx
    .get('systemPrompt')
    .section({ name: 'findings-archive-default', order: 850, text: ARCHIVE_GUIDANCE })
  ctx.tools.register(
    defineTool({
      name: 'archive_finding',
      description:
        'Archive existing evidence copies without running tests or changing the blackboard. Load finding-archive for the contract. create requires structured finding and explicit evidence gaps; append preserves human review; retry sends the saved outbox. Evidence files must be inside the session workspace. A reproduced assessment still starts pending human review.',
      parameters: {
        op: { type: 'string', required: true, enum: ['create', 'append', 'retry'] },
        finding: {
          type: 'json',
          description:
            'title,target,summary,severity,preconditions,steps:[{id,description,artifact_client_ids?}],expected_result,actual_result,agent_assessment (suspected/reproduced).',
        },
        finding_id: { type: 'string' },
        note: { type: 'string' },
        fact_ids: { type: 'array', items: { type: 'string' } },
        artifacts: {
          type: 'json',
          description:
            'Array of {client_id,kind,path,description?,step_ids?,capture_method?,captured_at?,execution_note?}.',
        },
        network_refs: {
          type: 'json',
          description:
            'Array of exact {event_id,run_id,step_ids?}. Never guess event/session ownership.',
        },
        evidence_gaps: {
          type: 'json',
          description:
            'Array of {category:poc|http|screenshot|tool_output|description,status:missing|not_applicable,reason}.',
        },
        resolved_gap_ids: { type: 'array', items: { type: 'string' } },
        occurrence_id: { type: 'string' },
        submission_key: { type: 'string' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: any, value: any) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },
      execute: (args: any, exec: any) => archiveFinding(args, ctx, exec, config),
    }),
  )
}
