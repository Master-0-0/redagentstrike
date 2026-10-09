"""Independent intelligence service contracts. No Cairn board dependencies."""
from typing import List, Literal, Optional
from pydantic import BaseModel, ConfigDict, Field, model_validator

Kind = Literal['ip', 'domain', 'host', 'api', 'account', 'password', 'token', 'secret', 'connection_string', 'person', 'phone', 'email', 'wechat', 'qq', 'employee_id', 'student_id', 'national_id', 'user_id']
Category = Literal['assets', 'credentials', 'identities']
Status = Literal['unverified', 'observed', 'verified', 'failed', 'revoked', 'disabled']
SECRET_KINDS = {'password', 'token', 'secret', 'connection_string'}

def category(kind):
    if kind in {'ip', 'domain', 'host', 'api'}:
        return 'assets'
    return 'credentials' if kind in SECRET_KINDS or kind == 'account' else 'identities'

class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

class Context(Model):
    workspace_path: str = Field(min_length=1, max_length=4096)
    session_id: str = Field(min_length=1, max_length=256)
    owner_session_id: Optional[str] = Field(default=None, max_length=256)

class Entity(Model):
    ref: str = Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')
    kind: Kind
    name: str = Field(min_length=1, max_length=500)
    identifier: str = Field(min_length=1, max_length=2048)
    namespace: str = Field(default='', max_length=2048)
    secret: Optional[str] = Field(default=None, min_length=1, max_length=16384)
    note: str = Field(default='', max_length=4000)
    status: Status = 'unverified'
    evidence: str = Field(default='', max_length=8000)
    observed_at: Optional[str] = Field(default=None, max_length=64)

    @model_validator(mode='after')
    def valid(self):
        if not self.name.strip() or not self.identifier.strip():
            raise ValueError('empty identifier')
        if (self.kind in SECRET_KINDS) != (self.secret is not None):
            raise ValueError('secret required only for sensitive kinds')
        if self.kind in {'account', 'person', 'employee_id', 'student_id', 'user_id'} and not self.namespace.strip():
            raise ValueError('account/person/employee_id/student_id/user_id requires namespace')
        if self.status in {'verified', 'failed', 'revoked'} and not self.evidence.strip():
            raise ValueError('verification requires evidence')
        return self

class Relation(Model):
    from_ref: str = Field(min_length=1, max_length=128)
    to_ref: str = Field(min_length=1, max_length=128)
    label: str = Field(min_length=1, max_length=100)
    basis: Literal['observed', 'declared', 'inferred'] = 'declared'
    evidence: str = Field(min_length=1, max_length=4000)

class Save(Model):
    submission_key: str = Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')
    entities: List[Entity] = Field(default_factory=list, max_length=50)
    relations: List[Relation] = Field(default_factory=list, max_length=100)

    @model_validator(mode='after')
    def valid(self):
        refs = [e.ref for e in self.entities]
        if len(refs) != len(set(refs)) or not (refs or self.relations):
            raise ValueError('unique refs and nonempty save required')
        return self

class Query(Model):
    category: Optional[Category] = None
    kind: Optional[Kind] = None
    status: Optional[Status] = None
    q: str = Field(default='', max_length=500)
    ids: List[str] = Field(default_factory=list, max_length=20)
    related_to: Optional[str] = Field(default=None, max_length=128)
    include_secrets: bool = False
    include_details: bool = False
    offset: int = Field(default=0, ge=0, le=1000000)
    limit: int = Field(default=30, ge=1, le=100)

    @model_validator(mode='after')
    def valid(self):
        if (self.include_secrets or self.include_details) and not self.ids:
            raise ValueError('explicit ids required to reveal secrets')
        if self.include_details and len(self.ids) > 5:
            raise ValueError('at most five detailed entities per query')
        return self

class AgentQuery(Query):
    context: Context

class AgentSave(Save):
    context: Context

class Workspace(Model):
    title: str = Field(min_length=1, max_length=200)
    path: str = Field(min_length=1, max_length=4096)

class Patch(Model):
    version: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=500)
    note: str = Field(default='', max_length=4000)
    status: Status
    evidence: str = Field(default='', max_length=8000)

    @model_validator(mode='after')
    def valid(self):
        if self.status in {'verified', 'failed', 'revoked'} and not self.evidence.strip():
            raise ValueError('verification requires evidence')
        return self
