/**
 * A2UI 消息类型定义
 *
 * 对齐 A2UI v0.9 规范：
 * - Generative 模式：Agent 从组件目录动态拼装 UI（对话框）
 * - Template 模式：Agent 选择模板 + 填充变量（报告）
 */

// ─── Component Types (auto-generated from catalog) ───

/** 步骤状态 */
export type StepStatus = 'pending' | 'active' | 'completed' | 'failed' | 'skipped';

/** 步骤序号 */
export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** 步骤名称 */
export type StepName = '初始化' | '上下文分析' | '用例生成' | '脚本生成' | '测试执行' | '诊断修复' | '报告产出';

/** 错误分类 */
export type ErrorCategory = 'A_framework' | 'B_business' | 'C_data' | 'D_environment';

/** 修复类型 */
export type FixType = 'auto_fix' | 'suggestion' | 'skip';

/** 风险等级 */
export type RiskLevel = 'low' | 'medium' | 'high';

/** 按钮样式 */
export type ActionVariant = 'primary' | 'default' | 'danger';

/** 用例状态 */
export type CaseStatus = 'pass' | 'fail' | 'skip';

// ─── A2UI Message Types ───

/** A2UI 消息模式 */
export type A2UIMode = 'generative' | 'template';

/** Generative 模式消息 — Agent 推送原子组件 */
export interface GenerativeMessage {
    mode: 'generative';
    /** 唯一标识，同 id 的消息可增量更新 */
    id: string;
    /** 组件类型，必须从 catalog 中选择 */
    type: string;
    /** 组件属性，必须符合 catalog 中对应组件的 props Schema */
    props: Record<string, unknown>;
    /** 是否为增量更新（同 id 覆盖之前的 props） */
    update?: boolean;
}

/** Template 模式消息 — Agent 选择模板并填充变量 */
export interface TemplateMessage {
    mode: 'template';
    /** 模板 ID，必须从 templates 中选择 */
    templateId: string;
    /** 模板变量，必须符合 templates 中对应模板的 requiredVars + optionalVars */
    vars: Record<string, unknown>;
}

/** A2UI 消息联合类型 */
export type AgentUIMessage = GenerativeMessage | TemplateMessage;

// ─── Catalog Types ───

/** 组件目录中的组件定义 */
export interface CatalogComponent {
    description: string;
    when: string;
    props: Record<string, unknown>; // JSON Schema object
}

/** 组件目录 */
export interface A2UICatalog {
    $schema: string;
    name: string;
    description: string;
    components: Record<string, CatalogComponent>;
}

/** 模板目录中的变量定义 */
export interface TemplateVarDef {
    type: string;
    description?: string;
    enum?: string[];
    items?: Record<string, unknown>;
    properties?: Record<string, unknown>;
}

/** 模板目录中的模板定义 */
export interface CatalogTemplate {
    description: string;
    layout: Array<{ slot: string; component: string }>;
    requiredVars: Record<string, TemplateVarDef>;
    optionalVars?: Record<string, TemplateVarDef>;
}

/** 模板目录 */
export interface A2UITemplates {
    $schema: string;
    name: string;
    description: string;
    templates: Record<string, CatalogTemplate>;
}

// ─── Validation Result ───

export interface ValidationResult {
    valid: boolean;
    errors?: Array<{
        message: string;
        path: string;
    }>;
}
