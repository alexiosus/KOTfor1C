/* KOT workspace page. All IO is performed by the extension host over validated messages. */
(() => {
    'use strict';
    const api = acquireVsCodeApi();
    const saved = api.getState() || {};
    const state = { view:'settings', setupOpen:false, step:0, folder:'', scope:'folder', section:'editor', query:'', tour:0, ...saved };
    let boot; let rows = []; let sequence = 0; let readGeneration = 0; let review; let inspection; let runtime; let writing = false; let noticeRevision = 0; let activeTasks = 0; let setupRequest;
    let executionPreparing = false;
    let vanessaDownloading = false; let vanessaDownloadRequest; let vanessaDownloadProgress;
    let vanessaLibraryGeneration = 0;
    let compilerExporting = false;
    let setupCheck; let inspectionKey; let runtimeKey;
    const downloadControls = new Map();
    const waiting = new Map(); const drafts = new Map();
    const $ = id => document.getElementById(id);
    const content = $('content');
    const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const t = text => boot?.model.strings[text] || text;
    const draftId = (folder,scope,key) => JSON.stringify([folder,scope,key]);
    function persist() { api.setState({ view:state.view,setupOpen:state.setupOpen,step:state.step,folder:state.folder,scope:state.scope,section:state.section,query:state.query,tour:state.tour,setup:state.setup }); }
    function notice(text,error=false) { noticeRevision++;$('notice').textContent=text;$('notice').classList.toggle('notice-error',error); }
    function rpc(type,data={}) { const id=String(++sequence);if(type==='applySetup')setupRequest=id;if(type==='downloadVanessa')vanessaDownloadRequest=id;return new Promise((resolve,reject)=>{waiting.set(id,{resolve,reject});api.postMessage({id,type,folder:state.folder||undefined,scope:state.scope,...data});}); }
    function setupControls(disabled) {
        for(const id of ['brand','section-select','start-setup','native-settings','to-start','back','next'])if($(id))$(id).disabled=disabled;
        for(const id of ['navigation','section-navigation'])$(id).querySelectorAll('[data-view]').forEach(button=>button.disabled=disabled);
        $('notice').classList.toggle('notice-busy',disabled);
    }
    async function task(label,action) {
        notice(t(label));content.setAttribute('aria-busy','true');
        const progressRevision=noticeRevision;activeTasks++;
        try { const result=await action();if(noticeRevision===progressRevision)notice('');return result; }
        catch(error) { notice(error.message,true);return undefined; }
        finally { if(--activeTasks===0)content.removeAttribute('aria-busy'); }
    }
    const folder = () => boot.folders.find(folder=>folder.id===state.folder);
    function defaultSetup() { return { transition:false,route:'new',mode:'vanessa',language:'ru',format:'native',sources:'tests',libraries:'libraries',run:false,platform:'',catalogMode:boot.catalogSettings?.[state.folder]?.mode||'online',vanessa:boot.catalogSettings?.[state.folder]?.vanessa||'tools/vanessa/vanessa-automation.epf',compiler:'build/BuildScenarioBDD.epf',profileId:'new' }; }
    function pathControl(id,label,value,key) { return '<div class="path-control"><input id="'+id+'" aria-label="'+escape(t(label))+'" value="'+escape(value)+'"><button type="button" data-path="'+key+'" data-target="'+id+'" aria-label="'+escape(t('Browse')+': '+t(label))+'">'+t('Browse')+'…</button></div>'; }
    function pathField(id,label,value,key,hint='') { return '<div class="field"><label for="'+id+'">'+escape(t(label))+'</label>'+pathControl(id,label,value,key)+(hint?'<small>'+escape(t(hint))+'</small>':'')+'</div>'; }
    function bindPaths() {
        content.querySelectorAll('[data-path]').forEach(button=>button.onclick=()=>task('Choosing a path…',async()=>{
            const value=await rpc('pickPath',{key:button.dataset.path});if(value===undefined){notice('');return;}
            const input=$(button.dataset.target);input.value=value;input.dispatchEvent(new Event('input'));input.dispatchEvent(new Event('change'));
            notice(t('Path selected. Apply to save it.'));
        }));
    }
    function projectSelect(onlyMultiple=false) {
        if(onlyMultiple&&boot.folders.length===1)return '';
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
        $('section-navigation').innerHTML=sections.map(section=>'<button data-section="'+section.id+'" class="section-button '+(section.id===state.section?'selected':'')+'">'+escape(section.title)+'</button>').join('');
        $('section-navigation').querySelectorAll('[data-section]').forEach(button=>button.onclick=()=>{state.section=button.dataset.section;state.query='';persist();render();});
        $('navigation-actions').innerHTML='<button id="start-setup" class="text-button">'+t('Start project setup')+'…</button><button id="native-settings" class="text-button">'+t('Open VS Code Settings')+'</button><button id="repository-link" class="text-button">'+t('Project GitHub')+'</button><button id="changelog-link" class="text-button">'+t('Changelog')+'</button>';
        $('start-setup').onclick=startSetup;
        $('native-settings').onclick=()=>rpc('openNative');
        $('repository-link').onclick=()=>task('Opening repository…',()=>rpc('openRepository'));
        $('changelog-link').onclick=()=>task('Opening changelog…',()=>rpc('openChangelog'));
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
    function catalogProgressHtml() {
        return '<div id="catalog-progress" class="catalog-progress muted" role="status" aria-live="polite" hidden><span id="catalog-progress-label"></span><progress id="catalog-progress-bar" max="100" aria-label="'+escape(t('Preparing the offline step catalog…'))+'"></progress></div>';
    }
    function renderCatalogProgress() {
        const area=$('catalog-progress');if(!area)return;
        const catalog=boot.catalogSettings?.[state.folder],progress=catalog?.progress;
        area.hidden=catalog?.mode!=='offline'||!progress;if(area.hidden)return;
        const busy=progress.phase==='preparing'||progress.phase==='exporting';
        const counts=Number.isInteger(progress.completed)&&Number.isInteger(progress.total)&&progress.total>0;
        const text=progress.phase==='ready'?t('Step catalog ready: {0} steps.').replace('{0}',progress.stepCount):
            progress.phase==='error'?t('Could not prepare the offline step catalog: {0}').replace('{0}',progress.error||''):
            progress.phase==='exporting'&&counts?t('Reading step categories: {0}/{1}').replace('{0}',progress.completed).replace('{1}',progress.total):t('Preparing the offline step catalog…');
        $('catalog-progress-label').textContent=text;
        area.setAttribute('aria-busy',String(busy));area.classList.toggle('field-error',progress.phase==='error');
        const bar=$('catalog-progress-bar');bar.hidden=!busy;
        if(counts){bar.max=progress.total;bar.value=progress.completed;}else bar.removeAttribute('value');
    }
    function vanessaSetupHtml() {
        const draft=state.setup;draft.catalogMode ||=boot.catalogSettings?.[state.folder]?.mode||'online';
        return pathField('catalog-vanessa','Vanessa Automation processing',draft.vanessa,'setup.vanessa','Choose a local Vanessa distribution for step suggestions and test execution. You can skip this when using only the online catalog.')+vanessaDownloadHtml()+'<label class="field"><span>'+t('Step catalog')+'</span><select id="catalog-mode"><option value="online">'+t('Online')+'</option><option value="offline">'+t('Offline')+'</option></select><small>'+t('The catalog provides Vanessa step suggestions and validation. Online mode downloads it from the internet; offline mode generates it from your local Vanessa distribution.')+'</small></label>';
    }
    function bindVanessaSetup() {
        if(!$('catalog-mode'))return;
        $('catalog-mode').value=state.setup.catalogMode;
        $('catalog-mode').onchange=()=>{state.setup.catalogMode=$('catalog-mode').value;review=undefined;saveProgress();render();};
        if($('catalog-vanessa'))$('catalog-vanessa').onchange=()=>{state.setup.vanessa=$('catalog-vanessa').value;invalidateRuntime();saveProgress();void suggestVanessaLibrary();};
        bindVanessaDownload();
    }
    function vanessaDownloadHtml() {
        return '<div class="vanessa-download"><button type="button" id="download-vanessa" class="text-button" '+(vanessaDownloading?'disabled':'')+'>'+t('Download from GitHub…')+'</button><small>'+t('Choose an official release. Each version is saved separately in tools/vanessa inside the project.')+'</small><div id="vanessa-download-progress" role="status" '+(!vanessaDownloading?'hidden':'')+'><span id="vanessa-download-label"></span><progress id="vanessa-download-bar"></progress><button id="cancel-vanessa-download" class="text-button">'+t('Cancel')+'</button></div></div>';
    }
    function renderVanessaDownloadProgress() {
        if(!$('vanessa-download-progress'))return;
        $('vanessa-download-progress').hidden=!vanessaDownloading;
        $('download-vanessa').disabled=vanessaDownloading;
        const value=vanessaDownloadProgress;
        const counts=Number.isFinite(value?.completed)&&Number.isFinite(value?.total)&&value.total>0;
        $('vanessa-download-label').textContent=(value?.label||t('Loading official Vanessa releases…'))+(counts?' '+Math.floor(value.completed/value.total*100)+'%':'');
        const bar=$('vanessa-download-bar');bar.max=100;if(counts)bar.value=Math.floor(value.completed/value.total*100);else bar.removeAttribute('value');
    }
    function lockDownloadNavigation() {
        if(vanessaDownloading){
            for(const id of ['back','next','skip-check','project']){
                const control=$(id);if(!control)continue;
                if(!downloadControls.has(control))downloadControls.set(control,control.disabled);
                control.disabled=true;
            }
        }else{for(const [control,disabled] of downloadControls)control.disabled=disabled;downloadControls.clear();}
    }
    function bindVanessaDownload() {
        if(!$('download-vanessa'))return;
        renderVanessaDownloadProgress();
        $('cancel-vanessa-download').onclick=()=>rpc('cancelVanessaDownload',{value:vanessaDownloadRequest});
        $('download-vanessa').onclick=()=>{
            if(vanessaDownloading)return;
            const identity=state.folder;const draft=state.setup;const original=draft.vanessa;
            vanessaDownloading=true;vanessaDownloadProgress=undefined;renderVanessaDownloadProgress();lockDownloadNavigation();
            return task('Loading official Vanessa releases…',async()=>{
                try{
                    const result=await rpc('downloadVanessa');
                    if(!result){notice(t('Vanessa download cancelled.'));return;}
                    if(state.folder!==identity||state.setup!==draft||draft.vanessa!==original){notice(t('Vanessa was saved to {0}. The selected path was kept.').replace('{0}',result.path));return;}
                    draft.vanessa=result.path;invalidateRuntime();saveProgress();render();
                    notice(t('Vanessa {0} downloaded. Apply the setup plan to save its path.').replace('{0}',result.version));
                }finally{vanessaDownloading=false;vanessaDownloadRequest=undefined;renderVanessaDownloadProgress();lockDownloadNavigation();}
            });
        };
    }
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
        const download=item.key==='kotTestToolkit.paths.fileWorkshopExe'?'<button class="text-button" data-file-workshop-download>'+t('Download File Workshop from the official 1C website')+'</button>':item.key==='kotTestToolkit.paths.buildScenarioBddEpf'&&state.folder?'<button class="text-button" data-export-compiler="" '+(compilerExporting?'disabled':'')+'>'+t('Export from SPPR…')+'</button>':'';
        return '<div class="setting '+(conflict?'setting-conflict':'')+'" data-setting="'+item.key+'"><div class="setting-heading"><label for="'+id+'">'+escape(item.label)+'</label>'+info+'</div><div class="description">'+escape(hint)+'</div><div class="control">'+controls(item,id,currentValue(item))+'</div>'+download+(item.key==='kotTestToolkit.steps.catalogMode'?catalogProgressHtml():'')+(conflict?'<p class="field-error">'+t('Changed outside this page. Keep the external value or review your draft before applying.')+' <button class="text-button" data-use-current="'+item.key+'">'+t('Use current value')+'</button></p>':'')+'<div class="source">'+t('Source')+': '+t(row?.source||'default')+(item.editor==='manager'||item.editor==='action'?'':' <button class="text-button reset" data-reset="'+item.key+'">'+t('Reset in this scope')+'</button>')+' <button class="text-button reset" data-native="'+item.key+'">'+t('VS Code Settings')+'</button></div></div>';
    }
    async function loadRows() {
        const generation=++readGeneration;const next=await rpc('settings');if(generation!==readGeneration)return;rows=next;renderFields();
    }
    function settings() {
        const section=boot.model.sections.find(section=>section.id===state.section)||boot.model.sections[0];
        content.innerHTML='<header class="settings-header"><div class="eyebrow">KOT</div><h1>'+escape(section.title)+'</h1>'+projectSelect(true)+'<div class="settings-bar"><input id="search" aria-label="'+t('Search settings')+'" placeholder="'+t('Search by purpose or technical name')+'" value="'+escape(state.query)+'"><select id="scope" aria-label="'+t('Change scope')+'"><option value="user">'+t('User')+'</option><option value="workspace">'+t('Workspace')+'</option><option value="folder">'+t('Selected folder')+'</option></select></div><p id="result-count" class="muted"></p></header><div class="settings-fields"><div id="setting-fields">'+t('Reading settings…')+'</div></div><footer class="save-bar"><span id="pending-count"></span><button id="discard">'+t('Discard')+'</button><button id="apply" class="primary">'+t('Apply')+'</button></footer>';
        bindProject();
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
        content.querySelectorAll('[data-file-workshop-download]').forEach(button=>button.onclick=()=>rpc('openFileWorkshopDownload'));
        content.querySelectorAll('[data-export-compiler]').forEach(button=>button.onclick=()=>{
            const item=boot.model.settings.find(item=>item.key==='kotTestToolkit.paths.buildScenarioBddEpf');
            const identity=state.folder,scope=state.scope,original=currentValue(item);
            return exportCompiler(button,original,result=>{
                if(state.folder!==identity||state.scope!==scope||currentValue(item)!==original)return false;
                stage(item,result);renderFields();return true;
            });
        });
        bindPaths();updatePending();renderCatalogProgress();
    }
    function updatePending() {
        if(!$('pending-count'))return;const invalid=!!content.querySelector('[aria-invalid="true"]');
        $('pending-count').textContent=invalid?t('Check the highlighted value.'):drafts.size?t('Pending changes')+': '+drafts.size:t('No pending changes');
        $('apply').disabled=writing||!drafts.size||invalid;$('discard').disabled=writing||!drafts.size&&!invalid;
    }
    const routes=[['new','Start from scratch','Create a small project or try the workshop.'],['sppr','I have an SPPR project','Find scenarios, processes and run settings.'],['vanessa','I have a Vanessa project','Use existing feature files, export libraries and launch JSON.'],['legacy','I used an earlier KOT version','Review existing settings and the metadata migration plan.']];
    const tours=[['manager','Test Manager','Select tests for compilation, run them and see results.'],['library','Library','Find steps and reusable scenarios; insert calls and use F12 to open their definitions.'],['properties','Test properties','Edit the selected test on the right. Save, run and favorite actions are in its header.'],['infobases','Infobases','Open bases, choose platforms and manage test clients under each base.'],['variables','Vanessa and variables','The bottom status bar shows Vanessa. F11 runs the step at the caret; runtime variables are on the right.']];
    function footer(next='Continue',check=false) { return '<div class="actions"><button id="back">'+t('Back')+'</button><span class="spacer"></span>'+(check?'<button id="skip-check">'+t('Skip check')+'</button>':'')+'<button id="next" class="primary">'+t(next)+'</button></div>'; }
    function checkStep() { return state.view==='setup'&&(state.step===1||state.step===3&&state.setup.run); }
    function inspectionSignature() { return JSON.stringify([state.folder,state.setup.route,state.setup.mode]); }
    function runtimeSignature() { const draft=state.setup;return JSON.stringify([state.folder,draft.mode,draft.platform,draft.vanessa,draft.mode==='sppr'?draft.compiler:'']); }
    function checkPassed() {
        return state.step===1?!!inspection&&!inspection.truncated&&inspectionKey===inspectionSignature():
            !!runtime&&runtimeKey===runtimeSignature()&&runtime.checks.length>0&&runtime.checks.every(check=>check.ok);
    }
    function updateSetupCheckActions() {
        if(!checkStep()||!$('next'))return;
        const passed=checkPassed();const busy=!!setupCheck||compilerExporting||vanessaDownloading;
        $('next').textContent=t(passed?'Continue':'Check');$('next').disabled=busy;
        $('skip-check').hidden=passed;$('skip-check').disabled=busy;
        for(const id of ['back','to-start','export-compiler'])if($(id))$(id).disabled=busy;
        if($('cancel-scan'))$('cancel-scan').hidden=state.step!==1||!setupCheck||setupCheck.cancelled;
    }
    function invalidateRuntime() {
        runtime=undefined;runtimeKey=undefined;state.setup.skipRuntimeCheck=false;review=undefined;
        showRuntime();updateSetupCheckActions();
    }
    function runSetupCheck() {
        if(setupCheck||compilerExporting||vanessaDownloading)return;
        const job={folder:state.folder,draft:state.setup,step:state.step,key:state.step===1?inspectionSignature():runtimeSignature(),cancelled:false};
        setupCheck=job;
        if(job.step===1){inspection=undefined;inspectionKey=undefined;if($('scan-result'))$('scan-result').innerHTML='';}
        else invalidateRuntime();
        updateSetupCheckActions();
        return task(job.step===1?'Inspecting project files…':'Checking the environment…',async()=>{
            try {
                const result=await rpc(job.step===1?'scan':'checkRuntime',job.step===1?{}:{data:{...job.draft}});
                if(job.cancelled||state.view!=='setup'||state.folder!==job.folder||state.setup!==job.draft||state.step!==job.step
                    ||job.key!==(job.step===1?inspectionSignature():runtimeSignature()))return;
                if(job.step===1){
                    inspection=result;inspectionKey=job.key;const roots=result.roots[job.draft.mode];
                    if(job.draft.route!=='new'&&roots.sources){job.draft.sources=roots.sources;if(roots.libraries)job.draft.libraries=roots.libraries;saveProgress();}
                    showInspection();notice(t('Inspection complete. No files changed.'));
                }else{
                    runtime=result;
                    if(!job.draft.platform&&runtime.platforms[0]){job.draft.platform=runtime.platforms[0].clientExePath;$('platform').value=job.draft.platform;saveProgress();}
                    runtimeKey=runtimeSignature();showRuntime();
                    notice(t(checkPassed()?'Environment check finished.':'Fix the highlighted environment issues or skip the check.'),!checkPassed());
                }
            } finally { if(setupCheck===job)setupCheck=undefined;updateSetupCheckActions(); }
        });
    }
    function setupPage(html) {
        let titleEnd=html.indexOf('</h1>')+5;
        const lead=/^<p class="lead">[\s\S]*?<\/p>/u.exec(html.slice(titleEnd));if(lead)titleEnd+=lead[0].length;
        const actions=html.lastIndexOf('<div class="actions">');
        content.innerHTML='<header class="setup-header">'+html.slice(0,titleEnd)+'</header><div id="setup-fields" class="setup-fields">'+html.slice(titleEnd,actions<0?undefined:actions)+'</div>'+(actions<0?'':'<footer id="setup-footer" class="setup-footer">'+html.slice(actions)+'</footer>');
    }
    function saveProgress() { persist();if(state.folder&&state.step!==6)void rpc('progress',{data:{step:state.step,draft:state.setup}}).catch(error=>notice(error.message,true)); }
    function nextStep(step) { if(vanessaDownloading||setupCheck||compilerExporting)return;state.step=step;saveProgress();render(); }
    function setup() {
        const draft=state.setup ||=defaultSetup();
        const heading='<div class="page-navigation"><button id="to-start" class="text-button">← '+t('Back to start')+'</button></div>';
        const prefix=state.step?'<div class="eyebrow">'+t('Project setup')+' · '+state.step+' / 5</div>':'<div class="eyebrow">KOT</div>';
        if(state.step===0){
            setupPage('<h1>'+t('Where shall we start?')+'</h1><p class="lead">'+t('You can write tests without 1C. Connect execution when you need it.')+'</p>'+projectSelect()+'<div class="route-list">'+routes.map(([route,title,description])=>'<button class="route" data-route="'+route+'"><span class="arrow">→</span><span><strong>'+t(title)+'</strong><small>'+t(description)+'</small></span></button>').join('')+'</div><div class="page-actions"><button id="workshop">'+t('Open a copy of the workshop')+'…</button></div>');
            content.querySelectorAll('[data-route]').forEach(button=>button.onclick=()=>{if(!folder()){notice(t('Open a local project folder first.'),true);return;}draft.route=button.dataset.route;draft.mode=draft.route==='sppr'||draft.route==='legacy'?'sppr':'vanessa';if(draft.route!=='new'){draft.sources=boot.profilePaths?.sources||draft.sources;draft.libraries=boot.profilePaths?.libraries||draft.libraries;}nextStep(1);});
            $('workshop').onclick=()=>task('Copying the workshop…',()=>rpc('openWorkshop'));bindProject();
        }else if(state.step===1){
            setupPage(heading+prefix+'<h1>'+t('Inspect the project')+'</h1><p class="lead">'+t('This step only reads files. No migration runs until you apply the plan.')+'</p>'+projectSelect()+(draft.route==='new'?'<label class="field"><span>'+t('Test approach')+'</span><select id="mode"><option value="vanessa">Vanessa feature</option><option value="sppr">СППР / SPPR</option></select></label>':'')+'<div class="operation"><button id="cancel-scan" hidden>'+t('Cancel')+'</button></div><div id="scan-result"></div>'+footer('Check',true));
            if($('mode')){$('mode').value=draft.mode;$('mode').onchange=()=>{draft.mode=$('mode').value;inspection=undefined;inspectionKey=undefined;$('scan-result').innerHTML='';review=undefined;saveProgress();updateSetupCheckActions();};}
            $('cancel-scan').onclick=()=>{if(setupCheck){setupCheck.cancelled=true;$('cancel-scan').hidden=true;return rpc('cancel');}};showInspection();bindProject();
        }else if(state.step===2){
            setupPage(heading+prefix+'<h1>'+t('Prepare the editor')+'</h1>'+
                '<label class="field"><span>'+t('Compilation and run profile')+'</span><select id="profile"><option value="new">'+t('Create a separate profile')+'</option>'+boot.profiles.profiles.map(profile=>'<option value="'+escape(profile.id)+'">'+escape(profile.name)+'</option>').join('')+'</select><small>'+t('Existing profiles are not overwritten. A selected profile keeps its existing roots and options.')+'</small></label>'+
                pathField('sources','Scenario folder',draft.sources,'setup.sources')+
                '<label class="field"><span>'+t('New scenario language')+'</span><select id="language"><option value="en">English</option><option value="ru">Русский</option></select></label>'+
                (draft.mode==='sppr'?'<label class="field"><span>'+t('New SPPR source format')+'</span><select id="format"><option value="native">feature + meta.yaml</option><option value="legacy">scen.yaml</option></select><small>'+t('Existing source files keep their format.')+'</small></label>':'')+
                (draft.route!=='new'&&boot.folders.find(folder=>folder.id===state.folder)?.format!=='v3'?'<label class="field"><span><input id="transition" type="checkbox" '+(draft.transition?'checked':'')+'> '+t('Enable KOT 3 format for this branch; CI has been prepared')+'</span><small>'+t('Leave unchecked to preserve the current YAML and CI format. Updating the extension does not require a project transition.')+'</small></label>':'')+
                vanessaSetupHtml()+libraryFields(draft.libraries)+mxlOptionsHtml()+footer());
            for(const key of ['language','format','sources'])if($(key)){$(key).value=draft[key];$(key).onchange=()=>{draft[key]=$(key).value;review=undefined;saveProgress();};}
            if($('transition')){const applyCompatibility=()=>{if($('format')){$('format').disabled=!draft.transition;if(!draft.transition){draft.format='legacy';$('format').value='legacy';}}};applyCompatibility();$('transition').onchange=()=>{draft.transition=$('transition').checked;applyCompatibility();review=undefined;saveProgress();};}
            bindLibraries();
            bindMxlOptions();
            $('profile').value=draft.profileId;$('profile').onchange=()=>{draft.profileId=$('profile').value;saveProgress();};
            if(state.folder!==boot.primaryFolder){$('setup-fields').insertAdjacentHTML('afterbegin','<div class="subtle-box">'+t('Build profiles currently apply to one project window. Open this folder separately to continue setup.')+' <button id="own-window">'+t('Open project in a new window')+'</button></div>');$('own-window').onclick=()=>rpc('openProjectWindow');$('next').disabled=true;}
        }else if(state.step===3){
            setupPage(heading+prefix+'<h1>'+t('Connect execution?')+'</h1><p class="lead">'+t('The editor is enough to start writing tests. Connect 1C and Vanessa to run them and explore forms.')+'</p>'+(draft.run?'<div id="runtime-tools"></div>':'<div class="execution-choice"><button id="connect-now" class="primary">'+t('Connect 1C and Vanessa')+'</button><button id="editor-only">'+t('Editor only for now')+'</button></div>')+(draft.run?footer('Check',true):'<div class="actions"><button id="back">'+t('Back')+'</button></div>'));
            if(draft.run)renderRuntime();else{$('connect-now').onclick=()=>{draft.run=true;render();};$('editor-only').onclick=()=>{draft.run=false;nextStep(4);};}
        }else if(state.step===4){setupPage(heading+prefix+'<h1>'+t('Where to find tools')+'</h1>'+tourHtml()+footer('Review changes'));bindTour();}
        else if(state.step===5){
            setupPage(heading+prefix+'<h1>'+t('Review changes')+'</h1><div id="setup-plan">'+t('Preparing the change plan…')+'</div>'+footer(draft.run&&!draft.skipRuntimeCheck?'Apply and prepare execution':'Apply and start'));
            $('next').disabled=true;
            void task('Preparing the change plan…',async()=>{review=await rpc('reviewSetup',{data:draft});showReview();$('next').disabled=false;notice('');});
        }else{
            setupPage(heading+'<h1>'+t('Ready to start')+'</h1><p class="lead">'+t('Project settings are applied. Open the first test, then use the Library and properties to continue.')+'</p>'+(draft.run?'<p>'+t('See the bottom status bar for the actual Vanessa connection state.')+'</p>':'')+(state.readiness?.compilationIssues?.length?'<div class="subtle-box">'+t('The editor is ready. SPPR compilation needs more parameters:')+' '+state.readiness.compilationIssues.map(escape).join(' ')+' <button id="finish-parameters">'+t('Open editor')+'</button></div>':'')+'<div class="page-actions"><button id="example" class="primary">'+t(draft.mode==='sppr'?'Open the first SPPR scenario':'Open the first Vanessa feature')+'</button><button id="settings-done">'+t('Open settings')+'</button></div><p>'+t(draft.mode==='sppr'?'In SPPR, properties contain parameters and run settings. F12 opens a nested scenario; Test Manager compiles the main test before Vanessa runs it.':'A Vanessa feature runs directly. Find a step in the Library, edit tags and launch JSON in properties, then use F11 after connecting Vanessa.')+'</p>');
            if(draft.run){$('setup-fields').insertAdjacentHTML('afterbegin','<div id="execution-state" class="subtle-box"></div>');renderExecutionState();}
            if($('finish-parameters'))$('finish-parameters').onclick=()=>rpc('action',{action:'parameters'});
            $('example').onclick=()=>task('Opening the test…',()=>rpc('openExample'));$('settings-done').onclick=()=>{state.view='settings';render();};
        }
        if($('to-start'))$('to-start').onclick=()=>nextStep(0);
        if($('back'))$('back').onclick=()=>nextStep(Math.max(0,state.step-1));
        if($('skip-check'))$('skip-check').onclick=()=>{if(setupCheck||compilerExporting||vanessaDownloading)return;if(state.step===3){draft.skipRuntimeCheck=true;review=undefined;}nextStep(state.step+1);};
        if($('next'))$('next').onclick=()=>{
            if(checkStep()&&!checkPassed())return runSetupCheck();
            if(state.step===5){if(setupRequest)return;void task('Applying the reviewed project setup…',async()=>{
                setupControls(true);
                try{state.readiness=await rpc('applySetup',{value:review.id});nextStep(6);notice(t('Project settings applied.'));}
                finally{setupRequest=undefined;setupControls(false);}
                if(draft.run&&!draft.skipRuntimeCheck)void prepareExecution();
            });}
            else nextStep(state.step+1);
        };
        if(state.step>=2){($('setup-footer')||$('setup-fields')).insertAdjacentHTML('afterbegin',catalogProgressHtml());renderCatalogProgress();}
        bindPaths();bindVanessaSetup();updateSetupCheckActions();
    }
    function renderExecutionState() {
        const area=$('execution-state');if(!area)return;
        area.innerHTML=executionPreparing?t('Project settings are applied. Preparing 1C and Vanessa…'):
            state.readiness?.executionReady?t('Vanessa connected.'):
            t('The editor is ready. Vanessa preparation was not completed; execution is still disconnected.')+(state.readiness?.executionError?'<p>'+escape(state.readiness.executionError)+'</p>':'')+' <button id="retry-execution">'+t('Retry connecting Vanessa')+'</button>';
        area.setAttribute('aria-busy',String(executionPreparing));
        area.classList.toggle('execution-busy',executionPreparing);
        if($('retry-execution'))$('retry-execution').onclick=prepareExecution;
    }
    async function prepareExecution() {
        if(executionPreparing)return;
        executionPreparing=true;renderExecutionState();
        try{await task('Preparing Vanessa…',async()=>{
            try{const result=await rpc('retryExecution');state.readiness={...state.readiness,...result,executionError:''};persist();notice(t(result.executionReady?'Vanessa connected.':'Vanessa is still disconnected.'),!result.executionReady);}
            catch(error){state.readiness={...state.readiness,executionError:error.message};persist();throw error;}
        });}finally{executionPreparing=false;renderExecutionState();}
    }
    function mxlOptionsHtml() {
        const draft=state.setup;const configured=boot.fileSettings?.[state.folder];
        draft.mxlOpeningMode??=configured?.mode||'fileWorkshop';draft.fileWorkshop??=configured?.fileWorkshop||'';
        return '<label class="field"><span>'+t('Open MXL files with')+'</span><select id="mxl-mode"><option value="fileWorkshop">'+t('1C:Enterprise — File Workshop')+'</option><option value="platform">'+t('1C platform')+'</option></select><small>'+t('Choose how to view and edit spreadsheet templates from scenarios and the Library.')+'</small></label><div id="mxl-options"></div>';
    }
    function bindMxlOptions() {
        const draft=state.setup;$('mxl-mode').value=draft.mxlOpeningMode;
        const details=()=>{
            $('mxl-options').innerHTML=draft.mxlOpeningMode==='platform'?'<p class="muted">'+t('KOT uses the connected Vanessa manager when its API supports MXL opening; otherwise it opens the file in its service infobase. An installed 1C platform is required.')+'</p>':
                pathField('file-workshop','File Workshop executable',draft.fileWorkshop,'setup.fileWorkshop','Select 1cv8fv.exe from the installed File Workshop. The program is optional for writing tests.')+'<button class="text-button" id="download-file-workshop">'+t('Download File Workshop from the official 1C website')+'</button>';
            if($('file-workshop'))$('file-workshop').onchange=()=>{draft.fileWorkshop=$('file-workshop').value;review=undefined;saveProgress();};
            if($('download-file-workshop'))$('download-file-workshop').onclick=()=>rpc('openFileWorkshopDownload');
            bindPaths();
        };
        $('mxl-mode').onchange=()=>{draft.mxlOpeningMode=$('mxl-mode').value;review=undefined;saveProgress();details();};details();
    }
    function libraryFields(value) {
        const paths=value.split('|').map(value=>value.trim()).filter(Boolean);
        return '<div class="field"><label>'+t('Project libraries')+'</label><div class="directory-list">'+paths.map((value,index)=>'<div><input data-library-index="'+index+'" aria-label="'+t('Project libraries')+' '+(index+1)+'" value="'+escape(value)+'"><button data-library-remove="'+index+'" aria-label="'+escape(t('Remove folder')+': '+value)+'">×</button></div>').join('')+'</div><button id="add-library">'+t('Add folder')+'…</button><small>'+t('Project paths are saved relative to the selected folder whenever supported.')+'</small><div id="vanessa-library-suggestion" hidden><button id="add-vanessa-library" class="text-button">'+t('Add Features from the selected Vanessa')+'</button><small><code id="vanessa-library-path"></code></small></div></div>';
    }
    function libraryIdentity(value) {
        let full=value.trim().replace(/\\/gu,'/');
        if(!/^(?:\/|[a-z]:\/)/iu.test(full))full=(folder()?.path||'')+'/'+full;
        const parts=[];
        for(const part of full.split('/')){if(part==='..'&&parts.length&&parts.at(-1)!=='..')parts.pop();else if(part&&part!=='.')parts.push(part);}
        const key=parts.join('/');return boot.platform==='win32'?key.toLowerCase():key;
    }
    async function suggestVanessaLibrary() {
        const area=$('vanessa-library-suggestion');if(!area)return;
        area.hidden=true;
        const generation=++vanessaLibraryGeneration;const draft=state.setup;const identity=state.folder;const epf=draft.vanessa;
        if(typeof epf!=='string'||!epf.trim())return;
        try{
            const value=await rpc('suggestVanessaLibrary',{value:epf});
            if(!value||generation!==vanessaLibraryGeneration||state.setup!==draft||state.folder!==identity||draft.vanessa!==epf||$('vanessa-library-suggestion')!==area)return;
            const included=()=>draft.libraries.split('|').some(path=>libraryIdentity(path)===libraryIdentity(value));
            if(included())return;
            $('vanessa-library-path').textContent=value;area.hidden=false;
            $('add-vanessa-library').onclick=()=>{
                if(!included())draft.libraries=[...draft.libraries.split('|').map(path=>path.trim()).filter(Boolean),value].join('|');
                review=undefined;saveProgress();render();
            };
        }catch{ /* An unavailable distribution does not prevent editor setup. */ }
    }
    function bindLibraries() {
        const paths=()=>state.setup.libraries.split('|').map(value=>value.trim()).filter(Boolean);
        content.querySelectorAll('[data-library-index]').forEach(input=>input.onchange=()=>{const values=paths();values[Number(input.dataset.libraryIndex)]=input.value;state.setup.libraries=values.join('|');review=undefined;saveProgress();void suggestVanessaLibrary();});
        content.querySelectorAll('[data-library-remove]').forEach(button=>button.onclick=()=>{state.setup.libraries=paths().filter((_,i)=>i!==Number(button.dataset.libraryRemove)).join('|');review=undefined;saveProgress();render();});
        $('add-library').onclick=()=>task('Choosing a path…',async()=>{const value=await rpc('pickPath',{key:'setup.libraries'});if(value!==undefined){state.setup.libraries=[...new Set([...paths(),value])].join('|');review=undefined;saveProgress();render();}notice('');});
        void suggestVanessaLibrary();
    }
    function showInspection() {
        if(!$('scan-result')||!inspection)return;
        const groups=[['SPPR scenarios',inspection.sppr],['Processes',inspection.processes],['Vanessa features',inspection.features],['Export libraries',inspection.libraries],['Launch JSON files',inspection.launchJson],['Existing project metadata',inspection.metadata]];
        $('scan-result').innerHTML='<ul class="result-list">'+groups.map(([label,files])=>'<li>'+t(label)+' · '+files.length+(files.length?'<small>'+files.slice(0,3).map(escape).join('<br>')+'</small>':'')+'</li>').join('')+'</ul>'+(inspection.truncated?'<p class="field-error">'+t('Inspection reached its limit. Choose a smaller project folder.')+'</p>':'');
    }
    function renderRuntime() {
        const draft=state.setup;
        $('runtime-tools').innerHTML=pathField('platform','1C platform',draft.platform,'setup.platform','Choose an installed 1cv8c.exe. Local execution currently requires Windows.')+'<div class="field"><span>'+t('Vanessa Automation processing')+'</span><code>'+escape(draft.vanessa?.trim()||t('Vanessa has not been selected.'))+'</code><button id="edit-vanessa" class="text-button">'+t('Change on the Prepare the editor step')+'</button></div>'+(draft.mode==='sppr'?pathField('compiler','SPPR compiler',draft.compiler,'setup.compiler','Select an existing compiler EPF or export it from your SPPR infobase.')+'<div class="compiler-export"><button id="export-compiler" class="text-button" '+(compilerExporting?'disabled':'')+'>'+t('Export from SPPR…')+'</button></div>':'')+'<div id="runtime-checks"></div><div class="subtle-box">'+t('Checking does not create a database or run a test.')+' '+t('Skip the check to save the selected paths and connect execution later.')+'</div>';
        for(const key of ['platform','compiler'])if($(key))$(key).onchange=()=>{draft[key]=$(key).value;invalidateRuntime();saveProgress();};
        if($('export-compiler'))$('export-compiler').onclick=()=>{
            const identity=state.folder,original=draft.compiler;
            return exportCompiler($('export-compiler'),original,result=>{
                if(state.folder!==identity||state.setup!==draft||draft.compiler!==original)return false;
                draft.compiler=result;invalidateRuntime();saveProgress();
                if($('compiler'))$('compiler').value=result;return true;
            });
        };
        $('edit-vanessa').onclick=()=>nextStep(2);
        showRuntime();
    }
    function exportCompiler(button,value,accept) {
        if(compilerExporting||setupCheck)return;
        compilerExporting=true;button.disabled=true;updateSetupCheckActions();
        return task('Exporting the SPPR compiler…',async()=>{
            try {
                const result=await rpc('exportSpprCompiler',{value:value||''});
                if(result===undefined){notice(t('SPPR compiler export cancelled.'));return;}
                notice(accept(result)?t('Compiler exported. Apply to save its path.'):t('Compiler saved to {0}. The selected path was kept.').replace('{0}',result));
            } finally {
                compilerExporting=false;button.disabled=false;
                content.querySelectorAll('[data-export-compiler]').forEach(control=>control.disabled=false);
                if($('export-compiler'))$('export-compiler').disabled=false;
                updateSetupCheckActions();
            }
        });
    }
    function showRuntime(){if(!$('runtime-checks'))return;$('runtime-checks').innerHTML=!runtime||runtimeKey!==runtimeSignature()?'':'<ul class="checks-list">'+runtime.checks.map(check=>'<li><span class="status">'+(check.ok?'✓':'!')+'</span>'+escape(check.label)+'<small>'+escape(check.message)+'</small></li>').join('')+'</ul><p>'+t('Step catalog version')+': '+escape(runtime.version||t('Not detected; the latest available catalog is used.'))+'</p>';}
    function showReview(){
        if(!$('setup-plan')||!review)return;
        $('setup-plan').innerHTML='<h2>'+t('Files to create')+'</h2>'+(review.files.length?'<ul class="plan-files">'+review.files.map(file=>'<li><code>'+escape(file)+'</code></li>').join('')+'</ul>':'<p>'+t('No source files will be replaced.')+'</p>')+'<h2>'+t('Settings to save')+'</h2><div class="table-wrap"><table><thead><tr><th>'+t('Setting')+'</th><th>'+t('Value')+'</th><th>'+t('Scope')+'</th></tr></thead><tbody>'+review.settings.map(change=>'<tr><td>'+escape(boot.model.settings.find(item=>item.key===change.key)?.label||change.key)+'</td><td>'+escape(change.value)+'</td><td>'+t(change.scope)+'</td></tr>').join('')+'</tbody></table></div><p>'+escape(review.profile)+'</p>'+(review.transition?'<p class="subtle-box">'+t('This branch will enable KOT 3 through .kot/project.yml. Commit this marker together with its metadata and CI changes.')+'</p>':'<p>'+t('The branch keeps its current project format. No automatic source or metadata transition will run.')+'</p>')+(review.migrateLegacy?'<h2>'+t('Metadata migration')+'</h2><p>'+t('Supported groups and metadata will use the current shared format. Source UID and test text are preserved. Unknown or conflicting entries are not overwritten.')+'</p><ul class="plan-files">'+review.migrate.map(file=>'<li><code>'+escape(file)+'</code></li>').join('')+'</ul>':'')+(review.run?'<p>'+t(review.skipRuntimeCheck?'Environment check skipped. Settings will be saved; connect execution later.':'Prepare the service database and connect Vanessa after saving.')+'</p>':'')+'<p class="muted">'+t('Changing the source format is a separate conversion, not part of this setup.')+'</p>';
    }
    function tourHtml(){return '<div class="tour"><div class="tour-map">'+tours.map(([,name],i)=>'<button data-tour="'+i+'" class="'+(i===state.tour?'selected':'')+'">'+t(name)+'</button>').join('')+'</div><div class="tour-detail"><h2>'+t(tours[state.tour][1])+'</h2><p>'+t(tours[state.tour][2])+'</p><button id="show-tool">'+t('Show in VS Code')+'</button></div></div>';}
    function bindTour(){content.querySelectorAll('[data-tour]').forEach(button=>button.onclick=()=>{state.tour=Number(button.dataset.tour);persist();render();});$('show-tool').onclick=()=>task('Opening tool…',()=>rpc('action',{action:tours[state.tour][0]}));}
    function render() {
        if(!boot)return;notice('');navigation();
        content.classList.toggle('settings-page',state.view==='settings');
        content.classList.toggle('setup-page',state.view==='setup');
        if(state.view==='settings')settings();else if(state.view==='help'){content.innerHTML='<h1>'+t('Where to find tools')+'</h1>'+tourHtml();bindTour();}else setup();
        content.scrollTop=0;persist();lockDownloadNavigation();
    }
    window.addEventListener('message',event=>{
        const message=event.data;
        if(message.type==='vanessaDownloadProgress'){
            if(message.id!==vanessaDownloadRequest||!waiting.has(message.id)||message.folder!==state.folder)return;
            vanessaDownloadProgress=message;renderVanessaDownloadProgress();
        }else if(message.type==='setupProgress'){
            if(message.id!==setupRequest||!waiting.has(message.id))return;
            const counts=Number.isInteger(message.completed)&&Number.isInteger(message.total)&&message.total>0;
            notice(message.label+(counts?' · '+message.completed+' / '+message.total:''));
        }else if(message.type==='response'){
            const pending=waiting.get(message.id);if(!pending)return;waiting.delete(message.id);
            if(message.error){const error=new Error(message.error);error.applied=message.applied;pending.reject(error);}else pending.resolve(message.data);
        }else if(message.type==='boot'){
            boot=message;state.folder=boot.folders.some(folder=>folder.id===state.folder)?state.folder:boot.folder;state.scope=state.folder?state.scope:'user';
            state.view=boot.view;state.setupOpen=boot.view==='setup';
            if(boot.progress?.draft){state.setup=boot.progress.draft;state.step=boot.progress.complete?0:boot.progress.step;state.readiness=boot.progress.readiness;}
            for(const change of boot.drafts||[])drafts.set(draftId(change.folder,change.scope,change.key),change);
            render();
        }else if(message.type==='catalogProgress'){
            boot.catalogSettings||={};boot.catalogSettings[message.folder]=message.catalog;renderCatalogProgress();
        }else if(message.type==='configurationChanged'){
            boot.catalogSettings=message.catalogSettings||boot.catalogSettings;
            renderCatalogProgress();
            if(state.view==='settings')void task('Reading changed settings…',async()=>{await loadRows();notice(drafts.size?t('External settings changed. Review marked drafts before applying.'):'');});
        }
    });
    void rpc('ready');
})();
