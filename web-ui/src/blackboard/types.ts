export type BlackboardListItem = {
  owner_id: string
  title: string | null
  status: string | null
  mtime: string
}

export type BlackboardWorkspace = {
  id: string
  title: string
  path: string
  boards: BlackboardListItem[]
}

export type BlackboardCatalog = {
  dsh_home: string
  workspaces: BlackboardWorkspace[]
}

export type BlackboardFile = {
  workspace_id: string
  owner_id: string
  path: string
  text: string
}
