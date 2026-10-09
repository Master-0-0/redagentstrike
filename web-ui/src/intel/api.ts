export const kinds = { ip: 'IP', domain: '域名', host: 'Host', api: 'API 接口', account: '账号', password: '密码', token: 'Token', secret: 'Secret', connection_string: '连接串', person: '姓名', phone: '手机号', email: '邮箱', wechat: '微信', qq: 'QQ', employee_id: '工号', student_id: '学号', national_id: '身份证号', user_id: '用户 ID' }
export const statuses = { unverified: '未验证', observed: '已观察', verified: '已验证', failed: '验证失败', revoked: '已撤销', disabled: '已停用' }
export const bases = { observed: '实际观察', declared: '配置声明', inferred: '推断' }
export const categories = { assets: '资产关联', credentials: '凭证关联', identities: '身份', activity: 'Agent 读写' }
export type Category = Exclude<keyof typeof categories, 'activity'>
export type View = keyof typeof categories
export type Kind = keyof typeof kinds
export type Status = keyof typeof statuses
export const groupKinds: Record<Category, Kind[]> = { assets: ['ip', 'domain', 'host', 'api'], credentials: ['account', 'password', 'token', 'secret', 'connection_string'], identities: ['person', 'phone', 'email', 'wechat', 'qq', 'employee_id', 'student_id', 'national_id', 'user_id'] }
export const sensitive = new Set<Kind>(['password', 'token', 'secret', 'connection_string'])
export type Workspace = { id: string; title: string; path: string; count: number }
export type Entity = { id: string; workspace_id: string; category: Category; kind: Kind; name: string; identifier: string; namespace: string; status: Status; version: number; first_seen: string; last_seen: string; has_secret: boolean; note?: string; secret?: string }
export type Detail = { entity: Entity; relations: { id: string; from_id: string; to_id: string; label: string; basis: keyof typeof bases; evidence: string; target: Entity }[]; observations: { id: string; session_id: string; owner_session_id: string | null; status: Status; observed_at: string | null; created_at: string; content: { evidence?: string; note?: string; relation_id?: string; action?: string } }[]; observations_truncated: boolean; relations_truncated: boolean }
export type Activity = { id: string; operation: string; outcome: string; session_id: string; owner_session_id: string | null; object_ids: string[]; criteria: Record<string, unknown>; error_code: string | null; created_at: string }
const errors: Record<string, string> = { intel_storage_unavailable: '情报存储不可用，请检查数据库与密钥', invalid_intel_payload: '字段不符合要求；账号/姓名/工号/学号/用户 ID 需填写所属域，验证结论需提供依据', workspace_directory_missing: '工作区目录不存在，请填写本机已有目录', workspace_not_found: '工作区不存在', entity_not_found: '条目不存在或不属于当前工作区', version_conflict: '条目已被更新，请关闭编辑后重新打开', submission_conflict: '该提交 ID 已用于不同内容', invalid_ip: '请输入有效的 IPv4 或 IPv6 地址', payload_too_large: '提交内容超过 1 MiB' }
export async function intel<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/intel' + path, { ...init, signal: init.signal ?? AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', ...init.headers }, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(errors[data.error_code] || data.error_code || (response.status === 404 ? '情报接口尚未加载，请重启工作台后端后重试' : '情报服务请求失败'))
  return data
}
export const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
export const time = (value: string) => new Date(value).toLocaleString()
