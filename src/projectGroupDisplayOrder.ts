import path from 'node:path';
import type { ProjectGroup, ProjectSection } from './projectLibraryStore';

interface LocalState {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}
export interface ProjectDisplayGroup extends ProjectGroup {
    readonly projectRoot: string;
    readonly key: string;
    readonly displayOrders?: Partial<Record<ProjectSection, number>>;
}

export function projectGroupDisplayKey(root: string, id: string): string {
    return JSON.stringify([path.resolve(root), id]);
}

/** Alphabetical defaults with personal drag order; shared group records are never written here. */
export class ProjectGroupDisplayOrder {
    constructor(private readonly state: LocalState) {}

    private key(root: string, section: ProjectSection): string {
        if (!path.isAbsolute(root) || !['main', 'process', 'standalone'].includes(section)) {
            throw new Error('A project root and supported group section are required.');
        }
        return `kot.projectGroupDisplayOrder.v1:${JSON.stringify([path.resolve(root), section])}`;
    }

    ordered<T extends ProjectGroup>(root: string, section: ProjectSection, groups: readonly T[]): T[] {
        const current = groups.filter(group => group.sections.includes(section)).slice()
            .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        const saved = this.state.get<unknown>(this.key(root, section));
        const ids = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
        const priority = new Map([...new Set(ids)].map((id, index) => [id, index]));
        return current.sort((left, right) => (priority.get(left.id) ?? Infinity) - (priority.get(right.id) ?? Infinity));
    }

    async move(root: string, section: ProjectSection, groups: readonly ProjectGroup[], id: string,
        beforeId: string | undefined, expectedIds: readonly string[]): Promise<void> {
        const ordered = this.ordered(root, section, groups).map(group => group.id);
        if (!Array.isArray(expectedIds) || JSON.stringify(ordered) !== JSON.stringify(expectedIds)
            || !ordered.includes(id) || (beforeId !== undefined && !ordered.includes(beforeId))) {
            throw new Error('The groups changed. Refresh the panel and try again.');
        }
        if (id === beforeId) { return; }
        const result = ordered.filter(groupId => groupId !== id);
        result.splice(beforeId === undefined ? result.length : result.indexOf(beforeId), 0, id);
        await this.state.update(this.key(root, section), result);
    }
}
