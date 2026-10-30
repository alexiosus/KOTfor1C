import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshProjectBranch } from '../src/projectBranchRefresh';
test('branch refresh replaces scenario and library inventories before publishing the final library',async()=>{
    const events:string[]=[];
    await refreshProjectBranch({invalidateLibrary:()=>{events.push('invalidate');},reloadScenarios:async()=>{events.push('scenarios');},reloadDefinitions:async()=>{events.push('definitions');},reloadStandalone:async()=>{events.push('standalone');}});
    assert.equal(events[0],'invalidate');assert.equal(events[1],'scenarios');assert.equal(events.at(-1),'invalidate');assert.ok(events.includes('definitions'));assert.ok(events.includes('standalone'));
});
