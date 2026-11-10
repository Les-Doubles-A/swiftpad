// Déclarations minimales de markdown-it 14 (seules les parties utilisées).
declare module 'markdown-it' {
  export interface Token {
    type: string;
    tag: string;
    attrs: [string, string][] | null;
    map: [number, number] | null;
    nesting: number;
    level: number;
    children: Token[] | null;
    content: string;
    markup: string;
    info: string;
    block: boolean;
    hidden: boolean;
    attrGet(name: string): string | null;
    attrSet(name: string, value: string): void;
    attrIndex(name: string): number;
  }
  export interface Renderer {
    rules: Record<string, ((tokens: Token[], idx: number, options: unknown, env: unknown, self: Renderer) => string) | undefined>;
    renderToken(tokens: Token[], idx: number, options: unknown): string;
    renderInlineAsText(tokens: Token[], options: unknown, env: unknown): string;
  }
  export interface StateCore {
    tokens: Token[];
    env: Record<string, unknown>;
  }
  export interface Ruler {
    push(name: string, fn: (state: StateCore) => void): void;
  }
  export interface Options {
    html?: boolean;
    linkify?: boolean;
    typographer?: boolean;
    breaks?: boolean;
  }
  export default class MarkdownIt {
    constructor(preset?: string, options?: Options);
    constructor(options?: Options);
    renderer: Renderer;
    core: { ruler: Ruler };
    validateLink: (url: string) => boolean;
    normalizeLink: (url: string) => string;
    utils: { escapeHtml(s: string): string };
    parse(src: string, env: Record<string, unknown>): Token[];
    render(src: string, env?: Record<string, unknown>): string;
    disable(rules: string | string[], ignoreInvalid?: boolean): this;
  }
}
