/* Design prototype only. Does not call VS Code APIs, launch 1C or write files. */
(() => {
    'use strict';
    const model = window.KOT_SETTINGS_MODEL;
    const content = document.getElementById('content');
    const sectionNav = document.getElementById('section-navigation');
    const routes = {
        new: ['Начинаю с нуля', 'Создать проект или сначала познакомиться с учебными примерами.'],
        sppr: ['У меня проект СППР', 'Подключить сценарии, процессы и существующие настройки запуска.'],
        vanessa: ['У меня проект Vanessa', 'Продолжить работу с feature-файлами и библиотеками без СППР.'],
        legacy: ['Перехожу со старого KOT', 'Проверить настройки и посмотреть план переноса метаданных.']
    };
    const tours = [
        ['Менеджер тестов KOT', 'Слева в KOT', 'Здесь выбирают сценарии для компиляции, запускают тесты и смотрят результаты. В проекте Vanessa отдельная секция показывает самостоятельные feature-файлы.'],
        ['Библиотека', 'Отдельный значок слева', 'Здесь ищут шаги и повторно используемые сценарии, смотрят описание и вставляют вызовы в редактор.'],
        ['Свойства теста', 'Справа от редактора', 'Откройте сценарий: его имя, параметры, настройки запуска и вложения доступны справа. В шапке — сохранить, запустить и добавить в избранное.'],
        ['Информационные базы', 'В боковой панели KOT', 'Здесь находятся ваши базы, выбор платформы и клиенты тестирования. Раскройте базу, чтобы увидеть клиентов.'],
        ['Vanessa и переменные', 'Внизу и справа', 'Состояние соединения — в нижней строке. Значения переменных выполняемого сценария — в правой панели. F11 выполняет шаг под курсором.']
    ];
    const state = { view:'setup', step:0, route:'new', projectMode:'vanessa', folder:'C:/KOT/Workshop', language:'en', format:'native', libraries:'libraries', vanessaPath:'', compilerPath:'', platformPath:'', run:false, scanned:false, tour:0, section:'editor', scope:'folder', query:'' };
    const drafts = new Map();
    const applied = new Map();
    const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    const $ = id => document.getElementById(id);
    function notice(text) { $('notice').textContent=text; }
    function explain(title,text) { $('explanation-title').textContent=title; $('explanation-text').textContent=text; $('explanation').showModal(); }
    function home() { state.view='setup';state.step=0;render();notice('Вы вернулись в начало. Заполненные поля и черновик настроек сохранены.'); }
    $('home').onclick=home;
    $('close-explanation').onclick=()=>$('explanation').close();
    $('nav-setup').onclick=()=>{state.view='setup';render();};
    $('nav-settings').onclick=()=>{state.view='settings';render();};
    $('nav-help').onclick=()=>{state.view='help';render();};
    function navigation() {
        ['setup','settings','help'].forEach(view=>$('nav-'+view).classList.toggle('selected',view===state.view));
        sectionNav.innerHTML=state.view==='settings'?model.sections.map(section=>`<button class="section-button ${section.id===state.section?'selected':''}" data-section="${section.id}">${escape(section.title)}</button>`).join(''):'';
        sectionNav.querySelectorAll('[data-section]').forEach(button=>button.onclick=()=>{state.section=button.dataset.section;state.query='';render();});
        const selector=$('section-select');selector.hidden=state.view!=='settings';
        selector.innerHTML=model.sections.map(section=>'<option value="'+section.id+'">'+escape(section.title)+'</option>').join('');selector.value=state.section;
        selector.onchange=()=>{state.section=selector.value;state.query='';render();};
    }
    function footer(next='Продолжить') {
        return `<div class="actions"><button id="back">Назад</button><span class="spacer"></span><button class="primary" id="next">${next}</button></div>`;
    }
    function bindFooter() {
        if($('back'))$('back').onclick=()=>{state.step--;render();};
        if($('next'))$('next').onclick=()=>{state.step++;render();};
    }
    function pathControl(id,value,kind='directory',policy='relative',label='Путь') {
        return '<div class="path-control"><input id="'+id+'" aria-label="'+escape(label)+'" value="'+escape(value)+'"><button type="button" data-path-target="'+id+'" data-path-kind="'+kind+'" data-path-policy="'+policy+'" aria-label="Выбрать: '+escape(label)+'">Обзор…</button></div>';
    }
    function pathField(id,label,value,kind,policy,hint='') {
        return '<div class="field"><label for="'+id+'">'+escape(label)+'</label>'+pathControl(id,value,kind,policy,label)+(hint?'<small>'+escape(hint)+'</small>':'')+'</div>';
    }
    let pickerRequest;
    function openPathPicker(options,onChoose) {
        pickerRequest={...options,onChoose};
        $('picker-title').textContent=options.kind==='directory'?'Выберите папку':'Выберите файл';
        $('picker-location').value=options.policy==='absolute'||options.policy==='root'?'computer':'project';
        $('picker-location').querySelector('[value="project"]').disabled=options.policy==='root';
        $('picker-location').querySelector('[value="computer"]').disabled=options.policy==='project';
        renderPickerOptions();$('path-picker').showModal();
    }
    function renderPickerOptions() {
        const {kind,policy}=pickerRequest;
        const project=$('picker-location').value==='project';
        const samples=kind==='directory'?(project?['libraries','tests','.vscode/kot-runtime','templates']:['C:/KOT/Workshop','C:/1C/tmplts','C:/Tools/1C']):kind==='epf'?(project?(policy==='project'?['build/BuildScenarioBDD.epf']:['tools/vanessa/vanessa-automation.epf']):['C:/Tools/Vanessa/vanessa-automation.epf']):kind==='exe'?(project?['tools/1cv8c.exe']:['C:/Program Files/1cv8/8.3.27.1859/bin/1cv8c.exe','C:/Program Files (x86)/1cv8fv/bin/1cv8fv.exe']):kind==='json'?(project?['.vscode/kot-runtime/form-explorer/form-snapshot.json']:['C:/KOT/form-snapshot.json']):(project?['templates/scenario.feature','tests/vanessa/01-first-steps.feature']:['C:/KOT/Templates/scenario.feature']);
        $('picker-options').innerHTML=samples.map((value,i)=>'<label class="picker-option"><input type="radio" name="picker-path" value="'+escape(value)+'" '+(!i?'checked':'')+'><code>'+escape(value)+'</code></label>').join('');
        $('picker-hint').textContent=policy==='root'?'Папка проекта задаёт начало отсчёта, поэтому её путь сохраняется полностью.':policy==='project'?'Этот параметр принимает путь внутри проекта. Сохраните выгруженную обработку в папку build проекта.':project&&policy!=='absolute'?'Будет сохранён путь относительно папки проекта.':'Будет сохранён полный путь: для файла вне проекта или настройки этого компьютера.';
    }
    $('picker-location').onchange=renderPickerOptions;
    $('picker-cancel').onclick=()=>$('path-picker').close();
    $('picker-choose').onclick=()=>{
        const selected=$('picker-options').querySelector(':checked').value;
        const relative=$('picker-location').value==='project';
        const root=/^(?:[a-z]:[\\/]|\/)/iu.test(state.folder)?state.folder.replace(/\\/gu,'/').replace(/\/$/u,''):'C:/KOT/Workshop';
        const value=relative&&pickerRequest.policy==='absolute'?root+'/'+selected:selected;
        const onChoose=pickerRequest.onChoose;$('path-picker').close();onChoose(value);
    };
    $('path-picker').onclose=()=>{pickerRequest=undefined;};
    function bindPathPickers() {
        content.querySelectorAll('[data-path-target]').forEach(button=>button.onclick=()=>openPathPicker({kind:button.dataset.pathKind,policy:button.dataset.pathPolicy},value=>{
            const input=$(button.dataset.pathTarget);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
        }));
    }
    function chooseRoute(route) {state.route=route;state.projectMode=route==='sppr'||route==='legacy'?'sppr':'vanessa';state.step=1;state.scanned=false;render();}
    function setup() {
        const prefix=state.step?`<div class="eyebrow">${escape(routes[state.route][0])} · Шаг ${state.step} из 5</div>`:'<div class="eyebrow">Первые шаги</div>';
        if(state.step===0) {
            content.innerHTML=prefix+'<h1>С чего начнём?</h1><p class="lead">Подключим только то, что нужно вашему проекту. Начать писать сценарии можно без установленной 1С.</p><div class="route-list">'+Object.entries(routes).map(([id,[title,description]])=>`<button class="route" data-route="${id}"><span class="arrow">→</span><span><strong>${title}</strong><small>${description}</small></span></button>`).join('')+'</div><p style="margin-top:20px"><button class="text-button" id="demo">Сначала посмотреть учебную мастерскую</button></p>';
            content.querySelectorAll('[data-route]').forEach(button=>button.onclick=()=>chooseRoute(button.dataset.route));
            $('demo').onclick=()=>explain('Учебная мастерская','В готовом расширении эта кнопка предложит создать копию examples/kot-workshop в выбранной папке и открыть руководство. Исходный комплект останется нетронутым. В репозитории мастерская уже доступна.');
        } else if(state.step===1) {
            content.innerHTML=prefix+'<h1>Проверим проект</h1><p class="lead">Укажите папку проекта. На этом шаге мы только читаем файлы.</p>'+pathField('folder','Папка проекта',state.folder,'directory','root','Пути внутри этой папки будем сохранять относительно проекта.')+(state.route==='new'?'<fieldset><legend>Как хотите писать тесты?</legend><label class="inline-choice"><input type="radio" name="project-mode" value="vanessa" '+(state.projectMode==='vanessa'?'checked':'')+'> Feature-файлы Vanessa — без компиляции СППР</label><label class="inline-choice"><input type="radio" name="project-mode" value="sppr" '+(state.projectMode==='sppr'?'checked':'')+'> Сценарии и процессы СППР</label></fieldset>':'')+'<button id="scan">Показать пример проверки</button><div id="scan-result"></div>'+footer();
            $('folder').oninput=event=>{state.folder=event.target.value;};
            content.querySelectorAll('[name=project-mode]').forEach(input=>input.onchange=()=>{state.projectMode=input.value;});
            $('scan').onclick=()=>{state.scanned=true;scanResult();};
            if(state.scanned)scanResult();
            bindFooter();
        } else if(state.step===2) {
            const sppr=state.projectMode==='sppr';
            content.innerHTML=prefix+'<h1>Подготовим редактор</h1><p class="lead">Эти параметры относятся к новым сценариям. Уже написанные тесты останутся в своём формате.</p><label class="field"><span>Язык новых сценариев</span><select id="language"><option value="en">English — Given / When / Then</option><option value="ru">Русский — Допустим / Когда / Тогда</option></select></label>'+(sppr?'<label class="field"><span>Формат новых сценариев СППР</span><select id="format" aria-label="Формат новых сценариев СППР"><option value="native">Текст feature + метаданные YAML</option><option value="legacy">Сценарий в одном YAML</option></select><small>Это предпочтение для создания, а не команда преобразования проекта.</small></label>':'<div class="subtle-box">Для обычных feature-файлов не нужны метаданные и компилятор СППР.</div>')+pathField('libraries','Где лежат библиотеки проекта',state.libraries,'directory','relative','Экспортные сценарии и обработки с пользовательскими шагами. Папки внутри проекта сохраняются относительным путём.')+footer();
            $('language').value=state.language;$('language').onchange=event=>{state.language=event.target.value;};
            if($('format')){$('format').value=state.format;$('format').onchange=event=>{state.format=event.target.value;};}
            $('libraries').value=state.libraries;$('libraries').oninput=event=>{state.libraries=event.target.value;};
            bindFooter();
        } else if(state.step===3) {
            content.innerHTML=prefix+'<h1>Подключим выполнение?</h1><p class="lead">Для написания тестов достаточно редактора. Чтобы запускать их и исследовать формы 1С, подключите выполнение.</p><div id="execution-choice" class="execution-choice" '+(state.run?'hidden':'')+'><button id="connect-now" class="primary">Подключить 1С и Vanessa</button><button id="editor-only">Пока только редактор</button></div><div id="tools"></div><div class="actions"><button id="back">Назад</button><span class="spacer"></span><button id="next" class="primary" '+(!state.run?'hidden':'')+'>Продолжить</button></div>';
            $('connect-now').onclick=()=>{state.run=true;render();};
            $('editor-only').onclick=()=>{state.run=false;state.step=4;render();};
            renderTools();bindFooter();
        } else if(state.step===4) {
            content.innerHTML=prefix+'<h1>Где что находится</h1><p class="lead">Пять мест, которые пригодятся каждый день. Выберите раздел, чтобы узнать, что в нём делать.</p>'+tourHtml()+footer('Проверить изменения');bindTour();bindFooter();
        } else if(state.step===5) {
            const migration=state.route==='legacy';
            content.innerHTML=prefix+'<h1>Проверим изменения</h1><p class="lead">'+escape(state.folder)+'. '+(state.run?'Подготовка выполнения начнётся после применения плана.':'Начинаем с редактора; выполнение можно подключить позже.')+'</p><div class="table-wrap"><table><thead><tr><th>Что изменится</th><th>Где</th></tr></thead><tbody><tr><td>Язык новых сценариев: '+escape(state.language)+'</td><td>Выбранная папка</td></tr>'+(state.projectMode==='sppr'?'<tr><td>Формат новых сценариев: '+(state.format==='native'?'feature + meta':'один YAML')+'</td><td>Выбранная папка</td></tr>':'')+(state.route==='new'?'<tr><td>Структура нового учебного проекта</td><td>Новая папка, существующие файлы не заменяются</td></tr>':'<tr><td>Корни исходников и библиотек</td><td>Профиль проекта</td></tr>')+(migration?'<tr><td>Перенос поддерживаемых групп и метаданных</td><td>Отдельный план; неоднозначные записи сохраняются</td></tr>':'')+(state.run?'<tr><td>Пути к 1С и Vanessa</td><td>Этот компьютер</td></tr><tr><td>Подготовка служебной базы</td><td>После применения, с ходом выполнения</td></tr>':'')+'</tbody></table></div><p class="muted">'+(migration?'Преобразование YAML в feature + meta не входит в перенос метаданных.':'Имена и UID существующих сценариев сохраняются.')+'</p>'+footer(state.run?'Применить и подготовить выполнение':'Применить и начать');
            bindFooter();$('next').onclick=()=>{state.step=6;render();};
        } else {
            const firstLabel=state.projectMode==='sppr'?'Открыть пример сценария СППР':'Открыть пример feature Vanessa';
            content.innerHTML='<div class="eyebrow">Завершение маршрута</div><h1>Можно начинать</h1><p class="lead">В макете пройден маршрут «'+escape(routes[state.route][0])+'». Реальные файлы и настройки не изменялись.</p><p>Для существующего проекта здесь откроется найденный сценарий. Ниже можно посмотреть учебный пример для выбранного подхода.</p><div class="execution-choice"><button id="first" class="primary">'+firstLabel+'</button><button id="to-settings">Открыть настройки</button></div><div id="example"></div>';
            $('first').onclick=showFirstExample;
            $('to-settings').onclick=()=>{state.view='settings';render();};
        }
    }
    function showFirstExample() {
        const sppr=state.projectMode==='sppr';
        const native=state.format==='native';
        const ru=state.language==='ru';
        const call=ru?'И я подготавливаю учебного покупателя':'And I prepare workshop customer';
        const feature=sppr?'#language: '+state.language+'\n'+call+'\n    Customer = "[Customer]"':ru?'#language: ru\nФункциональность: Первая переменная\n\nСценарий: Запомнить покупателя\n    И я запоминаю "Учебный покупатель" в переменную "Customer"':'#language: en\nFeature: First variable\n\nScenario: Remember a customer\n    And I save "Workshop customer" in "Customer" variable';
        const meta='ТипФайла: "Сценарий"\nДанныеСценария:\n    Имя: "Подготовить заявку"\n    Код: "900001002"\nПараметрыСценария:\n    - ПараметрыСценария1:\n        Имя: "Customer"\n        Значение: "Учебный покупатель"\n        ТипПараметра: "Строка"\n        ИсходящийПараметр: "Нет"';
        const panel=(name,text)=>'<h3>'+name+'</h3><pre>'+escape(text)+'</pre>';
        $('example').innerHTML='<h2>'+ (sppr?'Сценарий СППР: параметр и вложенный вызов':'Vanessa: feature без компиляции СППР')+'</h2>'+(sppr?(native?panel('scen.feature — редактируйте шаги здесь',feature)+panel('meta.yaml — сокращённый пример свойств',meta):panel('scen.yaml — свойства и текст вместе',meta+'\nТекстСценария: |\n'+feature.split('\n').map(line=>'    '+line).join('\n'))):panel('first.feature',feature))+(sppr?'<ol><li>Параметр <code>[Customer]</code> задаётся в свойствах и передаётся вложенному сценарию.</li><li>F12 на вызове откроет вложенный сценарий. В Библиотеке можно найти и вставить другой вызов.</li><li>Менеджер тестов компилирует главный сценарий в готовую feature; её выполняет Vanessa.</li></ol><p class="muted">Это поясняющий фрагмент. Полные UID, связи и настройки запуска уже заполнены в учебной мастерской.</p>':'<ol><li>Откройте свойства справа: здесь заголовок, теги и параметры запуска JSON.</li><li>В Библиотеке найдите шаг и вставьте его в сценарий.</li><li>Когда подключите Vanessa, F11 выполнит шаг под курсором. Значение Customer появится в панели переменных.</li></ol>')+'<p>Полные примеры с пояснениями: <code>examples/kot-workshop/README.md</code>. В макете файл не создаётся.</p>';
    }
    function scanResult() {
        const entries=state.route==='new'?['Можно создать проект в новой папке','Существующие файлы не будут заменены']:state.route==='vanessa'?['Функциональности: tests/vanessa','Экспортные сценарии: libraries','Параметры запуска: JSON рядом с feature']:['Сценарии и процессы: tests/sppr','Найдены YAML и пары feature + meta','Связанные настройки запуска: папки test'];
        if(state.route==='legacy')entries.push('Поддерживаемые старые метаданные: доступен план переноса');
        $('scan-result').innerHTML='<h2>Пример результата обнаружения</h2><ul class="result-list">'+entries.map(text=>'<li><span class="status">✓</span>'+escape(text)+'</li>').join('')+'</ul><p class="muted">Учебные данные макета. Настоящий поиск появится при подключении к расширению.</p>';
    }
    function renderTools() {
        if(!state.run){$('tools').innerHTML='';return;}
        $('tools').innerHTML=pathField('platform','Платформа 1С',state.platformPath,'exe','absolute','В расширении сначала предложим найденные платформы. Локальное управление 1С в текущем KOT — на Windows.')+pathField('vanessa-path','Обработка Vanessa Automation',state.vanessaPath,'epf','relative','Выберите vanessa-automation.epf из распакованной поставки. Версию библиотеки шагов KOT определит по docs/Changelog.md рядом с обработкой; без этого файла её можно указать вручную в настройках.')+(state.projectMode==='sppr'?pathField('compiler-path','Компилятор СППР',state.compilerPath,'epf','project','В Конфигураторе СППР сохраните обработку СборкаТекстовСценариев в отдельный файл .epf и положите его, например, в build проекта. Здесь нужен этот файл обработки.'):'')+'<button id="check-tools">Проверить окружение</button><div class="subtle-box">Проверка не создаёт базу и не запускает сценарий. Подготовка служебной базы входит в итоговый план.</div><button class="text-button" id="postpone">Отложить подключение и продолжить</button>';
        $('check-tools').onclick=()=>notice('В макете проверки не выполняются. В расширении здесь появятся ход поиска, результат каждого пункта и отмена.');
        $('postpone').onclick=()=>{state.run=false;state.step=4;render();};
        for(const [id,key]of [['platform','platformPath'],['vanessa-path','vanessaPath'],['compiler-path','compilerPath']])if($(id))$(id).oninput=event=>{state[key]=event.target.value;};
    }
    function tourHtml() {return '<div class="tour"><div class="tour-map">'+tours.map(([name,where],i)=>'<button data-tour="'+i+'" class="'+(state.tour===i?'selected':'')+'">'+escape(name)+'<br><small>'+escape(where)+'</small></button>').join('')+'</div><div class="tour-detail"><h2 style="margin-top:0">'+escape(tours[state.tour][0])+'</h2><p>'+escape(tours[state.tour][2])+'</p><button id="show-panel">Показать в интерфейсе</button></div></div>';}
    function bindTour() {content.querySelectorAll('[data-tour]').forEach(button=>button.onclick=()=>{state.tour=Number(button.dataset.tour);render();});$('show-panel').onclick=()=>explain(tours[state.tour][0],'В рабочем расширении откроется эта панель VS Code. Мастер сохранит текущий шаг. В макете показано её назначение и расположение.');}
    function settingValue(item) {const key=state.scope+':'+item.key;const draft=drafts.get(key);return draft?(draft.reset?item.default:draft.value):(applied.has(key)?applied.get(key):item.default);}
    function choiceChips(item,value) {
        return value.length?value.map(code=>'<span class="choice-chip">'+escape(item.choiceLabels[item.itemEnum.indexOf(code)]||code)+'</span>').join(''):'<span class="muted">Все проверки включены</span>';
    }
    function fieldHtml(item) {
        const value=settingValue(item),id='field-'+item.key.replace(/\./gu,'-');
        let control;
        if(item.editor==='manager'||item.editor==='action')control='<button id="'+id+'" data-manager="'+escape(item.label)+'" aria-label="Открыть: '+escape(item.label)+'">Открыть '+(item.editor==='manager'?'менеджер':'параметры')+'…</button><small class="muted"> Сохранение — в отдельном менеджере.</small>';
        else if(item.inheritsFrom){const key=state.scope+':'+item.key;const draft=drafts.get(key);const explicit=draft?!draft.reset:applied.has(key);control='<select id="'+id+'" data-key="'+item.key+'" data-inheritance="true"><option value="inherit" '+(!explicit?'selected':'')+'>По общей настройке кнопок</option><option value="true" '+(explicit&&value===true?'selected':'')+'>Показывать</option><option value="false" '+(explicit&&value===false?'selected':'')+'>Скрывать</option></select>';}
        else if(item.editor==='choices')control='<details class="multi-select"><summary id="'+id+'">Выбрать проверки · <span class="choice-count">'+value.length+'</span> отключено</summary><div class="choice-options">'+item.itemEnum.map((code,i)=>'<label><input type="checkbox" data-choice="'+item.key+'" value="'+escape(code)+'" '+(value.includes(code)?'checked':'')+'>'+escape(item.choiceLabels[i])+'</label>').join('')+'</div></details><div class="selected-checks">'+choiceChips(item,value)+'</div>';
        else if(item.pathKind==='directories')control='<div class="directory-list">'+value.map((directory,i)=>'<div><code>'+escape(directory)+'</code><button data-remove-directory="'+item.key+'" data-index="'+i+'" aria-label="Удалить папку: '+escape(directory)+'">×</button></div>').join('')+'</div><button id="'+id+'" data-add-directory="'+item.key+'">Добавить папку…</button>';
        else if(item.pathKind)control=pathControl(id,value,item.pathKind,state.scope==='user'&&item.pathPolicy!=='project'?'absolute':item.pathPolicy,item.label).replace('<input ','<input data-key="'+item.key+'" ');
        else if(item.enum)control='<select id="'+id+'" data-key="'+item.key+'">'+item.enum.map((option,index)=>'<option '+(option===value?'selected':'')+' value="'+escape(option)+'">'+escape(item.optionLabels?.[index]||option)+'</option>').join('')+'</select>';
        else if(item.type==='boolean'&&item.default===null||Array.isArray(item.type)&&item.type.includes('boolean'))control='<select id="'+id+'" data-key="'+item.key+'" data-boolean="true"><option value="null" '+(value===null?'selected':'')+'>По общей настройке</option><option value="true" '+(value===true?'selected':'')+'>Показывать</option><option value="false" '+(value===false?'selected':'')+'>Скрывать</option></select>';
        else if(item.type==='boolean')control='<label class="inline-choice"><input id="'+id+'" type="checkbox" data-key="'+item.key+'" '+(value?'checked':'')+'> Включено</label>';
        else if(item.type==='array'||item.type==='object')control='<textarea id="'+id+'" data-key="'+item.key+'" data-json="true">'+escape(JSON.stringify(value,null,2))+'</textarea>';
        else control='<input id="'+id+'" data-key="'+item.key+'" placeholder="'+escape(item.placeholder||'')+'" type="'+(item.editor==='password'?'password':item.type==='number'?'number':'text')+'" value="'+escape(value)+'" '+(item.editor==='password'&&state.scope!=='user'?'disabled':'')+'>';
        const reset=item.editor==='manager'||item.editor==='action'?'':'<button class="text-button reset" data-reset="'+item.key+'">Сбросить в выбранной области</button>';
        const info='<span class="setting-info"><button class="info-button" aria-label="Подробности: '+escape(item.label)+'" aria-expanded="false" aria-controls="'+id+'-info" aria-describedby="'+id+'-info">i</button><span class="info-popup" id="'+id+'-info" role="tooltip"><strong>Техническое имя</strong><code>'+escape(item.key)+'</code><span class="technical">'+escape(item.description)+'</span><span class="technical">По умолчанию: <code>'+escape(JSON.stringify(item.default))+'</code></span></span></span>';
        return '<div class="setting" data-setting="'+item.key+'"><div class="setting-heading"><label for="'+id+'">'+escape(item.label)+'</label>'+info+'</div><div class="description">'+escape(item.hint||item.description.split('\n')[0]).replace(/\*\*/gu,'')+'</div><div class="control">'+control+'</div><div class="source">Источник в макете: '+(applied.has(state.scope+':'+item.key)?'сохранённое учебное значение':'значение по умолчанию')+reset+'</div></div>';
    }
    function settings() {
        const section=model.sections.find(item=>item.id===state.section);
        content.innerHTML='<div class="eyebrow">Настройки KOT · все '+model.settings.length+' параметра учтены</div><h1>'+escape(section.title)+'</h1><p class="lead">'+escape(section.description)+'. Значения хранятся в настройках VS Code.</p><div class="page-actions"><button id="native-settings">Открыть настройки VS Code</button></div><div class="settings-bar"><input id="search" aria-label="Поиск настроек" placeholder="Найти настройку по смыслу или имени" value="'+escape(state.query)+'"><select id="scope" aria-label="Область изменения"><option value="user">Этот компьютер</option><option value="workspace">Рабочая область</option><option value="folder">Выбранная папка</option></select></div><p id="result-count" class="muted"></p><div id="setting-fields"></div><div class="save-bar"><span id="pending-count"></span><button id="discard">Отменить изменения</button><button id="apply" class="primary">Применить</button></div>';
        $('native-settings').onclick=()=>notice('В расширении откроются нативные настройки VS Code с фильтром KOT. Это макет; здесь настройки не меняются.');
        $('scope').value=state.scope;$('scope').onchange=event=>{state.scope=event.target.value;renderSettingFields();};
        $('search').oninput=event=>{state.query=event.target.value;renderSettingFields();};
        $('discard').onclick=()=>{drafts.clear();renderSettingFields();notice('Изменения черновика страницы отменены. Данные внешних менеджеров это действие не меняет.');};
        $('apply').onclick=()=>{for(const [key,draft]of drafts){if(draft.reset)applied.delete(key);else applied.set(key,draft.value);}drafts.clear();renderSettingFields();notice('Учебные значения применены только в макете. Настройки VS Code не изменились.');};
        renderSettingFields();
    }
    function renderSettingFields() {
        const query=state.query.toLocaleLowerCase();
        const items=model.settings.filter(item=>query?[item.label,item.description,item.key].some(text=>text.toLocaleLowerCase().includes(query)):item.section===state.section);
        const usual=items.filter(item=>!item.advanced&&!item.compatibility),advanced=items.filter(item=>item.advanced&&!item.compatibility),compatibility=items.filter(item=>item.compatibility);
        $('result-count').textContent=query?'Найдено: '+items.length:'Частые настройки — в начале, остальные доступны ниже.';
        $('setting-fields').innerHTML=usual.map(fieldHtml).join('')+(advanced.length?'<details '+(query?'open':'')+'><summary>Дополнительно · '+advanced.length+'</summary>'+advanced.map(fieldHtml).join('')+'</details>':'')+(compatibility.length?'<details '+(query?'open':'')+'><summary>Совместимость со старыми проектами · '+compatibility.length+'</summary><p class="muted">Оставлены для существующих проектов. При новой настройке обычно не нужны.</p>'+compatibility.map(fieldHtml).join('')+'</details>':'');
        content.querySelectorAll('[data-key]').forEach(input=>input.onchange=()=>{
            let value=input.type==='checkbox'?input.checked:input.value;
            if(input.dataset.inheritance&&value==='inherit'){drafts.set(state.scope+':'+input.dataset.key,{reset:true});updatePending();return;}
            try {if(input.dataset.json||input.dataset.boolean||input.dataset.inheritance)value=JSON.parse(value);else if(input.type==='number'){value=Number(value);if(!Number.isFinite(value))throw new Error();}}
            catch{input.setAttribute('aria-invalid','true');notice('Проверьте формат значения перед применением.');updatePending();return;}
            input.removeAttribute('aria-invalid');drafts.set(state.scope+':'+input.dataset.key,{value});updatePending();
        });
        content.querySelectorAll('[data-reset]').forEach(button=>button.onclick=()=>{drafts.set(state.scope+':'+button.dataset.reset,{reset:true});renderSettingFields();});
        content.querySelectorAll('[data-manager]').forEach(button=>button.onclick=()=>explain(button.dataset.manager,'В расширении откроется существующий менеджер. Он сохраняет данные отдельно от черновика этой страницы. Отмена на странице настроек не отменяет его сохранения.'));
        content.querySelectorAll('[data-choice]').forEach(input=>input.onchange=()=>{
            const item=model.settings.find(item=>item.key===input.dataset.choice);
            const area=input.closest('.setting');
            const value=[...area.querySelectorAll('[data-choice]:checked')].map(input=>input.value);
            drafts.set(state.scope+':'+item.key,{value});
            area.querySelector('.choice-count').textContent=value.length;
            area.querySelector('.selected-checks').innerHTML=choiceChips(item,value);updatePending();
        });
        content.querySelectorAll('[data-add-directory]').forEach(button=>button.onclick=()=>{
            const item=model.settings.find(item=>item.key===button.dataset.addDirectory);
            openPathPicker({kind:'directory',policy:state.scope==='user'?'absolute':item.pathPolicy},directory=>{
                drafts.set(state.scope+':'+item.key,{value:[...new Set([...settingValue(item),directory])]});renderSettingFields();
            });
        });
        content.querySelectorAll('[data-remove-directory]').forEach(button=>button.onclick=()=>{
            const item=model.settings.find(item=>item.key===button.dataset.removeDirectory);
            drafts.set(state.scope+':'+item.key,{value:settingValue(item).filter((_,i)=>i!==Number(button.dataset.index))});renderSettingFields();
        });
        bindPathPickers();bindInfoPopups();updatePending();
    }
    function bindInfoPopups() {
        content.querySelectorAll('.info-button').forEach(button=>{
            const info=button.parentElement;
            button.onclick=()=>{const pinned=info.classList.toggle('pinned');info.classList.toggle('dismissed',!pinned);button.setAttribute('aria-expanded',String(pinned));};
            info.onpointerenter=()=>info.classList.remove('dismissed');
            button.onfocus=()=>info.classList.remove('dismissed');
        });
    }
    document.addEventListener('keydown',event=>{if(event.key==='Escape')content.querySelectorAll('.setting-info').forEach(info=>{info.classList.remove('pinned');info.classList.add('dismissed');info.querySelector('button').setAttribute('aria-expanded','false');});});
    document.addEventListener('click',event=>content.querySelectorAll('.setting-info.pinned').forEach(info=>{if(!info.contains(event.target)){info.classList.remove('pinned');info.classList.add('dismissed');info.querySelector('button').setAttribute('aria-expanded','false');}}));
    function updatePending() {const invalid=!!content.querySelector('[aria-invalid="true"]');$('pending-count').textContent=invalid?'Исправьте отмеченное значение':drafts.size?'Изменений в черновике: '+drafts.size:'Нет несохранённых изменений';$('apply').disabled=!drafts.size||invalid;$('discard').disabled=!drafts.size&&!invalid;}
    function render() {notice('');navigation();if(state.view==='settings')settings();else if(state.view==='help'){content.innerHTML='<div class="eyebrow">Знакомство с интерфейсом</div><h1>Ваше рабочее место</h1>'+tourHtml();bindTour();}else setup();if(state.view!=='setup'||state.step){content.insertAdjacentHTML('afterbegin','<div class="page-navigation"><button id="back-home" class="text-button">← В начало</button></div>');$('back-home').onclick=home;}bindPathPickers();}
    render();
})();
