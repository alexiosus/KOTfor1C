import { createHash } from 'node:crypto';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { applyYamlMapField } from './scenarioPropertiesModel';
import type { ProjectEntityMetadata, ProjectEntityMetadataPatch } from './projectLibraryStore';
export function legacyScenarioGroupId(name: string): string {
    const hash=createHash('sha256').update(`scenario:${name}`).digest('hex');
    return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
export function readLegacyMetadata(source: string): { values: ProjectEntityMetadata; group?: { id: string; name: string } } {
    const document=ScenarioYamlDocument.parse(source);document.requireValidForEdit();
    const read=(parts:string[])=>{const field=document.findFieldAtPath(['KOTМетаданные',...parts]);if(field?.ambiguous){throw new Error('Ambiguous legacy KOT metadata.');}return field?.value;};
    const name=read(['PhaseSwitcher','Tab']);const order=read(['PhaseSwitcher','OrderOnTab']);
    const group=typeof name==='string'&&name.trim()&&name!=='Ungrouped'?{id:legacyScenarioGroupId(name.trim()),name:name.trim()}:undefined;
    const description=read(['Описание']),category=read(['Категория']);
    return {group,values:{groupId:group?.id??'',...((typeof order==='number'||typeof order==='string'&&order.trim()!=='')&&Number.isFinite(Number(order))?{order:Number(order)}:{}),
        ...(typeof description==='string'?{description}:{}),...(typeof category==='string'?{category}:{})}};
}
/** Edit only the inline fields consumed by older KOT/CI; never serialize the whole document. */
export function editLegacyMetadata(source:string,patch:ProjectEntityMetadataPatch,groups:readonly {id:string;name:string}[]):string {
    let text=source;
    for(const [field,value] of Object.entries(patch)){
        if(value===undefined){continue;}
        let parts:string[];let replacement=value;
        if(field==='groupId'){
            const group=value?groups.find(group=>group.id===value):undefined;
            if(value&&!group){throw new Error('The selected legacy group no longer exists.');}
            parts=['PhaseSwitcher','Tab'];replacement=group?.name??'Ungrouped';
        }else if(field==='order'){parts=['PhaseSwitcher','OrderOnTab'];}
        else if(field==='description'){parts=['Описание'];}else if(field==='category'){parts=['Категория'];}else{throw new Error('Unsupported legacy metadata field.');}
        text=applyYamlMapField(text,['KOTМетаданные',...parts],replacement,{indent:4,plainKeys:true});
    }
    return text;
}
