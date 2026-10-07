"""Version-one archive wire contract; filesystem paths are never accepted."""
from typing import List, Optional, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

class Step(Model):
    id: str = Field(min_length=1, max_length=128)
    description: str = Field(min_length=1)
    artifact_client_ids: List[str] = Field(default_factory=list)

class Finding(Model):
    title: str = Field(min_length=1, max_length=500)
    target: str = Field(min_length=1, max_length=4096)
    summary: str = Field(min_length=1)
    severity: Literal['unknown', 'info', 'low', 'medium', 'high', 'critical']
    preconditions: str = Field(min_length=1)
    steps: List[Step] = Field(min_length=1)
    expected_result: str = Field(min_length=1)
    actual_result: str = Field(min_length=1)
    agent_assessment: Literal['suspected', 'reproduced']

class Fact(Model):
    id: str
    description: str

class Source(Model):
    source_type: Literal['cairn', 'manual']
    workspace_id: Optional[str] = None
    workspace_path: Optional[str] = None
    session_id: Optional[str] = None
    owner_session_id: Optional[str] = None
    owner_resolution: Literal['resolved', 'unresolved', 'not_applicable'] = 'not_applicable'
    fact_snapshots: List[Fact] = Field(default_factory=list)

class Artifact(Model):
    client_id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')
    kind: Literal['poc', 'http_request', 'http_response', 'browser_screenshot', 'response_screenshot', 'tool_output', 'attachment']
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0)
    sha256: str = Field(pattern=r'^[a-f0-9]{64}$')
    media_type: str = Field(pattern=r'^[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+$')
    description: str = ''
    step_ids: List[str] = Field(default_factory=list)
    capture_method: str = 'submitted_file'
    captured_at: Optional[str] = None
    page_url: Optional[str] = None
    execution_note: str = ''

class NetworkRef(Model):
    event_id: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    step_ids: List[str] = Field(default_factory=list)

class Gap(Model):
    category: Literal['poc', 'http', 'screenshot', 'tool_output', 'description']
    status: Literal['missing', 'not_applicable']
    reason: str = Field(min_length=1)

class Manifest(Model):
    submission_key: str = Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')
    content_digest: Optional[str] = Field(default=None, pattern=r'^[a-f0-9]{64}$')
    op: Literal['create', 'append']
    finding: Optional[Finding] = None
    finding_id: Optional[str] = None
    note: str = ''
    occurrence_id: Optional[str] = None
    source: Source
    artifacts: List[Artifact] = Field(default_factory=list)
    network_refs: List[NetworkRef] = Field(default_factory=list)
    evidence_gaps: List[Gap] = Field(default_factory=list)
    resolved_gap_ids: List[str] = Field(default_factory=list)

    @model_validator(mode='after')
    def valid(self):
        if self.op == 'create' and (self.finding is None or self.finding_id or self.resolved_gap_ids):
            raise ValueError('create requires finding, without finding_id/resolved_gap_ids')
        if self.op == 'append' and (not self.finding_id or self.finding is not None):
            raise ValueError('append requires finding_id, without finding')
        if self.resolved_gap_ids and not (self.note.strip() or self.artifacts or self.network_refs):
            raise ValueError('resolving gaps requires note or evidence')
        ids = [a.client_id for a in self.artifacts]
        if len(ids) != len(set(ids)):
            raise ValueError('duplicate client_id')
        if self.source.source_type == 'cairn' and not (self.source.workspace_path and self.source.session_id):
            raise ValueError('cairn requires workspace and session')
        if self.source.owner_resolution == 'unresolved' and (self.source.owner_session_id or self.source.fact_snapshots):
            raise ValueError('unresolved source cannot assert owner or facts')
        if self.finding:
            steps = [s.id for s in self.finding.steps]
            if len(steps) != len(set(steps)):
                raise ValueError('duplicate step id')
            if any(c not in ids for s in self.finding.steps for c in s.artifact_client_ids):
                raise ValueError('unknown artifact step reference')
        return self
