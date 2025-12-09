/**
 * Pattern 编译器 - 将 pattern 字符串编译为正则表达式
 * @module kernel/Pattern
 */

export type ParamType = 'string' | 'int' | 'snowflake' | 'enum';

export interface ParamInfo {
    name: string;
    type: ParamType;
    optional: boolean;
    enumValues?: string[];
}

export interface CompiledPattern {
    source: string;
    regex: RegExp;
    params: ParamInfo[];
    extract(input: string): Record<string, unknown> | null;
}

const REGEX_PARTS: Record<ParamType, string> = {
    string: '([^_]+)',
    int: '(-?\\d+)',
    snowflake: '(\\d{17,20})',
    enum: '',
};

function parseParam(paramStr: string): ParamInfo {
    const optional = paramStr.endsWith('?');
    const cleanParam = optional ? paramStr.slice(0, -1) : paramStr;
    const colonIndex = cleanParam.indexOf(':');

    if (colonIndex === -1) {
        return { name: cleanParam, type: 'string', optional };
    }

    const name = cleanParam.slice(0, colonIndex);
    const typeStr = cleanParam.slice(colonIndex + 1);

    const enumMatch = typeStr.match(/^enum\(([^)]+)\)$/);
    if (enumMatch) {
        const enumValues = enumMatch[1]!.split(',').map(v => v.trim());
        return { name, type: 'enum', optional, enumValues };
    }

    if (typeStr in REGEX_PARTS) {
        return { name, type: typeStr as ParamType, optional };
    }

    return { name, type: 'string', optional };
}

function buildRegexPart(param: ParamInfo): string {
    const pattern = param.type === 'enum' && param.enumValues
        ? `(${param.enumValues.join('|')})`
        : REGEX_PARTS[param.type];

    return param.optional ? `(?:_${pattern})?` : pattern;
}

function convertValue(value: string | undefined, param: ParamInfo): unknown {
    if (value === undefined) return undefined;
    if (param.type === 'int') return parseInt(value, 10);
    return value;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Pattern {
    static compile(pattern: string): CompiledPattern {
        const params: ParamInfo[] = [];
        let regexStr = '';
        let lastIndex = 0;
        const paramRegex = /\{([^}]+)\}/g;
        let match: RegExpExecArray | null;

        while ((match = paramRegex.exec(pattern)) !== null) {
            regexStr += escapeRegex(pattern.slice(lastIndex, match.index));
            const param = parseParam(match[1]!);
            params.push(param);
            regexStr += buildRegexPart(param);
            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < pattern.length) {
            regexStr += escapeRegex(pattern.slice(lastIndex));
        }

        const regex = new RegExp(`^${regexStr}$`);

        return {
            source: pattern,
            regex,
            params,
            extract(input: string): Record<string, unknown> | null {
                const execMatch = regex.exec(input);
                if (!execMatch) return null;

                const result: Record<string, unknown> = {};
                for (let i = 0; i < params.length; i++) {
                    const param = params[i]!;
                    const converted = convertValue(execMatch[i + 1], param);
                    if (converted !== undefined) {
                        result[param.name] = converted;
                    }
                }
                return result;
            },
        };
    }
}
