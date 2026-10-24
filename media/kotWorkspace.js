/* KOT workspace page. All IO is performed by the extension host over validated messages. */
(() => {
    'use strict';
    const api = acquireVsCodeApi();
    const saved = api.getState() || {};
    const state = { view:'settings', setupOpen:false, step:0, folder:'', scope:'folder', section:'editor', query:'', tour:0, ...saved };
    let boot; let rows = []; let sequence = 0; let readGeneration = 0; let review; let inspection; let runtime; let writing = false; let noticeRevision = 0; let activeTasks = 0;
    const waiting = new Map(); const drafts = new Map();
    const $ = id => document.getElementById(id);
    const content = $('content');
    const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const t = text => boot?.model.strings[text] || text;
    const draftId = (folder,scope,key) => JSON.stringify([folder,scope,key]);
    function persist() { api.setState({ view:state.view,setupOpen:state.setupOpen,step:state.step,folder:state.folder,scope:state.scope,section:state.section,query:state.query,tour:state.tour,setup:state.setup }); }
    function notice(text,error=false) { noticeRevision++;$('notice').textContent=text;$('notice').classList.toggle('notice-error',error); }
    function rpc(type,data={}) { const id=String(++sequence);return new Promise((resolve,reject)=>{waiting.set(id,{resolve,reject});api.postMessage({id,type,folder:state.folder||undefined,scope:state.scope,...data});}); }
    async function task(label,action) {
        notice(t(label));content.setAttribute('aria-busy','true');
        const progressRevision=noticeRevision;activeTasks++;
        try { const result=await action();if(noticeRevision===progressRevision)notice('');return result; }
        catch(error) { notice(error.message,true);return undefined; }
        finally { if(--activeTasks===0)content.removeAttribute('aria-busy'); }
    }
    const folder = () => boot.folders.find(folder=>folder.id===state.folder);
    function defaultSetup() { return { route:'new',mode:'vanessa',language:'en',format:'native',sources:'tests',libraries:'libraries',run:false,platform:'',vanessa:'tools/vanessa/vanessa-automation.epf',compiler:'build/BuildScenarioBDD.epf',profileId:'new' }; }
    function pathControl(id,label,value,key) { return '<div class="path-control"><input id="'+id+'" aria-label="'+escape(t(label))+'" value="'+escape(value)+'"><button type="button" data-path="'+key+'" data-target="'+id+'" aria-label="'+escape(t('Browse')+': '+t(label))+'">'+t('Browse')+'…</button></div>'; }
    function pathField(id,label,value,key,hint='') { return '<div class="field"><label for="'+id+'">'+escape(t(label))+'</label>'+pathControl(id,label,value,key)+(hint?'<small>'+escape(t(hint))+'</small>':'')+'</div>'; }
    function bindPaths() {
        content.querySelectorAll('[data-path]').forEach(button=>button.onclick=()=>task('Choosing a path…',async()=>{
            const value=await rpc('pickPath',{key:button.dataset.path});if(value===undefined){notice('');return;}
            const input=$(button.dataset.target);input.value=value;input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('change'));
            notice(t('Path selected. Apply to save it.'));
        }));
    }
    function projectSelect() {
        return boot.folders.length?'<label class="field project-selector"><span>'+t('Project folder')+'</span><select id="project">'+boot.folders.map(folder=>'<option value="'+escape(folder.id)+'" '+(folder.id===state.folder?'selected':'')+'>'+escape(folder.name)+' — '+escape(folder.path)+'</option>').join('')+'</select></label>':'<div class="subtle-box">'+t('Open a project folder to configure project settings. User settings are available now.')+' <button id="choose-folder">'+t('Open folder')+'…</button></div>';
    }
    function bindProject() {
        if($('choose-folder'))$('choose-folder').onclick=()=>rpc('chooseFolder');
        if($('project'))$('project').onchange=()=>task('Reading project progress…',async()=>{
            const target=$('project').value;$('project').disabled=true;
            if(state.setup&&state.folder&&state.step!==6)await rpc('progress',{data:{step:state.step,draft:state.setup}});
            const progress=await rpc('loadProgress',{folder:target});
            state.folder=target;inspection=undefined;review=undefined;runtime=undefined;
            state.setup=progress?.draft||defaultSetup();state.step=progress?.complete?0:progress?.step||0;state.readiness=progress?.readiness;
            persist();render();
        });
    }
    function navigation() {
        $('brand').setAttribute('aria-label',t('KOT settings'));
        $('brand').onclick=()=>{if(state.view==='setup')state.step=0;else state.view='settings';persist();render();};
        $('navigation').innerHTML=(state.setupOpen?'<button data-view="setup" class="nav-button '+(state.view==='setup'?'selected':'')+'">'+t('Project setup')+'</button>':'')+'<button data-view="settings" class="nav-button '+(state.view==='settings'?'selected':'')+'">'+t('Settings')+'</button><button data-view="help" class="nav-button '+(state.view==='help'?'selected':'')+'">'+t('Where to find tools')+'</button>';
        $('navigation').querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{state.view=button.dataset.view;persist();render();});
        const sections=state.view==='settings'?boot.model.sections:[];
        $('section-navigation').innerHTML=sections.map(section=>'<button data-section="'+section.id+'" class="section-button '+(section.id===state.section?'selected':'')+'">'+escape(section.title)+'</button>').join('')+'<button id="start-setup" class="text-button start-setup">'+t('Start project setup')+'…</button>';
        $('section-navigation').querySelectorAll('[data-section]').forEach(button=>button.onclick=()=>{state.section=button.dataset.section;state.query='';persist();render();});
        $('start-setup').onclick=startSetup;
        const selector=$('section-select');selector.hidden=!sections.length;selector.setAttribute('aria-label',t('Settings section'));
        selector.innerHTML=sections.map(section=>'<option value="'+section.id+'">'+escape(section.title)+'</option>').join('');selector.value=state.section;
        selector.onchange=()=>{state.section=selector.value;state.query='';persist();render();};
    }
    function startSetup() { state.view='setup';state.setupOpen=true;state.step=0;state.setup ||=defaultSetup();review=undefined;persist();render(); }
    function closePopup() { content.querySelectorAll('.setting-info').forEach(info=>{info.classList.remove('pinned');info.classList.add('dismissed');info.querySelector('button').setAttribute('aria-expanded','false');}); }
    document.addEventListener('keydown',event=>{if(event.key==='Escape')closePopup();});
    document.addEventListener('click',event=>{content.querySelectorAll('.setting-info.pinned').forEach(info=>{if(!info.contains(event.target)){info.classList.remove('pinned');info.classList.add('dismissed');}});});
    function currentRow(item) { return rows.find(row=>row.key===item.key); }
    function currentValue(item) { const draft=drafts.get(draftId(state.folder,state.scope,item.key));return draft?(draft.reset?currentRow(item)?.inheritedValue??item.default:draft.value):currentRow(item)?.value ?? item.default; }
    function stage(item,value,reset=false) {
        const row=currentRow(item);if(!row||writing)return;
        const id=draftId(state.folder,state.scope,item.key);const previous=drafts.get(id);
        drafts.set(id,{key:item.key,folder:state.folder,scope:state.scope,token:previous?.token||row.token,...(reset?{reset:true}:{value})});
        void rpc('draft',{data:[...drafts.values()]});updatePending();persist();
    }
    function controls(item,id,value) {
        const draft=drafts.get(draftId(state.folder,state.scope,item.key));
        const explicit=draft?!draft.reset:currentRow(item)?.explicit;
        if(item.editor==='manager'||item.editor==='action')return '<button data-external="'+item.key+'">'+t(item.manager?'Open editor':'Edit in VS Code Settings')+'…</button><small class="muted"> '+t('This editor saves independently of this page.')+'</small>';
        if(item.inheritsFrom)return '<select id="'+id+'" data-key="'+item.key+'" data-kind="inherit"><option value="inherit" '+(!explicit?'selected':'')+'>'+t('Use the shared preference')+'</option><option value="true" '+(explicit&&value===true?'selected':'')+'>'+t('Show')+'</option><option value="false" '+(explicit&&value===false?'selected':'')+'>'+t('Hide')+'</option></select>';
        if(item.editor==='choices')return '<details class="multi-select"><summary id="'+id+'">'+t('Choose checks')+' · <span class="choice-count">'+value.length+'</span></summary><div class="choice-options">'+item.itemEnum.map((code,i)=>'<label><input type="checkbox" data-choice="'+item.key+'" value="'+escape(code)+'" '+(value.includes(code)?'checked':'')+'>'+escape(boot.model.russian?item.choiceLabels[i]:code.replace('kotTestToolkit.',''))+'</label>').join('')+'</div></details><div class="selected-checks">'+choiceChips(item,value)+'</div>';
        if(item.pathKind==='directories')return '<div class="directory-list">'+value.map((directory,index)=>'<div><code>'+escape(directory)+'</code><button data-remove-directory="'+item.key+'" data-index="'+index+'" aria-label="'+escape(t('Remove folder')+': '+directory)+'">×</button></div>').join('')+'</div><button data-add-directory="'+item.key+'">'+t('Add folder')+'…</button>';
        if(item.pathKind)return pathControl(id,item.label,value,item.key).replace('<input ','<input data-key="'+item.key+'" ');
        if(item.enum)return '<select id="'+id+'" data-key="'+item.key+'">'+item.enum.map((option,i)=>'<option value="'+escape(option)+'" '+(option===value?'selected':'')+'>'+escape(item.optionLabels?.[i]||option)+'</option>').join('')+'</select>';
        if(item.type==='boolean')return '<label class="inline-choice"><input id="'+id+'" type="checkbox" data-key="'+item.key+'" '+(value?'checked':'')+'> '+t('Enabled')+'</label>';
        if(item.type==='array'||item.type==='object')return '<textarea id="'+id+'" data-key="'+item.key+'" data-kind="json">'+escape(JSON.stringify(value,null,2))+'</textarea>';
        return '<input id="'+id+'" data-key="'+item.key+'" type="'+(item.secret?'password':item.type==='number'?'number':'text')+'" value="'+escape(value)+'" placeholder="'+escape(item.secret&&currentRow(item)?.configured?t('A key is already saved'):item.key.endsWith('steps.vanessaVersion')?t('Automatic'):item.placeholder||'')+'" '+(item.secret&&state.scope!=='user'?'disabled':'')+'>';
    }
    function choiceChips(item,value) { return value.length?value.map(code=>'<span class="choice-chip">'+escape(boot.model.russian?item.choiceLabels[item.itemEnum.indexOf(code)]||code:code.replace('kotTestToolkit.',''))+'</span>').join(''):'<span class="muted">'+t('All checks enabled')+'</span>'; }
    function fieldHtml(item) {
        const id='field-'+item.key.replace(/\./gu,'-');const row=currentRow(item);const draft=drafts.get(draftId(state.folder,state.scope,item.key));
        const conflict=draft&&row&&draft.token!==row.token;
        const info='<span class="setting-info"><button class="info-button" aria-label="'+escape(t('Details')+': '+item.label)+'" aria-expanded="false" aria-describedby="'+id+'-info">i</button><span class="info-popup" role="tooltip" id="'+id+'-info"><strong>'+t('Technical name')+'</strong><code>'+escape(item.key)+'</code><span class="technical">'+escape(item.description)+'</span><span class="technical">'+t('Default')+': <code>'+escape(JSON.stringify(item.default))+'</code></span></span></span>';
        const hint=item.hint||item.description.split('\n')[0].replace(/\*\*/gu,'');
        return '<div class="setting '+(conflict?'setting-conflict':'')+'" data-setting="'+item.key+'"><div class="setting-heading"><label for="'+id+'">'+escape(item.label)+'</label>'+info+'</div><div class="description">'+escape(hint)+'</div><div class="control">'+controls(item,id,currentValue(item))+'</div>'+(conflict?'<p class="field-error">'+t('Changed outside this page. Keep the external value or review your draft before applying.')+' <button class="text-button" data-use-current="'+item.key+'">'+t('Use current value')+'</button></p>':'')+'<div class="source">'+t('Source')+': '+t(row?.source||'default')+(item.editor==='manager'||item.editor==='action'?'':' <button class="text-button reset" data-reset="'+item.key+'">'+t('Reset in this scope')+'</button>')+' <button class="text-button reset" data-native="'+item.key+'">'+t('VS Code Settings')+'</button></div></div>';
    }
    async function loadRows() {
        const generation=++readGeneration;const next=await rpc('settings');if(generation!==readGeneration)return;rows=next;renderFields();
    }
    function settings() {
        const section=boot.model.sections.find(section=>section.id===state.section)||boot.model.sections[0];
        content.innerHTML='<div class="eyebrow">KOT</div><h1>'+escape(section.title)+'</h1><div class="page-actions"><button id="native-settings">'+t('Open VS Code Settings')+'</button><button id="begin-settings">'+t('Start project setup')+'…</button></div>'+projectSelect()+'<div class="settings-bar"><input id="search" aria-label="'+t('Search settings')+'" placeholder="'+t('Search by purpose or technical name')+'" value="'+escape(state.query)+'"><select id="scope" aria-label="'+t('Change scope')+'"><option value="user">'+t('User')+'</option><option value="workspace">'+t('Workspace')+'</option><option value="folder">'+t('Selected folder')+'</option></select></div><p id="result-count" class="muted"></p><div id="setting-fields">'+t('Reading settings…')+'</div><div class="save-bar"><span id="pending-count"></span><button id="discard">'+t('Discard')+'</button><button id="apply" class="primary">'+t('Apply')+'</button></div>';
        $('native-settings').onclick=()=>rpc('openNative');$('begin-settings').onclick=startSetup;bindProject();
        $('scope').value=state.scope;$('scope').onchange=()=>{state.scope=$('scope').value;persist();void task('Reading settings…',loadRows);};
        $('search').oninput=()=>{state.query=$('search').value;persist();renderFields();};
        $('discard').onclick=()=>{drafts.clear();void rpc('draft',{data:[]});renderFields();notice(t('Draft discarded. Separate editors keep their own saved changes.'));};
        $('apply').onclick=()=>task('Applying settings…',async()=>{
            writing=true;document.querySelector('.workbench').inert=true;$('apply').disabled=true;
            try {
                const result=await rpc('applySettings',{data:[...drafts.values()]});
                for(const [id,change]of drafts)if(result.applied.includes(`${change.folder}:${change.scope}:${change.key}`))drafts.delete(id);
                await loadRows();notice(t('Settings saved.'));
            } catch(error) {
                for(const [id,change]of drafts)if(error.applied?.includes(`${change.folder}:${change.scope}:${change.key}`))drafts.delete(id);
                await loadRows();throw error;
            } finally { writing=false;document.querySelector('.workbench').inert=false;updatePending();void rpc('draft',{data:[...drafts.values()]}); }
        });
        void task('Reading settings…',async()=>{await loadRows();notice('');});
    }
    function renderFields() {
        if(state.view!=='settings'||!$('setting-fields'))return;
        const query=state.query.toLocaleLowerCase();
        const items=boot.model.settings.filter(item=>query?[item.label,item.description,item.key,item.hint||''].some(text=>text.toLocaleLowerCase().includes(query)):item.section===state.section);
        const usual=items.filter(item=>!item.advanced&&!item.compatibility),advanced=items.filter(item=>item.advanced&&!item.compatibility),compat=items.filter(item=>item.compatibility);
        const group=(title,values)=>values.length?'<details '+(query?'open':'')+'><summary>'+t(title)+' · '+values.length+'</summary>'+values.map(fieldHtml).join('')+'</details>':'';
        $('result-count').textContent=t('Settings found')+': '+items.length;
        $('setting-fields').innerHTML=usual.map(fieldHtml).join('')+group('More settings',advanced)+group('Compatibility with older projects',compat);
        content.querySelectorAll('[data-key]').forEach(input=>input.onchange=()=>{
            const item=boot.model.settings.find(item=>item.key===input.dataset.key);let value=input.type==='checkbox'?input.checked:input.value;
            try {
                if(input.dataset.kind==='inherit'){if(value==='inherit'){stage(item,undefined,true);return;}value=JSON.parse(value);}
                else if(input.dataset.kind==='json')value=JSON.parse(value);else if(input.type==='number'){value=Number(value);if(!Number.isFinite(value))throw new Error();}
                input.removeAttribute('aria-invalid');stage(item,value);
            } catch { input.setAttribute('aria-invalid','true');notice(t('Check the value format before applying.'),true);updatePending(); }
        });
        content.querySelectorAll('[data-choice]').forEach(input=>input.onchange=()=>{
            const area=input.closest('.setting');const item=boot.model.settings.find(item=>item.key===input.dataset.choice);
            const values=[...area.querySelectorAll('[data-choice]:checked')].map(input=>input.value);stage(item,values);
            area.querySelector('.choice-count').textContent=values.length;area.querySelector('.selected-checks').innerHTML=choiceChips(item,values);
        });
        content.querySelectorAll('[data-reset]').forEach(button=>button.onclick=()=>{stage(boot.model.settings.find(item=>item.key===button.dataset.reset),undefined,true);renderFields();});
        content.querySelectorAll('[data-use-current]').forEach(button=>button.onclick=()=>{drafts.delete(draftId(state.folder,state.scope,button.dataset.useCurrent));void rpc('draft',{data:[...drafts.values()]});renderFields();});
        content.querySelectorAll('[data-native]').forEach(button=>button.onclick=()=>rpc('openNative',{key:button.dataset.native}));
        content.querySelectorAll('[data-external]').forEach(button=>button.onclick=()=>{
            const item=boot.model.settings.find(item=>item.key===button.dataset.external);
            if(item.manager)void task('Opening editor…',()=>rpc('action',{action:item.manager==='kotTestToolkit.managePlatforms'?'platforms':item.manager==='kotTestToolkit.manageSystemFunctions'?'functions':item.manager==='kotTestToolkit.manageTestNumbering'?'numbering':'parameters'}));
            else void rpc('openNative',{key:item.key});
        });
        content.querySelectorAll('[data-add-directory]').forEach(button=>button.onclick=()=>task('Choosing a path…',async()=>{
            const item=boot.model.settings.find(item=>item.key===button.dataset.addDirectory);const value=await rpc('pickPath',{key:item.key});
            if(value!==undefined){stage(item,[...new Set([...currentValue(item),value])]);renderFields();}notice('');
        }));
        content.querySelectorAll('[data-remove-directory]').forEach(button=>button.onclick=()=>{const item=boot.model.settings.find(item=>item.key===button.dataset.removeDirectory);stage(item,currentValue(item).filter((_,i)=>i!==Number(button.dataset.index)));renderFields();});
        content.querySelectorAll('.info-button').forEach(button=>{const info=button.parentElement;button.onclick=()=>{const pin=info.classList.toggle('pinned');info.classList.toggle('dismissed',!pin);button.setAttribute('aria-expanded',String(pin));};info.onpointerenter=()=>info.classList.remove('dismissed');button.onfocus=()=>info.classList.remove('dismissed');});
        content.querySelectorAll('.setting').forEach(area=>{if(rows.find(row=>row.key===area.dataset.setting)?.supported===false){area.querySelectorAll('[data-key],[data-choice],[data-reset],[data-add-directory],[data-remove-directory]').forEach(control=>control.disabled=true);area.insertAdjacentHTML('beforeend','<p class="field-error">'+t('This setting applies to the whole window. Choose Workspace or User scope.')+'</p>');}});
        bindPaths();updatePending();
    }
    function updatePending() {
        if(!$('pending-count'))return;const invalid=!!content.querySelector('[aria-invalid="true"]');
        $('pending-count').textContent=invalid?t('Check the highlighted value.'):drafts.size?t('Pending changes')+': '+drafts.size:t('No pending changes');
        $('apply').disabled=writing||!drafts.size||invalid;$('discard').disabled=writing||!drafts.size&&!invalid;
    }
    const routes=[['new','Start from scratch','Create a small project or try the workshop.'],['sppr','I have an SPPR project','Find scenarios, processes and run settings.'],['vanessa','I have a Vanessa project','Use existing feature files, export libraries and launch JSON.'],['legacy','I used an earlier KOT version','Review existing settings and the metadata migration plan.']];
    const tours=[['manager','Test Manager','Select tests for compilation, run them and see results.'],['library','Library','Find steps and reusable scenarios; insert calls and use F12 to open their definitions.'],['properties','Test properties','Edit the selected test on the right. Save, run and favorite actions are in its header.'],['infobases','Infobases','Open bases, choose platforms and manage test clients under each base.'],['variables','Vanessa and variables','The bottom status bar shows Vanessa. F11 runs the step at the caret; runtime variables are on the right.']];
    function footer(next='Continue') { return '<div class="actions"><button id="back">'+t('Back')+'</button><span class="spacer"></span><button id="next" class="primary">'+t(next)+'</button></div>'; }
    function saveProgress() { persist();if(state.folder&&state.step!==6)void rpc('progress',{data:{step:state.step,draft:state.setup}}).catch(error=>notice(error.message,true)); }
    function nextStep(step) { state.step=step;saveProgress();render(); }
    function setup() {
        const draft=state.setup ||=defaultSetup();
        const heading='<div class="page-navigation"><button id="to-start" class="text-button">← '+t('Back to start')+'</button></div>';
        const prefix=state.step?'<div class="eyebrow">'+t('Project setup')+' · '+state.step+' / 5</div>':'<div class="eyebrow">KOT</div>';
        if(state.step===0){
            content.innerHTML='<h1>'+t('Where shall we start?')+'</h1><p class="lead">'+t('You can write tests without 1C. Connect execution when you need it.')+'</p>'+projectSelect()+'<div class="route-list">'+routes.map(([route,title,description])=>'<button class="route" data-route="'+route+'"><span class="arrow">→</span><span><strong>'+t(title)+'</strong><small>'+t(description)+'</small></span></button>').join('')+'</div><div class="page-actions"><button id="workshop">'+t('Open a copy of the workshop')+'…</button></div>';
            content.querySelectorAll('[data-route]').forEach(button=>button.onclick=()=>{if(!folder()){notice(t('Open a local project folder first.'),true);return;}draft.route=button.dataset.route;draft.mode=draft.route==='sppr'||draft.route==='legacy'?'sppr':'vanessa';if(draft.route!=='new'){draft.sources=boot.profilePaths?.sources||draft.sources;draft.libraries=boot.profilePaths?.libraries||draft.libraries;}nextStep(1);});
            $('workshop').onclick=()=>task('Copying the workshop…',()=>rpc('openWorkshop'));bindProject();
        }else if(state.step===1){
            content.innerHTML=heading+prefix+'<h1>'+t('Inspect the project')+'</h1><p class="lead">'+t('This step only reads files. No migration runs until you apply the plan.')+'</p>'+projectSelect()+(draft.route==='new'?'<label class="field"><span>'+t('Test approach')+'</span><select id="mode"><option value="vanessa">Vanessa feature</option><option value="sppr">СППР / SPPR</option></select></label>':'')+'<div class="operation"><button id="scan">'+t('Find project files')+'</button><button id="cancel-scan">'+t('Cancel')+'</button></div><div id="scan-result"></div>'+footer();
            if($('mode')){$('mode').value=draft.mode;$('mode').onchange=()=>{draft.mode=$('mode').value;saveProgress();};}
            $('scan').onclick=()=>task('Inspecting project files…',async()=>{
                inspection=await rpc('scan');const roots=inspection.roots[draft.mode];
                if(draft.route!=='new'&&roots.sources){draft.sources=roots.sources;if(roots.libraries)draft.libraries=roots.libraries;saveProgress();}
                showInspection();notice(t('Inspection complete. No files changed.'));
            });
            $('cancel-scan').onclick=()=>rpc('cancel');showInspection();bindProject();
        }else if(state.step===2){
            content.innerHTML=heading+prefix+'<h1>'+t('Prepare the editor')+'</h1><label class="field"><span>'+t('New scenario language')+'</span><select id="language"><option value="en">English</option><option value="ru">Русский</option></select></label>'+(draft.mode==='sppr'?'<label class="field"><span>'+t('New SPPR source format')+'</span><select id="format"><option value="native">feature + meta.yaml</option><option value="legacy">scen.yaml</option></select><small>'+t('Existing source files keep their format.')+'</small></label>':'')+pathField('sources','Scenario folder',draft.sources,'setup.sources')+libraryFields(draft.libraries)+'<label class="field"><span>'+t('Compilation and run profile')+'</span><select id="profile"><option value="new">'+t('Create a separate profile')+'</option>'+boot.profiles.profiles.map(profile=>'<option value="'+escape(profile.id)+'">'+escape(profile.name)+'</option>').join('')+'</select><small>'+t('Existing profiles are not overwritten. A selected profile keeps its existing roots and options.')+'</small></label>'+footer();
            for(const key of ['language','format','sources'])if($(key)){$(key).value=draft[key];$(key).onchange=()=>{draft[key]=$(key).value;review=undefined;saveProgress();};}
            bindLibraries();
            $('profile').value=draft.profileId;$('profile').onchange=()=>{draft.profileId=$('profile').value;saveProgress();};
            if(state.folder!==boot.primaryFolder){content.insertAdjacentHTML('afterbegin','<div class="subtle-box">'+t('Build profiles currently apply to one project window. Open this folder separately to continue setup.')+' <button id="own-window">'+t('Open project in a new window')+'</button></div>');$('own-window').onclick=()=>rpc('openProjectWindow');$('next').disabled=true;}
        }else if(state.step===3){
            content.innerHTML=heading+prefix+'<h1>'+t('Connect execution?')+'</h1><p class="lead">'+t('The editor is enough to start writing tests. Connect 1C and Vanessa to run them and explore forms.')+'</p>'+(draft.run?'<div id="runtime-tools"></div>':'<div class="execution-choice"><button id="connect-now" class="primary">'+t('Connect 1C and Vanessa')+'</button><button id="editor-only">'+t('Editor only for now')+'</button></div>')+'<div class="actions"><button id="back">'+t('Back')+'</button><span class="spacer"></span>'+(draft.run?'<button id="next" class="primary">'+t('Continue')+'</button>':'')+'</div>';
            if(draft.run)renderRuntime();else{$('connect-now').onclick=()=>{draft.run=true;render();};$('editor-only').onclick=()=>{draft.run=false;nextStep(4);};}
        }else if(state.step===4){content.innerHTML=heading+prefix+'<h1>'+t('Where to find tools')+'</h1>'+tourHtml()+footer('Review changes');bindTour();}
        else if(state.step===5){
            content.innerHTML=heading+prefix+'<h1>'+t('Review changes')+'</h1><div id="setup-plan">'+t('Preparing the change plan…')+'</div>'+footer(draft.run?'Apply and prepare execution':'Apply and start');
            $('next').disabled=true;
            void task('Preparing the change plan…',async()=>{review=await rpc('reviewSetup',{data:draft});showReview();$('next').disabled=false;notice('');});
        }else{
            content.innerHTML=heading+'<h1>'+t('Ready to start')+'</h1><p class="lead">'+t('Project settings are applied. Open the first test, then use the Library and properties to continue.')+'</p>'+(draft.run?'<p>'+t('See the bottom status bar for the actual Vanessa connection state.')+'</p>':'')+(state.readiness?.compilationIssues?.length?'<div class="subtle-box">'+t('The editor is ready. SPPR compilation needs more parameters:')+' '+state.readiness.compilationIssues.map(escape).join(' ')+' <button id="finish-parameters">'+t('Open editor')+'</button></div>':'')+'<div class="page-actions"><button id="example" class="primary">'+t(draft.mode==='sppr'?'Open the first SPPR scenario':'Open the first Vanessa feature')+'</button><button id="settings-done">'+t('Open settings')+'</button></div><p>'+t(draft.mode==='sppr'?'In SPPR, properties contain parameters and run settings. F12 opens a nested scenario; Test Manager compiles the main test before Vanessa runs it.':'A Vanessa feature runs directly. Find a step in the Library, edit tags and launch JSON in properties, then use F11 after connecting Vanessa.')+'</p>';
            if(draft.run&&!state.readiness?.executionReady){content.insertAdjacentHTML('afterbegin','<div class="subtle-box">'+t('The editor is ready. Vanessa preparation was not completed; execution is still disconnected.')+(state.readiness?.executionError?'<p>'+escape(state.readiness.executionError)+'</p>':'')+' <button id="retry-execution">'+t('Retry connecting Vanessa')+'</button></div>');$('retry-execution').onclick=()=>task('Preparing Vanessa…',async()=>{const result=await rpc('retryExecution');state.readiness={...state.readiness,...result};render();notice(t(result.executionReady?'Vanessa connected.':'Vanessa is still disconnected.'),!result.executionReady);});}
            if($('finish-parameters'))$('finish-parameters').onclick=()=>rpc('action',{action:'parameters'});
            $('example').onclick=()=>task('Opening the test…',()=>rpc('openExample'));$('settings-done').onclick=()=>{state.view='settings';render();};
        }
        if($('to-start'))$('to-start').onclick=()=>nextStep(0);
        if($('back'))$('back').onclick=()=>nextStep(Math.max(0,state.step-1));
        if($('next'))$('next').onclick=()=>{
            if(state.step===5)void task('Applying the reviewed project setup…',async()=>{ document.querySelector('.workbench').inert=true;$('next').disabled=true;try{state.readiness=await rpc('applySetup',{value:review.id});nextStep(6);notice(t('Project settings applied.'));}finally{document.querySelector('.workbench').inert=false;if($('next'))$('next').disabled=false;} });
            else nextStep(state.step+1);
        };
        bindPaths();
    }
    function libraryFields(value) {
        const paths=value.split('|').map(value=>value.trim()).filter(Boolean);
        return '<div class="field"><label>'+t('Project libraries')+'</label><div class="directory-list">'+paths.map((value,index)=>'<div><input data-library-index="'+index+'" aria-label="'+t('Project libraries')+' '+(index+1)+'" value="'+escape(value)+'"><button data-library-remove="'+index+'" aria-label="'+escape(t('Remove folder')+': '+value)+'">×</button></div>').join('')+'</div><button id="add-library">'+t('Add folder')+'…</button><small>'+t('Project paths are saved relative to the selected folder whenever supported.')+'</small></div>';
    }
    function bindLibraries() {
        const paths=()=>state.setup.libraries.split('|').map(value=>value.trim()).filter(Boolean);
        content.querySelectorAll('[data-library-index]').forEach(input=>input.onchange=()=>{const values=paths();values[Number(input.dataset.libraryIndex)]=input.value;state.setup.libraries=values.join('|');saveProgress();});
        content.querySelectorAll('[data-library-remove]').forEach(button=>button.onclick=()=>{state.setup.libraries=paths().filter((_,i)=>i!==Number(button.dataset.libraryRemove)).join('|');saveProgress();render();});
        $('add-library').onclick=()=>task('Choosing a path…',async()=>{const value=await rpc('pickPath',{key:'setup.libraries'});if(value!==undefined){state.setup.libraries=[...new Set([...paths(),value])].join('|');saveProgress();render();}notice('');});
    }
    function showInspection() {
        if(!$('scan-result')||!inspection)return;
        const groups=[['SPPR scenarios',inspection.sppr],['Processes',inspection.processes],['Vanessa features',inspection.features],['Export libraries',inspection.libraries],['Launch JSON files',inspection.launchJson],['Existing project metadata',inspection.metadata]];
        $('scan-result').innerHTML='<ul class="result-list">'+groups.map(([label,files])=>'<li>'+t(label)+' · '+files.length+(files.length?'<small>'+files.slice(0,3).map(escape).join('<br>')+'</small>':'')+'</li>').join('')+'</ul>'+(inspection.truncated?'<p class="field-error">'+t('Inspection reached its limit. Choose a smaller project folder.')+'</p>':'');
    }
    function renderRuntime() {
        const draft=state.setup;
        $('runtime-tools').innerHTML=pathField('platform','1C platform',draft.platform,'setup.platform','Choose an installed 1cv8c.exe. Local execution currently requires Windows.')+pathField('vanessa','Vanessa Automation processing',draft.vanessa,'setup.vanessa','Select vanessa-automation.epf from the extracted distribution. The step catalog version is detected from docs/Changelog.md beside it.')+(draft.mode==='sppr'?pathField('compiler','SPPR compiler',draft.compiler,'setup.compiler','In SPPR Configurator, save the СборкаТекстовСценариев processing to a separate .epf file in the project build folder.'):'')+'<button id="check-runtime">'+t('Check environment')+'</button><div id="runtime-checks"></div><div class="subtle-box">'+t('Checking does not create a database or run a test. Service database preparation starts after you apply the plan.')+'</div><button class="text-button" id="postpone">'+t('Connect later and continue')+'</button>';
        for(const key of ['platform','vanessa','compiler'])if($(key))$(key).onchange=()=>{draft[key]=$(key).value;runtime=undefined;saveProgress();};
        $('postpone').onclick=()=>{draft.run=false;nextStep(4);};
        $('check-runtime').onclick=()=>task('Checking the environment…',async()=>{runtime=await rpc('checkRuntime',{data:draft});if(!draft.platform&&runtime.platforms[0]){draft.platform=runtime.platforms[0].clientExePath;$('platform').value=draft.platform;saveProgress();}showRuntime();notice(t('Environment check finished.'));});
        showRuntime();
    }
    function showRuntime(){if(!$('runtime-checks')||!runtime)return;$('runtime-checks').innerHTML='<ul class="checks-list">'+runtime.checks.map(check=>'<li><span class="status">'+(check.ok?'✓':'!')+'</span>'+escape(check.label)+'<small>'+escape(check.message)+'</small></li>').join('')+'</ul><p>'+t('Step catalog version')+': '+escape(runtime.version||t('Not detected; the latest available catalog is used.'))+'</p>';}
    function showReview(){
        if(!$('setup-plan')||!review)return;
        $('setup-plan').innerHTML='<h2>'+t('Files to create')+'</h2>'+(review.files.length?'<ul class="plan-files">'+review.files.map(file=>'<li><code>'+escape(file)+'</code></li>').join('')+'</ul>':'<p>'+t('No source files will be replaced.')+'</p>')+'<h2>'+t('Settings to save')+'</h2><div class="table-wrap"><table><thead><tr><th>'+t('Setting')+'</th><th>'+t('Value')+'</th><th>'+t('Scope')+'</th></tr></thead><tbody>'+review.settings.map(change=>'<tr><td>'+escape(boot.model.settings.find(item=>item.key===change.key)?.label||change.key)+'</td><td>'+escape(change.value)+'</td><td>'+t(change.scope)+'</td></tr>').join('')+'</tbody></table></div><p>'+escape(review.profile)+'</p>'+(review.migrateLegacy?'<h2>'+t('Metadata migration')+'</h2><p>'+t('Supported groups and metadata will use the current shared format. Source UID and test text are preserved. Unknown or conflicting entries are not overwritten.')+'</p><ul class="plan-files">'+review.migrate.map(file=>'<li><code>'+escape(file)+'</code></li>').join('')+'</ul>':'')+(review.run?'<p>'+t('Prepare the service database and connect Vanessa after saving.')+'</p>':'')+'<p class="muted">'+t('Changing the source format is a separate conversion, not part of this setup.')+'</p>';
    }
    function tourHtml(){return '<div class="tour"><div class="tour-map">'+tours.map(([,name],i)=>'<button data-tour="'+i+'" class="'+(i===state.tour?'selected':'')+'">'+t(name)+'</button>').join('')+'</div><div class="tour-detail"><h2>'+t(tours[state.tour][1])+'</h2><p>'+t(tours[state.tour][2])+'</p><button id="show-tool">'+t('Show in VS Code')+'</button></div></div>';}
    function bindTour(){content.querySelectorAll('[data-tour]').forEach(button=>button.onclick=()=>{state.tour=Number(button.dataset.tour);persist();render();});$('show-tool').onclick=()=>task('Opening tool…',()=>rpc('action',{action:tours[state.tour][0]}));}
    function render() {
        if(!boot)return;notice('');navigation();
        if(state.view==='settings')settings();else if(state.view==='help'){content.innerHTML='<h1>'+t('Where to find tools')+'</h1>'+tourHtml();bindTour();}else setup();
        content.scrollTop=0;persist();
    }
    window.addEventListener('message',event=>{
        const message=event.data;
        if(message.type==='response'){
            const pending=waiting.get(message.id);if(!pending)return;waiting.delete(message.id);
            if(message.error){const error=new Error(message.error);error.applied=message.applied;pending.reject(error);}else pending.resolve(message.data);
        }else if(message.type==='boot'){
            boot=message;state.folder=boot.folders.some(folder=>folder.id===state.folder)?state.folder:boot.folder;state.scope=state.folder?state.scope:'user';
            state.view=boot.view;state.setupOpen=boot.view==='setup';
            if(boot.progress?.draft){state.setup=boot.progress.draft;state.step=boot.progress.complete?0:boot.progress.step;state.readiness=boot.progress.readiness;}
            for(const change of boot.drafts||[])drafts.set(draftId(change.folder,change.scope,change.key),change);
            render();
        }else if(message.type==='configurationChanged'&&state.view==='settings'){void task('Reading changed settings…',async()=>{await loadRows();notice(drafts.size?t('External settings changed. Review marked drafts before applying.'):'');});}
    });
    void rpc('ready');
})();
