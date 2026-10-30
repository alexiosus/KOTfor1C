import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify, visit } from 'yaml';
import { parseCatalogs } from './projectPropertyCatalogStore';
import { parseNumberingCatalog } from './testNumberingStore';
import { parseProjectMetadataSidecar, projectEntityKey, validateProjectGroup } from './projectLibraryStore';

export type MetadataKind = 'group' | 'sidecar' | 'imports' | 'history' | 'catalogs' | 'numbering';
export interface MetadataConflict { readonly path: string; readonly base: unknown; readonly ours: unknown; readonly theirs: unknown }
export type MetadataChoices = Readonly<Record<string, 'ours' | 'theirs'>>;
export interface MetadataMerge { readonly text: string | undefined; readonly conflicts: readonly MetadataConflict[] }
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const equal = isDeepStrictEqual;
function check(condition: unknown, label: string): asserts condition { if (!condition) { throw new Error(`Invalid KOT metadata: ${label}`); } }
function fields(value: unknown, allowed: string[]): asserts value is ObjectValue {
    check(object(value) && Object.keys(value).every(key => allowed.includes(key)), 'unsupported fields');
}
function strings(value: unknown): asserts value is string[] {
    check(Array.isArray(value) && value.every(item => typeof item === 'string' && !!item.trim() && !item.includes('\0')) && new Set(value).size === value.length, 'unique string list');
}
function key(value: unknown): void {
    check(typeof value === 'string', 'history key');
    const uid = value.startsWith('uid:') ? value.slice(4) : undefined;
    const match = /^(scenario|process):(.+)$/u.exec(value);
    check(uid ? projectEntityKey({ kind: 'scenario', uid, relativePath: 'scen.yaml' }) === value
        : match && projectEntityKey({ kind: match[1] as 'scenario' | 'process', relativePath: match[2] }) === value, 'history identity');
}
function group(value: unknown): void {
    fields(value, ['version', 'id', 'name', 'sections']);
    check(value.version === 1, 'group version');
    validateProjectGroup({ id: value.id, name: value.name, sections: value.sections, order: 0 });
}

function validate(kind: MetadataKind, value: unknown): void {
    if (value === undefined) { return; }
    check(object(value), 'document object');
    if (kind === 'sidecar') {
        check(object(value.identity), 'identity');
        const relative = value.version === 1 && typeof value.identity.relativePath === 'string' ? value.identity.relativePath : value.identity.kind === 'feature' ? 'test.feature' : 'scen.yaml';
        parseProjectMetadataSidecar(stringify(value), path.join('/kot-merge-project', `${relative}.kot.yml`), '/kot-merge-project');
        return;
    }
    check(value.version === 1, 'document version');
    if (kind === 'group') { group(value); }
    else if (kind === 'catalogs') { parseCatalogs(stringify(value)); }
    else if (kind === 'numbering') { parseNumberingCatalog(stringify(value)); }
    else if (kind === 'imports') {
        fields(value, ['version', 'legacyImports']); strings(value.legacyImports);
        check(value.legacyImports.every(scope => ['scenario', 'standalone'].includes(scope)), 'import scopes');
    } else if (kind === 'history') { fields(value, ['version', 'key']); key(value.key); }

}
function read(kind: MetadataKind, text: string | undefined): unknown {
    if (text === undefined) { return undefined; }
    const document = parseDocument(text, { uniqueKeys: true });
    let alias = false; visit(document, { Alias: () => { alias = true; } });
    check(!document.errors.length && !document.warnings.length && !alias, 'ambiguous YAML or aliases');
    const value: unknown = document.toJS(); validate(kind, value); return value;
}
const pointer = (parent: string, name: string) => `${parent}/${name.replace(/~/gu, '~0').replace(/\//gu, '~1')}`;

/** Semantic three-way merge; unresolved fields never produce an applicable document. */
export function mergeProjectMetadata(kind: MetadataKind, baseText: string | undefined, oursText: string | undefined,
    theirsText: string | undefined, choices: MetadataChoices = {}): MetadataMerge {
    const base = read(kind, baseText); const ours = read(kind, oursText); const theirs = read(kind, theirsText);
    const conflicts: MetadataConflict[] = [];
    const conflict = (at: string, b: unknown, o: unknown, t: unknown) => {
        if (Object.hasOwn(choices, at)) { return choices[at] === 'ours' ? o : t; }
        conflicts.push({ path: at, base: b, ours: o, theirs: t }); return o;
    };
    const combine = (b: unknown, o: unknown, t: unknown, at: string): unknown => {
        if (at === '/identity' && b !== undefined && (!equal(b, o) || !equal(b, t))) { return conflict(at, b, o, t); }
        const name = at.split('/').at(-1);
        if (name === 'lastNumber' && kind === 'numbering' && [b, o, t].every(value => value === undefined || typeof value === 'number')) {
            return Math.max(...[b, o, t].filter((value): value is number => typeof value === 'number'));
        }
        if (['knownScenarioKeys', 'legacyImports'].includes(name ?? '') && [b, o, t].every(value => value === undefined || Array.isArray(value))) {
            return [...new Set([b, o, t].flatMap(value => value as string[] ?? []))].sort();
        }
        if (o === undefined || t === undefined) {
            if (equal(o, t)) { return o; }
            if (equal(b, o)) { return t; }
            if (equal(b, t)) { return o; }
            return conflict(at, b, o, t);
        }
        if (object(o) && object(t) && (b === undefined || object(b))) {
            const old = (b ?? {}) as ObjectValue; const result: ObjectValue = {};
            for (const field of [...new Set([...Object.keys(old), ...Object.keys(o), ...Object.keys(t)])].sort()) {
                const value = combine(old[field], o[field], t[field], pointer(at, field));
                if (value !== undefined) { Object.defineProperty(result, field, { value, enumerable: true }); }
            }
            return result;
        }
        if (Array.isArray(o) && Array.isArray(t) && (b === undefined || Array.isArray(b))) {
            const old = (b ?? []) as unknown[];
            const identity = name === 'groups' ? 'id' : name === 'systemFunctions' ? 'uid' : name === 'series' ? 'prefix' : undefined;
            if (identity) {
                const map = (list: unknown[]) => new Map(list.map(item => [(item as ObjectValue)[identity] as string, item]));
                const bm = map(old); const om = map(o); const tm = map(t);
                return [...new Set([...bm.keys(), ...om.keys(), ...tm.keys()])].sort().flatMap(id => {
                    const value = combine(bm.get(id), om.get(id), tm.get(id), pointer(at, id)); return value === undefined ? [] : [value];
                });
            }
            if ([old, o, t].every(list => list.every(item => typeof item === 'string'))) {
                const merged = [...new Set([...old, ...o, ...t])].sort().filter(item => combine(old.includes(item), o.includes(item), t.includes(item), pointer(at, String(item))));
                if (name === 'sections' && merged.includes('standalone') && merged.length > 1) { return conflict(at, b, o, t); }
                return merged;
            }
        }
        if (equal(o, t)) { return o; }
        if (equal(b, o)) { return t; }
        if (equal(b, t)) { return o; }
        return conflict(at, b, o, t);
    };
    const merged = combine(base, ours, theirs, '');
    if (conflicts.length) { return { text: undefined, conflicts }; }
    validate(kind, merged);
    return { text: merged === undefined ? undefined : stringify(merged, { indent: 4 }), conflicts };
}
