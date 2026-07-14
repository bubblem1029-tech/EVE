/**
 * keve-a2ui — A2UI spec for keve test platform
 *
 * 前后端共享的组件目录、类型定义、SchemaManager
 *
 * 用法：
 * - Agent 后端: import { A2uiSchemaManager } from 'keve-a2ui'
 * - EVE 前端:  import { loadCatalog, types } from 'keve-a2ui'
 */

// Types
export type {
    A2UIMode,
    GenerativeMessage,
    TemplateMessage,
    AgentUIMessage,
    CatalogComponent,
    A2UICatalog,
    TemplateVarDef,
    CatalogTemplate,
    A2UITemplates,
    ValidationResult,
    StepStatus,
    StepNumber,
    StepName,
    ErrorCategory,
    FixType,
    RiskLevel,
    ActionVariant,
    CaseStatus,
} from './types';

// SchemaManager
export { A2uiSchemaManager } from './schema-manager';

// JSON loader utilities (avoids import attribute issues)
import * as fs from 'fs';
import * as path from 'path';
import type { A2UICatalog, A2UITemplates } from './types';

const _skillsDir = path.resolve(__dirname, '..', 'skills');

/** 加载 a2ui-catalog.json */
export function loadCatalog(): A2UICatalog {
    return JSON.parse(fs.readFileSync(path.join(_skillsDir, 'a2ui-catalog.json'), 'utf-8'));
}

/** 加载 a2ui-templates.json */
export function loadTemplates(): A2UITemplates {
    return JSON.parse(fs.readFileSync(path.join(_skillsDir, 'a2ui-templates.json'), 'utf-8'));
}

/** 获取 skills 目录路径（前端可自行加载 JSON） */
export function getSkillsDir(): string {
    return _skillsDir;
}
