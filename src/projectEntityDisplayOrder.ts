import path from 'node:path';
import type { ProjectSection } from './projectLibraryStore';

export interface ProjectOrderState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}
type Orders = Record<string, Record<string, number>>;
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function own(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** Display-only positions shared by the local KOT views, never by Git. */
export class ProjectEntityDisplayOrder {
    constructor(private readonly state: ProjectOrderState) {}
    private key(root: string, section: ProjectSection): string {
        if (!path.isAbsolute(root) || !['main', 'process', 'standalone'].includes(section)) { throw new Error('A project root and supported section are required.'); }
        return `kot.projectEntityDisplayOrder.v1:${JSON.stringify([path.resolve(root), section])}`;
    }
    capture(root: string, section: ProjectSection): Orders | undefined {
        const value = this.state.get<unknown>(this.key(root, section));
        if (!own(value)) { return undefined; }
        const groups = Object.entries(value).flatMap(([group, ranks]) => {
            if (!own(ranks)) { return []; }
            const entries = Object.entries(ranks).filter((entry): entry is [string, number] => finite(entry[1]));
            return entries.length || Object.keys(ranks).length === 0 ? [[group, Object.fromEntries(entries)] as const] : [];
        });
        return Object.fromEntries(groups);
    }
    async restore(root: string, section: ProjectSection, value: Orders | undefined): Promise<void> {
        await this.state.update(this.key(root, section), value);
    }
    rank(root: string, section: ProjectSection, group: string, entity: string, fallback?: number): number | undefined {
        const orders = this.capture(root, section);
        if (orders && Object.hasOwn(orders, group)) { return orders[group][entity]; }
        return finite(fallback) ? fallback : undefined;
    }
    async set(root: string, section: ProjectSection, group: string, entity: string, value: number | null,
        initial: readonly { key: string; order: number | null }[] = []): Promise<void> {
        if (value !== null && !finite(value)) { throw new Error('Display order must be a finite nonnegative number.'); }
        const orders = this.capture(root, section) ?? {};
        const ranks = Object.hasOwn(orders, group) ? orders[group] : Object.fromEntries(initial.filter(item => finite(item.order)).map(item => [item.key, item.order as number]));
        if (value === null) { delete ranks[entity]; } else { Object.defineProperty(ranks, entity, { value, writable: true, configurable: true, enumerable: true }); }
        await this.restore(root, section, { ...orders, [group]: ranks });
    }
    async move(root: string, section: ProjectSection, sourceGroup: string, targetGroup: string, entity: string,
        before: string | undefined, sourceKeys: readonly string[], targetKeys: readonly string[]): Promise<void> {
        if (new Set(sourceKeys).size !== sourceKeys.length || new Set(targetKeys).size !== targetKeys.length
            || !sourceKeys.includes(entity) || (before !== undefined && !targetKeys.includes(before))
            || (sourceGroup !== targetGroup && targetKeys.includes(entity))) { throw new Error('The display ordering target changed. Refresh and try again.'); }
        if (entity === before) { return; }
        const destination = targetKeys.filter(key => key !== entity);
        destination.splice(before === undefined ? destination.length : destination.indexOf(before), 0, entity);
        const orders = this.capture(root, section) ?? {};
        const rank = (keys: readonly string[]) => Object.fromEntries(keys.map((key, index) => [key, index]));
        await this.restore(root, section, { ...orders,
            ...(sourceGroup === targetGroup ? {} : { [sourceGroup]: rank(sourceKeys.filter(key => key !== entity)) }),
            [targetGroup]: rank(destination) });
    }
    async remap(root: string, section: ProjectSection, oldKey: string, newKey: string): Promise<void> {
        if (oldKey === newKey) { return; }
        const orders = this.capture(root, section);
        if (!orders) { return; }
        let changed = false;
        for (const ranks of Object.values(orders)) {
            if (!Object.hasOwn(ranks, oldKey)) { continue; }
            if (!Object.hasOwn(ranks, newKey)) { Object.defineProperty(ranks, newKey, { value: ranks[oldKey], enumerable: true, configurable: true, writable: true }); }
            delete ranks[oldKey]; changed = true;
        }
        if (changed) { await this.restore(root, section, orders); }
    }
}

const memory = new Map<string, unknown>();
let personalOrder = new ProjectEntityDisplayOrder({ get: <T>(key: string) => memory.get(key) as T | undefined,
    update: async (key, value) => { memory.set(key, value); } });
export function getProjectEntityDisplayOrder(): ProjectEntityDisplayOrder { return personalOrder; }
export function bindProjectEntityDisplayState(state: ProjectOrderState): () => void {
    const previous = personalOrder; personalOrder = new ProjectEntityDisplayOrder(state);
    return () => { personalOrder = previous; };
}
