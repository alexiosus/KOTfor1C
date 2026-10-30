import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { projectFormat, assertProjectFormat3, projectFormatFile } from '../src/projectFormat';
import { ProjectLibraryStore } from '../src/projectLibraryStore';
import { completeProjectSetup } from '../src/projectSetupGate';
async function fixture(t: test.TestContext) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'kot-format-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
    return { root, marker:projectFormatFile(root), enable:async()=>{await fs.mkdir(path.join(root,'.kot'),{recursive:true});await fs.writeFile(projectFormatFile(root),'version: 3\n');} };
}
test('project mode is durable, isolated by root and re-read after a branch switch',async t=>{
    const core=await fixture(t),region=await fixture(t);completeProjectSetup(region.root);
    assert.equal(projectFormat(core.root).kind,'legacy');assert.throws(()=>assertProjectFormat3(core.root));
    await core.enable();assert.equal(projectFormat(core.root).kind,'v3');assert.equal(projectFormat(region.root).kind,'legacy');
    await fs.unlink(core.marker);assert.equal(projectFormat(core.root).kind,'legacy');assert.throws(()=>assertProjectFormat3(core.root));
});
test('invalid, conflicted and symlinked format files cannot enable writes',async t=>{
    const f=await fixture(t);await f.enable();
    for(const text of ['version: 4\n','<<<<<<< HEAD\nversion: 3\n=======\n>>>>>>> old\n','version: 3\nunknown: true\n','version: &v 3\nother: *v\n']){
        await fs.writeFile(f.marker,text);assert.equal(projectFormat(f.root).kind,'invalid');assert.throws(()=>assertProjectFormat3(f.root));
    }
    await fs.unlink(f.marker);const other=path.join(f.root,'elsewhere.yml');await fs.writeFile(other,'version: 3\n');await fs.symlink(other,f.marker);
    assert.equal(projectFormat(f.root).kind,'invalid');assert.throws(()=>assertProjectFormat3(f.root));
});
test('legacy discovery ignores leftover v3 metadata and preserves original bytes without writes',async t=>{
    const f=await fixture(t);await fs.mkdir(path.join(f.root,'.kot/groups'),{recursive:true});
    await fs.writeFile(path.join(f.root,'.kot/groups/sales.yml'),'invalid old leftover');
    const file=path.join(f.root,'scen.yaml');const text='ТипФайла: Сценарий\nДанныеСценария:\n    UID: sales\nKOTМетаданные:\n    PhaseSwitcher:\n        Tab: Sales\n';await fs.writeFile(file,text);
    const store=new ProjectLibraryStore(f.root);assert.deepEqual((await store.read()).metadata,{});assert.deepEqual(await store.readGroups(),[]);
    await assert.rejects(store.ensureGroup('No implicit transition','main'),/KOT 3|transition/iu);
    assert.equal(await fs.readFile(file,'utf8'),text);await assert.rejects(fs.stat(file+'.kot.yml'),{code:'ENOENT'});
});
test('a branch change after validation blocks prepared metadata writes',async t=>{
    const f=await fixture(t);await f.enable();let removed=false;
    const store=new ProjectLibraryStore(f.root,{beforeWrite:()=>{if(!removed){require('node:fs').unlinkSync(f.marker);removed=true;}}});
    await assert.rejects(store.ensureGroup('Stale branch','main'),/KOT 3|transition/iu);
    await assert.rejects(fs.stat(path.join(f.root,'.kot/groups')),{code:'ENOENT'});
});

test('native conversion stays blocked in an old branch even when requested explicitly',async t=>{
    const f=await fixture(t);const source=path.join(f.root,'scen.yaml');const original='ТипФайла: Сценарий\nДанныеСценария:\n    UID: old\nТекстСценария: |\n    And Step\n';await fs.writeFile(source,original);
    const {convertSpprScenarioFiles}=await import('../src/spprScenarioFormat');
    await assert.rejects(convertSpprScenarioFiles(source,'native'),/KOT 3|transition/iu);assert.equal(await fs.readFile(source,'utf8'),original);await assert.rejects(fs.stat(path.join(f.root,'meta.yaml')),{code:'ENOENT'});
});

test('an explicit transition enables v3 only for its project and rolls back on failure',async t=>{
    const core=await fixture(t),region=await fixture(t);const {transitionProjectFormat3}=await import('../src/projectFormatTransition');
    const old=projectFormat(core.root);
    await assert.rejects(transitionProjectFormat3(core.root,old,async()=>{assert.equal(projectFormat(core.root).kind,'v3');throw new Error('Preparation cancelled');}),/cancelled/u);
    assert.equal(projectFormat(core.root).kind,'legacy');assert.equal(projectFormat(region.root).kind,'legacy');
    await transitionProjectFormat3(core.root,projectFormat(core.root),async()=>{});assert.equal(projectFormat(core.root).kind,'v3');
});

test('switching between two v3 branches also invalidates an in-flight write',async t=>{
    const f=await fixture(t);await f.enable();await fs.mkdir(path.join(f.root,'.git'));const head=path.join(f.root,'.git/HEAD');await fs.writeFile(head,'ref: refs/heads/core\n');let changed=false;
    const store=new ProjectLibraryStore(f.root,{beforeWrite:()=>{if(!changed){require('node:fs').writeFileSync(head,'ref: refs/heads/regional-v3\n');changed=true;}}});
    await assert.rejects(store.ensureGroup('Wrong branch','main'),/KOT 3|transition|changed/iu);
});

test('a branch switch while loading metadata cannot become the new write baseline',async t=>{
    const f=await fixture(t);await f.enable();await fs.mkdir(path.join(f.root,'.git'));const head=path.join(f.root,'.git/HEAD');await fs.writeFile(head,'ref: refs/heads/a\n');
    const original=fs.readdir;let switched=false;
    fs.readdir=(async(...args:Parameters<typeof fs.readdir>)=>{if(!switched&&String(args[0])===path.join(f.root,'.kot/metadata')){switched=true;await fs.writeFile(head,'ref: refs/heads/b\n');}return original(...args);}) as typeof fs.readdir;
    try{await assert.rejects(new ProjectLibraryStore(f.root).ensureGroup('Started on A','main'),/changed|KOT 3|transition/iu);}finally{fs.readdir=original;}
    await assert.rejects(fs.stat(path.join(f.root,'.kot/groups')),{code:'ENOENT'});
});
test('failed transition never removes an identical marker belonging to another branch',async t=>{
    const f=await fixture(t);await fs.mkdir(path.join(f.root,'.git'));const head=path.join(f.root,'.git/HEAD');await fs.writeFile(head,'ref: refs/heads/a\n');
    const {transitionProjectFormat3}=await import('../src/projectFormatTransition');
    await assert.rejects(transitionProjectFormat3(f.root,projectFormat(f.root),async()=>{await fs.writeFile(head,'ref: refs/heads/b\n');await fs.writeFile(f.marker,'version: 3\n');throw new Error('Import interrupted');}),/interrupted/u);
    assert.equal(await fs.readFile(f.marker,'utf8'),'version: 3\n');
});
test('a transition rechecks the reviewed branch after asynchronous directory preparation',async t=>{
    const f=await fixture(t);await fs.mkdir(path.join(f.root,'.git'));const head=path.join(f.root,'.git/HEAD');await fs.writeFile(head,'ref: refs/heads/a\n');
    const {transitionProjectFormat3}=await import('../src/projectFormatTransition');const original=fs.lstat;let switched=false;
    fs.lstat=(async(...args:Parameters<typeof fs.lstat>)=>{if(!switched&&String(args[0])===path.join(f.root,'.kot')){switched=true;await fs.writeFile(head,'ref: refs/heads/b\n');await fs.writeFile(f.marker,'version: 3\n');}return original(...args);}) as typeof fs.lstat;
    try{await assert.rejects(transitionProjectFormat3(f.root,projectFormat(f.root),async()=>assert.fail('Setup belongs to A')),/changed/iu);}finally{fs.lstat=original;}
    assert.equal(await fs.readFile(f.marker,'utf8'),'version: 3\n');
});
test('transition work cannot start a metadata operation on a different branch',async t=>{
    const f=await fixture(t);await fs.mkdir(path.join(f.root,'.git'));const head=path.join(f.root,'.git/HEAD');await fs.writeFile(head,'ref: refs/heads/a\n');
    const {transitionProjectFormat3}=await import('../src/projectFormatTransition');
    await assert.rejects(transitionProjectFormat3(f.root,projectFormat(f.root),async()=>{await fs.writeFile(head,'ref: refs/heads/b\n');await new ProjectLibraryStore(f.root).ensureGroup('Wrong branch','main');}),/changed/iu);
    await assert.rejects(fs.stat(path.join(f.root,'.kot/groups')),{code:'ENOENT'});
});
test('failed transition removes its own untracked marker left on a legacy Git branch',async t=>{
    const f=await fixture(t);const git=(...args:string[])=>execFileSync('git',['-C',f.root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
    git('init');git('-c','user.name=KOT test','-c','user.email=kot@example.invalid','commit','--allow-empty','-m','initial');git('branch','legacy-region');
    const {transitionProjectFormat3}=await import('../src/projectFormatTransition');
    await assert.rejects(transitionProjectFormat3(f.root,projectFormat(f.root),async()=>{git('switch','legacy-region');throw new Error('Import interrupted');}),/interrupted/u);
    assert.equal(projectFormat(f.root).kind,'legacy');
});
test('transition does not run preparation if its marker disappears before creation completes',async t=>{
    const f=await fixture(t);const {transitionProjectFormat3}=await import('../src/projectFormatTransition');
    const original=fs.open;let ran=false;
    fs.open=(async(...args:Parameters<typeof fs.open>)=>{const handle=await original(...args);if(String(args[0])===f.marker){const close=handle.close.bind(handle);handle.close=async()=>{await close();await fs.unlink(f.marker);};}return handle;}) as typeof fs.open;
    try{await assert.rejects(transitionProjectFormat3(f.root,projectFormat(f.root),async()=>{ran=true;}),/KOT 3|transition|changed/iu);}finally{fs.open=original;}
    assert.equal(ran,false);
});
