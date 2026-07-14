/**
 * A2UI SchemaManager
 *
 * 对齐 A2UI v0.9 官方 5 步集成：
 * 1. 加载 catalog.json + templates.json + examples/
 * 2. 编译为 Agent system prompt 片段
 * 3. 运行时校验 Agent 推送的 AgentUIMessage
 */

import * as fs from 'fs';
import * as path from 'path';
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';
import type {
    A2UICatalog,
    A2UITemplates,
    AgentUIMessage,
    GenerativeMessage,
    TemplateMessage,
    ValidationResult,
} from './types';

export class A2uiSchemaManager {
    private catalog: A2UICatalog;
    private templates: A2UITemplates;
    private examples: AgentUIMessage[] = [];
    private ajv: any;
    private validators: Map<string, ValidateFunction> = new Map();
    private templateValidators: Map<string, ValidateFunction> = new Map();

    constructor(
        catalog: A2UICatalog,
        templates: A2UITemplates,
        examples?: AgentUIMessage[],
    ) {
        this.catalog = catalog;
        this.templates = templates;
        this.ajv = new Ajv2020({ strict: false, allErrors: true }) as any;
        if (examples) {
            this.examples = examples;
        }
        this.compileValidators();
    }

    // ─── Factory ───

    /**
     * 从 skills/ 目录加载 catalog + templates + examples
     */
    static fromSkillsDir(skillsDir?: string): A2uiSchemaManager {
        const dir = skillsDir || path.resolve(
            __dirname, '..', 'skills',
        );

        const catalog = JSON.parse(
            fs.readFileSync(path.join(dir, 'a2ui-catalog.json'), 'utf-8'),
        ) as A2UICatalog;

        const templates = JSON.parse(
            fs.readFileSync(path.join(dir, 'a2ui-templates.json'), 'utf-8'),
        ) as A2UITemplates;

        // Load examples
        const examplesDir = path.join(dir, 'examples');
        const examples: AgentUIMessage[] = [];
        if (fs.existsSync(examplesDir)) {
            for (const file of fs.readdirSync(examplesDir).filter((f: string) => f.endsWith('.json'))) {
                const ex = JSON.parse(
                    fs.readFileSync(path.join(examplesDir, file), 'utf-8'),
                ) as AgentUIMessage;
                examples.push(ex);
            }
        }

        return new A2uiSchemaManager(catalog, templates, examples);
    }

    // ─── Validators ───

    private compileValidators(): void {
        // Compile validators for each component in catalog
        for (const [name, comp] of Object.entries(this.catalog.components)) {
            const schema = {
                type: 'object',
                required: ['mode', 'id', 'type', 'props'],
                properties: {
                    mode: { type: 'string', const: 'generative' },
                    id: { type: 'string' },
                    type: { type: 'string', const: name },
                    props: comp.props as Record<string, unknown>,
                    update: { type: 'boolean' },
                },
                additionalProperties: false,
            };
            this.validators.set(name, this.ajv.compile(schema));
        }

        // Compile validators for each template
        for (const [id, tmpl] of Object.entries(this.templates.templates)) {
            const requiredVars = tmpl.requiredVars as Record<string, unknown>;
            const optionalVars = tmpl.optionalVars || {};

            // Build vars schema: required props + optional props
            const varsProperties: Record<string, unknown> = {};
            const requiredKeys: string[] = [];

            for (const [key, def] of Object.entries(requiredVars)) {
                varsProperties[key] = def;
                requiredKeys.push(key);
            }
            for (const [key, def] of Object.entries(optionalVars)) {
                varsProperties[key] = def;
            }

            const schema = {
                type: 'object',
                required: ['mode', 'templateId', 'vars'],
                properties: {
                    mode: { type: 'string', const: 'template' },
                    templateId: { type: 'string', const: id },
                    vars: {
                        type: 'object',
                        required: requiredKeys,
                        properties: varsProperties,
                    },
                },
                additionalProperties: false,
            };
            this.templateValidators.set(id, this.ajv.compile(schema));
        }
    }

    // ─── Validation ───

    validate(msg: AgentUIMessage): ValidationResult {
        if (msg.mode === 'generative') {
            const genMsg = msg as GenerativeMessage;
            const genValidator = this.validators.get(genMsg.type);
            if (!genValidator) {
                return {
                    valid: false,
                    errors: [{ message: `Unknown component type: ${genMsg.type}`, path: '/type' }],
                };
            }
            const compValidator = genValidator;
            const valid = compValidator(genMsg) as boolean;
            if (!valid && (compValidator as any).errors) {
                return {
                    valid: false,
                    errors: ((compValidator as any).errors as any[]).map((e: any) => ({
                        message: e.message || 'Validation error',
                        path: e.instancePath,
                    })),
                };
            }
            return { valid: true };
        }

        if (msg.mode === 'template') {
            const tmplMsg = msg as TemplateMessage;
            const validator = this.templateValidators.get(tmplMsg.templateId);
            if (!validator) {
                return {
                    valid: false,
                    errors: [{ message: `Unknown template ID: ${tmplMsg.templateId}`, path: '/templateId' }],
                };
            }
            const tmplValidator = validator;
            const valid = tmplValidator(tmplMsg) as boolean;
            if (!valid && (tmplValidator as any).errors) {
                return {
                    valid: false,
                    errors: ((validator as any).errors as any[]).map((e: any) => ({
                        message: e.message || 'Validation error',
                        path: e.instancePath,
                    })),
                };
            }
            return { valid: true };
        }

        return {
            valid: false,
            errors: [{ message: `Invalid mode: ${(msg as any).mode}`, path: '/mode' }],
        };
    }

    // ─── System Prompt Generation ───

    /**
     * 生成 A2UI 相关的 system prompt 片段
     * 注入 Agent 的 system prompt 中
     */
    generateSystemPrompt(roleDescription: string): string {
        const catalogSection = this.compileCatalogToPrompt();
        const templatesSection = this.compileTemplatesToPrompt();
        const examplesSection = this.compileExamplesToPrompt();

        return `${roleDescription}

${catalogSection}

${templatesSection}

${examplesSection}

## A2UI 输出规则
1. 只能从上述组件目录选择组件，不能自创组件
2. props 必须按 Schema 填充，不能省略 required 字段
3. 同 id 的 generative 消息可增量更新（设置 update: true 覆盖之前的 props）
4. 诊断完成后推送 template 模式的报告
5. 输出格式为 JSON，每行一条消息`;
    }

    private compileCatalogToPrompt(): string {
        const components = Object.entries(this.catalog.components)
            .map(([name, comp]) => {
                const propsStr = JSON.stringify(comp.props, null, 2)
                    .split('\n')
                    .map(l => '    ' + l)
                    .join('\n');
                return `### ${name}
${comp.description}
何时推送: ${comp.when}
Props Schema:
${propsStr}`;
            })
            .join('\n\n');

        return `## A2UI 组件目录 (Generative 模式)
你可以通过推送 A2UI 消息来渲染 UI 组件。只能从以下目录选择。

${components}`;
    }

    private compileTemplatesToPrompt(): string {
        const templates = Object.entries(this.templates.templates)
            .map(([id, tmpl]) => {
                const requiredStr = Object.entries(tmpl.requiredVars)
                    .map(([k, v]) => `  ${k}: ${(v as any).type} — ${(v as any).description || ''}`)
                    .join('\n');
                const optionalStr = tmpl.optionalVars
                    ? Object.entries(tmpl.optionalVars)
                        .map(([k, v]) => `  ${k}: ${(v as any).type} — ${(v as any).description || ''}`)
                        .join('\n')
                    : '  (无)';
                return `### ${id}
${tmpl.description}
必填变量:
${requiredStr}
可选变量:
${optionalStr}`;
            })
            .join('\n\n');

        return `## A2UI 报告模板 (Template 模式)
测试完成时选择模板并填充变量。

${templates}`;
    }

    private compileExamplesToPrompt(): string {
        if (this.examples.length === 0) return '';

        const examplesStr = this.examples
            .map((ex, i) => `### 示例 ${i + 1}: ${ex.mode === 'generative' ? (ex as GenerativeMessage).type : (ex as TemplateMessage).templateId}
\`\`\`json
${JSON.stringify(ex, null, 2)}
\`\`\``)
            .join('\n\n');

        return `## A2UI 输出示例
${examplesStr}`;
    }

    // ─── Getters ───

    getCatalog(): A2UICatalog {
        return this.catalog;
    }

    getTemplates(): A2UITemplates {
        return this.templates;
    }

    getComponentNames(): string[] {
        return Object.keys(this.catalog.components);
    }

    getTemplateIds(): string[] {
        return Object.keys(this.templates.templates);
    }
}
