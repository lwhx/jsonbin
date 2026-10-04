export type SearchKind = 'bin' | 'collection' | 'schema';
export type SearchType = SearchKind | 'all';
export type SearchItem = { type: SearchKind; id: string; name: string; description: string; updatedAt: string;
  collectionId?: string | null; collectionName?: string | null; expiresAt?: string | null };
export type SearchPage = { items: SearchItem[]; nextCursor: string | null; source: 'kv' | 'r2' };
export type SearchIndexStatus = { configured: boolean; available: boolean; current: boolean; builtAt: string | null; count: number };
export type SearchQuery = { q: string; type: SearchType; limit: number; cursor?: string };
