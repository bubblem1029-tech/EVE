/**
 * case-identity — 用例身份、用例库分组与可读展示的统一契约
 *
 * `caseId` 只承担稳定对齐职责；分组名、分组路径和展示名都必须独立建模。
 * 用例库目录名里的 `(0/42)` 是动态执行统计，不能进入身份字段。
 */

export interface CaseGroupStats {
  passed: number;
  total: number;
}

/** 用例库目录树节点；chain 约定为「根 → 直接父分组」。 */
export interface CaseGroupNode {
  id?: string | number | null;
  name?: string | null;
  parentId?: string | number | null;
}

export interface CaseGroupInfo {
  groupId: string;
  groupName: string;
  groupPath: string;
  groupRawName: string;
  groupDepth: number;
  groupStats?: CaseGroupStats;
}

export interface CaseIdentityInput {
  caseId: string;
  title?: string;
  /** 可选的机器可读短名；缺省时从 title 生成 */
  caseKey?: string;
  /** 根 → 直接父分组 */
  groupChain?: CaseGroupNode[];
  /** 已由调用方解析好的分组信息；优先于 groupChain */
  group?: Partial<CaseGroupInfo> | null;
}

export interface CaseIdentity extends CaseGroupInfo {
  caseId: string;
  /** 机器可读、稳定的短名 */
  caseName: string;
  /** 人可读标题 */
  title: string;
  /** 报表紧凑展示：`分组 · caseId · 标题` */
  displayName: string;
  /** 详情展示：`完整分组路径 · caseId · 标题` */
  detailLabel: string;
}

const GROUP_STATS_RE = /^\s*[（(]\s*(\d+)\s*\/\s*(\d+)\s*[）)]\s*/;

/** 从用例库目录名中剥离动态计数，例如 `(0/42) 参数列表`。 */
export function splitGroupName(rawName: unknown): { name: string; stats?: CaseGroupStats } {
  const raw = String(rawName ?? '').trim();
  const match = raw.match(GROUP_STATS_RE);
  if (!match) return { name: raw };
  return {
    name: raw.slice(match[0].length).trim(),
    stats: {
      passed: Number(match[1]),
      total: Number(match[2]),
    },
  };
}

/** 仅返回清洗后的分组名。 */
export function normalizeGroupName(rawName: unknown): string {
  return splitGroupName(rawName).name;
}

function normalizeGroupId(id: unknown): string {
  if (id === undefined || id === null || String(id).trim() === '' || Number(id) <= 0) return '';
  return String(id).trim();
}

function normalizeChain(chain: CaseGroupNode[] | undefined): Array<{ id: string; name: string; rawName: string; stats?: CaseGroupStats }> {
  return (Array.isArray(chain) ? chain : [])
    .map((node) => {
      const rawName = String(node?.name ?? '').trim();
      const parsed = splitGroupName(rawName);
      return {
        id: normalizeGroupId(node?.id),
        name: parsed.name,
        rawName,
        stats: parsed.stats,
      };
    })
    .filter((node) => node.name.length > 0);
}

function slugifyTitle(title: string): string {
  const slug = String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug;
}

function defaultCaseName(caseId: string, title: string): string {
  const slug = slugifyTitle(title);
  return slug || `case-${String(caseId || '').toLowerCase()}`;
}

/**
 * 生成统一用例身份。
 *
 * 分组字段优先级：显式 group > groupChain > 空值。
 * `groupName` 是直接父分组清洗后的名称；`groupPath` 是根到直接父分组的完整路径。
 */
export function buildCaseIdentity(input: CaseIdentityInput): CaseIdentity {
  const caseId = String(input.caseId || '').trim();
  const title = String(input.title || input.caseKey || caseId).trim();
  const caseName = String(input.caseKey || '').trim() || defaultCaseName(caseId, title);

  const chain = normalizeChain(input.groupChain);
  const rawChain = chain.length
    ? chain
    : input.group?.groupName || input.group?.groupRawName
      ? [{
        id: normalizeGroupId(input.group.groupId),
        name: normalizeGroupName(input.group.groupName || input.group.groupRawName),
        rawName: String(input.group.groupRawName || input.group.groupName || '').trim(),
        stats: input.group.groupStats,
      }]
      : [];

  const immediate = rawChain[rawChain.length - 1];
  const groupName = String(input.group?.groupName || immediate?.name || '').trim();
  const groupRawName = String(input.group?.groupRawName || immediate?.rawName || '').trim();
  const groupPath = String(
    input.group?.groupPath
      || rawChain.map((node) => node.name).filter(Boolean).join(' / '),
  ).trim();
  const groupStats = input.group?.groupStats
    || immediate?.stats
    || (rawChain.length ? rawChain[rawChain.length - 1]?.stats : undefined);

  const group: CaseGroupInfo = {
    groupId: String(input.group?.groupId || immediate?.id || '').trim(),
    groupName,
    groupPath,
    groupRawName,
    groupDepth: Number(input.group?.groupDepth ?? rawChain.length),
    ...(groupStats ? { groupStats } : {}),
  };

  const compact = [group.groupName, caseId, title].filter(Boolean).join(' · ');
  const detail = [group.groupPath || group.groupName, caseId, title].filter(Boolean).join(' · ');

  return {
    caseId,
    caseName,
    title,
    ...group,
    displayName: compact,
    detailLabel: detail,
  };
}

/** 报表窄列用的紧凑标签。 */
export function formatCaseDisplayName(identity: Pick<CaseIdentity, 'groupName' | 'caseId' | 'title'>): string {
  return [identity.groupName, identity.caseId, identity.title].filter(Boolean).join(' · ');
}
