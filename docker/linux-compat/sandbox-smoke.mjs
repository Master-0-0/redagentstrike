import { Context } from '/app/deepseek-harness/vendor/cordis/lib/index.js'
import { LocalSandboxProvider } from '/app/deepseek-harness/packages/sandbox/sandbox-local/lib/index.js'
import { launcherPath, probe } from '/app/deepseek-harness/native/landlock-run/packages/entry/lib/index.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
const path = launcherPath()
console.log(JSON.stringify({launcher: path, exists: existsSync(path), probe: probe(path)}))
const ctx = new Context()
try {
  await ctx.plugin(LocalSandboxProvider, {})
  const workspaceRoot = '/root/compat-sandbox-workspace'
  mkdirSync(workspaceRoot, {recursive: true})
  for (const [mode, command] of [
    ['read-only', 'printf linux-sandbox-ok'],
    ['read-only', `touch ${workspaceRoot}/denied`],
    ['workspace-write', `touch ${workspaceRoot}/allowed`],
  ]) {
    const confined = ctx.sandbox.confine(['bash', '-c', command], {mode, workspaceRoot})
    const result = spawnSync(confined.argv[0], confined.argv.slice(1), {encoding:'utf8', timeout:10000})
    console.log(JSON.stringify({mode, command, enforcement:confined.enforcement, status:result.status, stdout:result.stdout, stderr:result.stderr, error:result.error?.message}))
    if (command.includes('/denied')) {
      if (result.status === 0 || existsSync(`${workspaceRoot}/denied`)) throw new Error('read-only confinement failed')
    } else if (result.status !== 0) throw new Error('confined command failed')
  }
  rmSync(workspaceRoot, {recursive:true})
} finally {
  await ctx.fiber.dispose()
}
