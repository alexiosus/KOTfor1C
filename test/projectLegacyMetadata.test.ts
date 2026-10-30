import assert from 'node:assert/strict';
import test from 'node:test';
import { readLegacyMetadata, editLegacyMetadata } from '../src/projectLegacyMetadata';
const source='\uFEFFТипФайла: Сценарий\r\nДанныеСценария:\r\n    UID: sales\r\nKOTМетаданные:\r\n    Описание: Before\r\n    Категория: Smoke\r\n    PhaseSwitcher:\r\n        Tab: Sales tests 1\r\n        OrderOnTab: 7\r\n        Default: true\r\n    Custom: keep\r\nТекстСценария: |\r\n    And Step\r\n';
test('legacy metadata editing keeps old CI fields, source body, BOM and newline style',()=>{
    const result=editLegacyMetadata(source,{description:'After',category:'Regression',order:2},[]);
    assert.equal(readLegacyMetadata(result).values.description,'After');assert.equal(readLegacyMetadata(result).values.category,'Regression');assert.equal(readLegacyMetadata(result).values.order,2);
    assert.ok(result.startsWith('\uFEFF'));assert.match(result,/Tab: Sales tests 1\r\n/u);assert.match(result,/Default: true/u);assert.match(result,/Custom: keep/u);assert.ok(result.endsWith('ТекстСценария: |\r\n    And Step\r\n'));
    assert.doesNotMatch(result,/\r?\nmetadata:/u);
});
test('legacy group assignment uses a displayed group name and refuses unknown IDs',()=>{
    const current=readLegacyMetadata(source);assert.equal(current.group?.name,'Sales tests 1');
    const target=readLegacyMetadata(source.replace('Sales tests 1','Purchases')).group!;
    const result=editLegacyMetadata(source,{groupId:target.id},[target]);assert.equal(readLegacyMetadata(result).group?.name,'Purchases');
    assert.throws(()=>editLegacyMetadata(source,{groupId:'missing'},[]));
});

test('new inline metadata uses plain keys understood by existing PowerShell phase readers',()=>{
    const group=readLegacyMetadata(source).group!;
    const text=editLegacyMetadata('ТипФайла: Сценарий\nТекстСценария: |\n    And Step\n',{groupId:group.id},[group]);
    assert.match(text,/^KOTМетаданные:\n {4}PhaseSwitcher:\n {8}Tab:/mu);
    assert.doesNotMatch(text,/"(?:KOTМетаданные|PhaseSwitcher|Tab)":/u);
});
