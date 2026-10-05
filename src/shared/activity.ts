export const ACTIVITY_ACTIONS = {
  'system.settings_updated': ['system', '修改系统默认设置'], 'system.exported': ['system', '导出业务备份'],
  'bin.exported': ['bin', '导出数据仓'], 'bin.imported': ['bin', '导入数据仓'],
  'collection.imported': ['collection', '导入集合'], 'schema.imported': ['schema', '导入数据模型'],
  'auth.login_succeeded': ['auth', '登录成功'], 'auth.login_failed': ['auth', '登录失败'],
  'bin.created': ['bin', '创建数据仓'], 'bin.updated': ['bin', '更新数据仓 JSON'],
  'bin.metadata_updated': ['bin', '修改数据仓设置'], 'bin.version_restored': ['bin', '恢复历史版本'],
  'bin.deleted': ['bin', '删除数据仓'], 'bin.restored': ['bin', '恢复数据仓'],
  'bin.purged': ['bin', '永久删除数据仓'], 'bin.expired': ['bin', '数据仓到期归档'],
  'collection.created': ['collection', '创建集合'], 'collection.updated': ['collection', '修改集合'], 'collection.deleted': ['collection', '删除集合'],
  'schema.created': ['schema', '创建数据模型'], 'schema.updated': ['schema', '修改数据模型'], 'schema.deleted': ['schema', '删除数据模型'],
  'template.created': ['template', '创建模板'], 'template.updated': ['template', '修改模板'], 'template.deleted': ['template', '删除模板'], 'template.imported': ['template', '导入模板'],
  'key.created': ['key', '创建 API 密钥'], 'key.revoked': ['key', '撤销 API 密钥'], 'key.deleted': ['key', '永久删除 API 密钥'],
} as const;
export type ActivityAction = keyof typeof ACTIVITY_ACTIONS;
export type ActivityResourceType = 'system' | 'auth' | 'bin' | 'collection' | 'schema' | 'key' | 'template';
export type ActivityIdentity = { actor: { type: 'session' | 'api_key' | 'anonymous' | 'system'; id: string | null };
  provider: 'password' | 'github' | 'api_key' | 'anonymous' | 'system' };
export type ActivityEntry = ActivityIdentity & { id: string; action: ActivityAction; resourceType: ActivityResourceType;
  resourceId: string | null; timestamp: string; summary: string; requestId: string };
export type ActivityInput = { action: ActivityAction; resourceId: string | null; identity: ActivityIdentity; requestId: string };
export type ActivityQuery = { limit?: number; cursor?: string; action?: ActivityAction; resourceType?: ActivityResourceType };
export type ActivityPage = { items: ActivityEntry[]; nextCursor: string | null; retentionLimit: 2000 };
