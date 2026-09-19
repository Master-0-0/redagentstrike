import process from 'node:process'

const endpoint = '/internal/dsh/hook/check'

function fail(message) {
  console.error(`approval hook: ${message}`)
  process.exitCode = 2
}

try {
  const input = JSON.parse(await readStdin())
  const baseUrl = process.env.WORKBENCH_HOOK_URL
  if (!baseUrl) throw new Error('WORKBENCH_HOOK_URL is not set')

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!response.ok) throw new Error(`server returned HTTP ${response.status}`)

  const result = await response.json()
  validateResult(result)

  if (result.decision === 'allow') {
    // A successful hook with no output allows the tool call.
  } else if (result.decision === 'ask') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        ...(result.reason === undefined ? {} : { permissionDecisionReason: result.reason }),
      },
    }))
  } else {
    fail(result.reason ?? 'tool call denied')
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function validateResult(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('server returned invalid JSON')
  }
  if (!['allow', 'ask', 'deny'].includes(value.decision)) {
    throw new Error('server returned an invalid decision')
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    throw new Error('server returned an invalid reason')
  }
}
