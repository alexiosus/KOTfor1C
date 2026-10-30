import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectPropertyCatalogStore } from '../src/projectPropertyCatalogStore';
import { TestNumberingStore } from '../src/testNumberingStore';

const functions=[{name:'Sales',uid:'11111111-2222-4333-8444-555555555555'}];
async function fixture(t:test.TestContext,v3=false){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'kot-catalog-format-'));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const marker=path.join(root,'.kot/project.yml');
    if(v3){await fs.mkdir(path.dirname(marker));await fs.writeFile(marker,'version: 3\n');}
    return {root,marker};
}
test('legacy Properties and background discovery keep catalogs read-only',async t=>{
    const {root}=await fixture(t);const store=new ProjectPropertyCatalogStore(root);
    assert.deepEqual(await store.ensureSystemFunctions(functions),functions);
    await store.mergeDetected({projects:['Sales'],systemFunctions:functions});
    assert.deepEqual((await store.read()).projects,[]);
    assert.deepEqual(await new TestNumberingStore(root).read(),{version:1,series:[]});
    assert.deepEqual(await fs.readdir(root),[]);
});
test('legacy manual test codes can create source files without shared numbering metadata',async t=>{
    const {root}=await fixture(t);const store=new TestNumberingStore(root);
    await store.claim('Legacy',async()=>[],undefined,()=>fs.writeFile(path.join(root,'scen.yaml'),'legacy source'));
    assert.deepEqual(await fs.readdir(root),['scen.yaml']);
    await assert.rejects(store.claim('Legacy',async()=>['Legacy']),/already exists/iu);
});
test('legacy catalogs ignore conflicted files left by another branch',async t=>{
    const {root}=await fixture(t);await fs.mkdir(path.join(root,'.kot'));
    for(const name of ['property-catalogs.yml','test-numbering.yml']){await fs.writeFile(path.join(root,'.kot',name),'<<<<<<< old\ninvalid\n');}
    const store=new ProjectPropertyCatalogStore(root);
    assert.deepEqual(await store.ensureSystemFunctions(functions),functions);assert.deepEqual((await store.read()).projects,[]);
    assert.deepEqual(await new TestNumberingStore(root).read(),{version:1,series:[]});
    await assert.rejects(store.add('projects','New'),/KOT 3|format|transition/iu);
});
for(const catalog of ['properties','numbering'] as const){
test(`${catalog} rejects a marker removed during its write guard`,async t=>{
    const {root,marker}=await fixture(t,true);let removed=false;
    const options={beforeWrite:async()=>{if(!removed){removed=true;await fs.unlink(marker);}}};
    const store=catalog==='properties'?new ProjectPropertyCatalogStore(root,options):new TestNumberingStore(root,options);
    await assert.rejects(catalog==='properties'?(store as ProjectPropertyCatalogStore).add('projects','New'):(store as TestNumberingStore).addSeries('123456','Author',[]),/KOT 3|format|changed/iu);
    await assert.rejects(fs.stat(store.filePath),{code:'ENOENT'});
});
}
test('catalog mutations retain the branch captured before asynchronous reads',async t=>{
    const {root}=await fixture(t,true);await fs.mkdir(path.join(root,'.git'));
    const head=path.join(root,'.git/HEAD');await fs.writeFile(head,'ref: refs/heads/a\n');
    const original=fs.readFile;let changed=false;
    fs.readFile=(async(...args:Parameters<typeof fs.readFile>)=>{
        if(!changed&&String(args[0])===path.join(root,'.kot/property-catalogs.yml')){changed=true;await fs.writeFile(head,'ref: refs/heads/b\n');}
        return original(...args);
    }) as typeof fs.readFile;
    try{await assert.rejects(new ProjectPropertyCatalogStore(root).add('projects','Wrong branch'),/format|changed|KOT 3/iu);}finally{fs.readFile=original;}
    await assert.rejects(fs.stat(path.join(root,'.kot/property-catalogs.yml')),{code:'ENOENT'});
});
