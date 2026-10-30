// Generated from Pr-Mex/vanessa-automation: СтруктураОбщихНастроек and ИменаКлючейОбщихНастроек.
// Regenerate with tools/updateVanessaParameterCatalog.cjs; do not edit by hand.
import type { VanessaParameterDefinition } from './vanessaParameterParser';
export const VANESSA_PARAMETER_CATALOG: readonly VanessaParameterDefinition[] = [
  {
    "key": "Version",
    "aliases": [],
    "value": "",
    "valueKind": "string",
    "description": "Version"
  },
  {
    "key": "Lang",
    "aliases": [],
    "value": "",
    "valueKind": "string",
    "description": "Lang"
  },
  {
    "key": "DebugLog",
    "aliases": [],
    "value": "",
    "valueKind": "string",
    "description": "DebugLog"
  },
  {
    "key": "ВерсияVA",
    "aliases": [
      "VersionVA"
    ],
    "value": "",
    "valueKind": "string",
    "description": "VersionVA"
  },
  {
    "key": "КаталогФич",
    "aliases": [
      "featurepath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог фича файлов или имя одного фича файла, которые будут выполняться во время сессии тестирования."
  },
  {
    "key": "ДобавлятьКИмениСценарияУсловияВыгрузки",
    "aliases": [
      "addtofeaturefilter"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Данная опция используется, когда для нескольких похожих сборок (например запуск одних и тех же тестов) формируется один отчет (например Allure). Тогда, чтобы избежать неуникальности имен сценариев к имени сценария будет добавляться значение поля \"Имя текущей сборки\"."
  },
  {
    "key": "ЗаписыватьВидеоВыполненияТестов",
    "aliases": [
      "recordtestrunvideo"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает запись видео во время прохождения тестов. Необходимо включить использование внешней компоненты VanessaExt. Для каждого сценария будет создаваться свой видео файл."
  },
  {
    "key": "КоличествоКадровВидеоВыполненияТестов",
    "aliases": [
      "thenumberofframesofvideotestsession"
    ],
    "value": "5",
    "valueKind": "number",
    "description": "Количество кадров для записи видео."
  },
  {
    "key": "КомандаЗаписиВидеоВыполненияТестов",
    "aliases": [
      "testrecordingvideocommand"
    ],
    "value": "ffmpeg",
    "valueKind": "string",
    "description": "Команда для запуска приложения \"ffmpeg\". Рекомендуется прописать путь к ffmpeg в системной переменной \"path\"."
  },
  {
    "key": "КаталогДляЗаписиВидеоВыполненияТестов",
    "aliases": [
      "directoryforrecordingvideotestexecution"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог для видео файлов."
  },
  {
    "key": "ИмяТекущейСборки",
    "aliases": [
      "NameCurrentBuild"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Уникальное имя сборки, которое используется совместно с параметром \"Добавлять у имени сценария условия выгрузки\"."
  },
  {
    "key": "ЗагрузкаФичПриОткрытии",
    "aliases": [
      "DownloadFeaturesOpen"
    ],
    "value": "Загружать",
    "valueKind": "string",
    "description": "Позволяет управлять поведением Vanessa Automation при открытии: нужно ли загружать фича файл, с которым велась работа в предыдущей, сессии или нет."
  },
  {
    "key": "ГенерироватьУФ",
    "aliases": [
      "GenerateUF"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "GenerateUF"
  },
  {
    "key": "СоздаватьОбластиПриГенерацииКода",
    "aliases": [
      "CreateRegionsOnCodeGeneration"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "CreateRegionsOnCodeGeneration"
  },
  {
    "key": "ВыводитьТекстМодуляВместоПерегенерацииEPF",
    "aliases": [
      "OutputModuleTextInsteadOfRegeneratingEPF"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "OutputModuleTextInsteadOfRegeneratingEPF"
  },
  {
    "key": "ВерсияПлатформыДляГенерацииEPF",
    "aliases": [
      "platformversiongenerateepf"
    ],
    "value": "",
    "valueKind": "string",
    "description": "platformversiongenerateepf"
  },
  {
    "key": "ДополнительныеПараметры",
    "aliases": [
      "dopparams"
    ],
    "value": "",
    "valueKind": "string",
    "description": "dopparams"
  },
  {
    "key": "КомандаОткрытияФичиВТекстовомРедакторе",
    "aliases": [
      "commandtoopenfeatureintexteditor"
    ],
    "value": "",
    "valueKind": "string",
    "description": "В поле указывается текстовый редактор, в котором будет открыт фича файл и спозиционирован на текущей строке, при выполнении команды \"Открыть .feature файл в редакторе\"."
  },
  {
    "key": "ЯзыкГенератораGherkin",
    "aliases": [
      "gherkinlanguage"
    ],
    "value": "ru",
    "valueKind": "string",
    "description": "Поле задаёт язык, на котором будет генерироваться текст сценария при накликивании. Также, если выбран язык отличный от русского, то при выборе шага из базы \"известных шагов\" также появятся дополнительные колонки, которые отображают текст и описание шага на выбранном языке."
  },
  {
    "key": "ПоставщикПользовательскихНастроек",
    "aliases": [
      "usersettingsprovider"
    ],
    "value": "NotUse",
    "valueKind": "string",
    "description": "Поставщик пользовательских настроек"
  },
  {
    "key": "АдресПользовательскихНастроек",
    "aliases": [
      "addressofcustomsettings"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Файловый путь или url по которому находятся настройки. По умолчанию каталог проекта (имя файла по умолчанию user_settings.json) или localhost. В результате чтения файла настроек будут созданы глобальные переменные. При запуске тестов из командной строки для создания переменных нужно передавать их в основном json файле настроек в параметре \"GlobalVars\", который является массивом значений вида Ключ:Значение."
  },
  {
    "key": "ИспользоватьРедакторVanessaEditor",
    "aliases": [
      "usevanessaeditor"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "usevanessaeditor"
  },
  {
    "key": "ТемаРедактораVanessaEditor",
    "aliases": [
      "vanessaeditortheme"
    ],
    "value": "vs",
    "valueKind": "string",
    "description": "Позволяет сменить тему редактора."
  },
  {
    "key": "ИспользоватьДанныеТекущейФормыПриПодбореШагов",
    "aliases": [
      "usecurrentformdatawhenselectingsteps"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает возможность использовать данные текущей формы клиента тестирования, таких как имена полей, заголовков окон и так далее при подборе шагов."
  },
  {
    "key": "ПоказыватьСтрокиПодсценариевVanessaEditor",
    "aliases": [
      "showsubscenariolines"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает отображение строк подсценариев в редакторе."
  },
  {
    "key": "ПоказыватьЗначенияПеременныхВСтрокахРедактора",
    "aliases": [
      "ShowVariableValuesInEditorLines"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Включает отображение в редакторе данных по значениям переменных (inline debug). Значения переменных обновляются после того как строка шага выполнена."
  },
  {
    "key": "ОткрыватьНачальнуюСтраницуПриЗапуске",
    "aliases": [
      "OpenStartPageAtStartup"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Включает отображение начальной страницы в редакторе при запуске Vanessa Automation."
  },
  {
    "key": "ПоказыватьМиниатюруКода",
    "aliases": [
      "showcodeminiature"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Управляет отображением миниатюры кода."
  },
  {
    "key": "ЗаменятьТабыНаПробелы",
    "aliases": [
      "replacetabswithspaces"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Опция определяет надо ли заменять в редакторе символы табуляции на пробелы."
  },
  {
    "key": "ВычислятьВыраженияВФигурныхСкобках",
    "aliases": [
      "EvaluateExpressionsInCurlyBraces"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает режим, когда любое выражение внутри параметров шагов {} будет вычисляться. Если объявлена секция \"Переменные\", то значение настройки игнорируется, вычисление выражений включается во всём файле, сначала будет произведена попытка найти переменную из этой секции по указанному выражению. Иначе будет попытка вычислить выражение в {}. Если используются {выражение}, то выражение будет вычисляться на клиенте. Если используются {!выражение}, то выражение будет вычисляться на сервере."
  },
  {
    "key": "ПриНажатииЭскейпВРедактореЗакрытьФорму",
    "aliases": [
      "OnClickingEscapeInTheEditorCloseTheForm"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если при работе в редакторе была нажата клавиша Esc, то это вызовет событие закрытия формы Vanessa Automation."
  },
  {
    "key": "ВыполнениеСценариев",
    "aliases": [
      "RunningScripts"
    ],
    "value": "{}",
    "valueKind": "object",
    "description": "RunningScripts"
  },
  {
    "key": "ВыполнениеСценариев.ВыполнятьШагиАсинхронно",
    "aliases": [
      "RunningScripts.makestepsasync"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то каждый шаг сценария будет выполняться асинхронно с указанным интервалом. Если флаг снят, то шаги будут выполняться синхронно. Дерево шагов при этом будет обновлять своё состояние каждый сотый шаг. При снятом флаге сценарий будет выполняться в несколько раз быстрее."
  },
  {
    "key": "ВыполнениеСценариев.ИнтервалВыполненияШагаЗаданныйПользователем",
    "aliases": [
      "RunningScripts.SpacingStepSpecifiedUser"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "Задаёт интервал выполнение между шагами сценария при асинхронном режиме выполнения шагов."
  },
  {
    "key": "ВыполнениеСценариев.ОбновлятьСтатистикуВДереве",
    "aliases": [
      "RunningScripts.updatestatistics"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то во время выполнения сценария происходит обновление статистики: сколько шагов сценария прошло, сколько сценариев упало и так далее."
  },
  {
    "key": "ВыполнениеСценариев.ОбновлятьДеревоПриНачалеВыполненияСценария",
    "aliases": [
      "RunningScripts.updatetreewhenscenariostarts"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то при обновлении дерева шагов будет активизироваться текущая строка дерева. Рекомендуется снимать флаг при выполнении сценариев на CI сервере для ускорения выполнения сценариев. Актуально при работе в режиме дерева шагов."
  },
  {
    "key": "ВыполнениеСценариев.ОстановкаПриВозникновенииОшибки",
    "aliases": [
      "RunningScripts.stoponerror"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то сценарии будут выполняться до первой ошибки. Все последующие сценарии выполняться не будут."
  },
  {
    "key": "ВыполнениеСценариев.ПоказыватьНомерСтрокиДереваПриВозникновенииОшибки",
    "aliases": [
      "RunningScripts.showrownumberonerror"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то при возникновении ошибки в дереве шагов будет показана колонка с номером строки в дереве, если эта колонка была скрыта. Актуально при работе в режиме дерева шагов."
  },
  {
    "key": "ВыполнениеСценариев.ПриравниватьPendingКFailed",
    "aliases": [
      "RunningScripts.pendingequalfailed"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то при выполнении сценариев на CI сервере, если будут найдены нереализованные шаги (\"Pending\"/\"Не реализовано\") статус сборки всё равно будет \"Failed\"/\"Ошибка\". Флаг рекомендуется устанавливать."
  },
  {
    "key": "ВыполнениеСценариев.РазличатьBrokenИFailedПоКлючевомуСловуТогда",
    "aliases": [
      "RunningScripts.distinguishbrokenorfailedbythenkeyword"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки статус сценария будет зависеть от того, с какого ключевого слова начинается шаг, на котором возникла ошибка. Если это слово Тогда, то статус сценария будет \"Failed\"/\"Ошибка\". Во всех остальных случаях - \"Broken\"/\"Сломано\". Это помогает различать сломанные тесты от реальных ошибок конфигурации."
  },
  {
    "key": "ВыполнениеСценариев.ЗапрещатьПерезаписыватьПеременные",
    "aliases": [
      "RunningScripts.banoverwritingvariables"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то при попытке записи значения в ранее объявленную переменную во время выполнения шагов будет вызвано исключение, а не произойдёт молчаливая перезапись. Проверка применяется к обеим областям: обычному контексту (например, $Имя$) и сохраняемому контексту ($$Имя$$)."
  },
  {
    "key": "ВыполнениеСценариев.ОбновлятьТаблицыФормыПриПолученииЗначения",
    "aliases": [
      "RunningScripts.updateformtableswhengettingvalue"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при получении таблицы тест будет пытаться найти и нажать на кнопку таблицы \"Обновить\" и нажать её. Попытка обновления будет происходить в том случае, если происходит несколько попыток получения значения таблицы и первая попытка была неуспешной."
  },
  {
    "key": "ВыполнениеСценариев.ПолучатьМакетыСПомощьюРасширенияVAExtension",
    "aliases": [
      "RunningScripts.getlayoutsusingextensionvaextension"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает получение значений макетов (печатных форм и отчетов) с помощью расширения VAExtension. Позволяет получать макет целиком с оформлением в web клиенте."
  },
  {
    "key": "ВыполнениеСценариев.ВыполнятьSleepЧерезPing",
    "aliases": [
      "RunningScripts.dosleepusingping"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, тогда вызов метода Sleep() будет происходить через вызов команды Ping. Это нужно в том случае, если в окне клиента тестирования в данный момент не отвечает на запросы."
  },
  {
    "key": "ВыполнениеСценариев.ТаймаутДляАсинхронныхШагов",
    "aliases": [
      "RunningScripts.timeoutforasynchronoussteps"
    ],
    "value": "10",
    "valueKind": "number",
    "description": "Указывает максимальное время ожидания для асинхронного шага. Например, если задано значение параметра равное 20 секунд и используется шаг ```Gherkin И я жду, что поле с именем \"ИмяПоля\" перестанет быть пустым в течение 10 секунд ``` тогда в реальности максимальное время работы шага будет 20 секунд, а не 10."
  },
  {
    "key": "ВыполнениеСценариев.МаксимальноеВремяВыполненияДействия",
    "aliases": [
      "RunningScripts.MaximumExecutionTimeAction"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "Устанавливает максимальное время выполнения действий, которые возвращают значение в менеджер тестирования. При превышении заданного времени генерируется исключение \"Превышено максимальное время выполнения действия на стороне клиента тестирования\". При этом выполнение действия будет продолжено. Если параметр равен 0, команды ожидают окончания выполнения без проверки времени прошедшего с начала выполнения."
  },
  {
    "key": "ВыполнениеСценариев.КоличествоСекундПоискаОкна",
    "aliases": [
      "RunningScripts.timetofindwindow"
    ],
    "value": "10",
    "valueKind": "number",
    "description": "Максимальное время для поиска окна в шаге ```Gherkin Тогда открылось окно \"ИмяОкна\" ```"
  },
  {
    "key": "ВыполнениеСценариев.КоличествоПопытокВыполненияДействия",
    "aliases": [
      "RunningScripts.numberofattemptstoperformanaction"
    ],
    "value": "3",
    "valueKind": "number",
    "description": "Устанавливает количество попыток выполнения действий для многих шагов. Увеличение значения параметра может повысить стабильность выполнения сценариев на медленном железе."
  },
  {
    "key": "ВыполнениеСценариев.КоличествоПопытокВыполненияСценария",
    "aliases": [
      "RunningScripts.NumberOfAttemptsToExecuteTheScript"
    ],
    "value": "1",
    "valueKind": "number",
    "description": "Если в настройке указано значение более одного, тогда если сценарий не был выполнен успешно, будет выполнено ещё несколько попыток выполнения сценария."
  },
  {
    "key": "ВыполнениеСценариев.БезопасноеВыполнениеШагов",
    "aliases": [
      "RunningScripts.safeexecutionofsteps"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Добавляет паузу при выполнении многих действий, которые потенциально могут приводить к нестабильному выполнению сценариев, например: переход к строке, проверка значения поля и т.д. Данная опция существенно замедляет выполнение сценариев."
  },
  {
    "key": "ВыполнениеСценариев.ПаузаПриОткрытииОкна",
    "aliases": [
      "RunningScripts.pauseonwindowopening"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "Значение дополнительной паузы, которая будет всегда применяться в шагах ```Gherkin Тогда открылось окно \"ИмяОкна\" И я жду открытия окна \"Имя окна\" в течении 60 секунд И я жду открытия окна отличного от \"ИмяОкна\" в течение 60 секунд ```"
  },
  {
    "key": "ВыполнениеСценариев.НомерПервогоСценарияДляЗапуска",
    "aliases": [
      "RunningScripts.NumberFirstScriptForLaunch"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "RunningScripts.NumberFirstScriptForLaunch"
  },
  {
    "key": "КлиентТестирования",
    "aliases": [
      "TestClient"
    ],
    "value": "{}",
    "valueKind": "object",
    "description": "TestClient"
  },
  {
    "key": "КлиентТестирования.ЗапускатьКлиентТестированияСМаксимизированнымОкном",
    "aliases": [
      "TestClient.runtestclientwithmaximizedwindow"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если опция включена клиент тестирования будет запущен развёрнутым на весь экран."
  },
  {
    "key": "КлиентТестирования.ТаймаутЗапуска1С",
    "aliases": [
      "TestClient.testclienttimeout"
    ],
    "value": "25",
    "valueKind": "number",
    "description": "Устанавливает максимальное время в секундах, в течение которого Vanessa Automation будет ждать запуска клиента тестирования. По истечении времени будет вызвано исключение."
  },
  {
    "key": "КлиентТестирования.ДиапазонПортовTestclient",
    "aliases": [
      "TestClient.testclientports"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Устанавливает диапазон портов, в котором будет производиться поиск свободного порта в системе для запуска клиента тестирования. Например 48100-48200."
  },
  {
    "key": "КлиентТестирования.ЗакрыватьКлиентТестированияПринудительно",
    "aliases": [
      "TestClient.forceclosetestclient"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то при закрытии клиента тестирования будет проверяться, закрылся ли клиент тестирования по его PID. Если клиент тестирования не закрылся штатно, то будет выполнена попытка закрыть его с помощью команды ОС."
  },
  {
    "key": "КлиентТестирования.ОпределятьРеальныйПортНаКоторомЗапустилсяКлиентТестирования",
    "aliases": [
      "TestClient.DetermineTheRealPortOnWhichTheTestingClientWasLaunched"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при подключении клиента тестирования будет происходить попытка определить реальный порт, на котором был запущен клиент тестирования. Это нужно. т.к. клиент тестирования может поменять порт, на котором он запустился, несмотря на переданные параметры. Эта проблема актуальна при запуске тестов в Linux."
  },
  {
    "key": "КлиентТестирования.ПутьКadb",
    "aliases": [
      "TestClient.PathToadb"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Путь к файлу программы adb"
  },
  {
    "key": "КлиентТестирования.ПовторноЗапускатьСеансКлиентаТестированияПриПодключенииЕслиНеНайденЕгоПроцесс",
    "aliases": [
      "TestClient.starttestclientsessionagainonconnectionifitsprocessisnotfound"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает повторный запуск процесса клиента тестирования, если предыдущий запуск не сработал (например, если не была получена лицензия). Только для толстого и тонкого клиента."
  },
  {
    "key": "КлиентТестирования.ИнтервалЗапускаПроцессаКлиентаТестирования",
    "aliases": [
      "TestClient.testclientprocessstartinterval"
    ],
    "value": "100",
    "valueKind": "number",
    "description": "Задаёт интервал, с которым будет производиться попытка запустить сеанс клиента тестирования."
  },
  {
    "key": "КлиентТестирования.КаталогФайловВыводаСлужебныхСообщений",
    "aliases": [
      "TestClient.DirectoryFilesOutputServiceMessages"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Если параметр задан, то при запуске клиента тестирования будет добавляться параметр /Out <ИмяФайла>. Имя файла будет генерироваться по правилу ИмяКлиентаТестирования+ДатаВремяЗапуска."
  },
  {
    "key": "КлиентТестирования.ТаймаутПередПринудительнымЗакрытиемКлиентаТестирования",
    "aliases": [
      "TestClient.timeoutbeforeforciblyclosingtestclient"
    ],
    "value": "10",
    "valueKind": "number",
    "description": "Количество секунд, в течение которого будет проверяться, что процесс клиента тестирования завершился самостоятельно."
  },
  {
    "key": "КлиентТестирования.МодальноеОкноПриЗапускеКлиентаТестированияЭтоОшибка",
    "aliases": [
      "TestClient.modalwindowwhenstartingtestclientiserror"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если опция включена, то модальное окно при запуске клиента тестирования означает ошибку подключения клиента тестирования."
  },
  {
    "key": "КлиентТестирования.ОтключитьЗапускРеглЗаданийВФайловойБазе",
    "aliases": [
      "TestClient.DisableScheduledJobsExecutionForFileInfobase"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, при запуске клиента тестирования в файловой базе будет отключен запуск регламентных заданий. Используется ключ командной строки /AllowExecuteScheduledJobs -Off"
  },
  {
    "key": "КлиентТестирования.ДополнительныеПараметрыЗапускаКлиентаТестирования",
    "aliases": [
      "TestClient.AdditionalParametersForLaunchingTheTestingClient"
    ],
    "value": "",
    "valueKind": "string",
    "description": "В поле указываются дополнительные ключи запуска клиента тестирования, которые будут передаваться запускаемому сеансу 1С"
  },
  {
    "key": "КлиентТестирования.ЗапускатьТестКлиентВРежимеОтладки",
    "aliases": [
      "TestClient.testclientdebug"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то при запуске клиента тестирования ему будут переданы дополнительные ключи запуска /debug и /debuggerURL"
  },
  {
    "key": "КлиентТестирования.КлючиОтладки",
    "aliases": [
      "TestClient.testclientdebugkeys"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Ключи отладки, которые будут переданы клиенту тестирования при запуске."
  },
  {
    "key": "КлиентТестирования.АдресОтладчика",
    "aliases": [
      "TestClient.testclientdebugaddress"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Адрес отладчика, который будет передан клиенту тестирования."
  },
  {
    "key": "КлиентТестирования.ЗакрытьTestClientПослеЗапускаСценариев",
    "aliases": [
      "TestClient.closetestclient"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "TestClient.closetestclient"
  },
  {
    "key": "КлиентТестирования.ДанныеКлиентовТестирования",
    "aliases": [
      "TestClient.datatestclients"
    ],
    "value": "[]",
    "valueKind": "array",
    "description": "Список клиентов тестирования, в котором указаны: 1. Имя профиля 2. Синоним 3. Тип клиента тестирования 4. Строка подключения к базе 5. Дополнительные параметры запуска 6. Имя компьютера для установления подключения 7. Порт"
  },
  {
    "key": "ДелатьОтчетВФорматеАллюр",
    "aliases": [
      "allurecreatereport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Формировать отчет в формате Allure по результатам выполнения сценариев."
  },
  {
    "key": "ОбъединятьПримерыСтруктурыСценарияВAllure",
    "aliases": [
      "MergeScenarioOutlineExamplesInAllure"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "MergeScenarioOutlineExamplesInAllure"
  },
  {
    "key": "ОтчетAllure",
    "aliases": [
      "AllureReport"
    ],
    "value": "{}",
    "valueKind": "object",
    "description": "AllureReport"
  },
  {
    "key": "ОтчетAllure.КаталогВыгрузкиAllure",
    "aliases": [
      "AllureReport.allurepath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, в котором формируются данные отчета в формате Allure. При локальном запуске каталог будет очищаться при каждом запуске сценариев."
  },
  {
    "key": "ОтчетAllure.КаталогВыгрузкиAllureБазовый",
    "aliases": [
      "AllureReport.allurepathbase"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, в котором формируются данные отчета в формате Allure, при этом для каждой сборки будет создаваться подкаталоги. Данный параметр имеет приоритет и значение параметра \"Каталог отчета Allure\" будет проигнорировано."
  },
  {
    "key": "ОтчетAllure.УровеньОтчета1",
    "aliases": [
      "AllureReport.reportlevel1"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Задаёт первый уровень группировки в отчете Allure на закладке Behaviors. Подробности описаны в справке."
  },
  {
    "key": "ОтчетAllure.УровеньОтчета2",
    "aliases": [
      "AllureReport.reportlevel2"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Задаёт второй уровень группировки в отчете Allure на закладке Behaviors. Подробности описаны в справке."
  },
  {
    "key": "ОтчетAllure.УровеньОтчета3",
    "aliases": [
      "AllureReport.reportlevel3"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Задаёт третий уровень группировки в отчете Allure на закладке Behaviors. Подробности описаны в справке."
  },
  {
    "key": "ОтчетAllure.ГруппировкаTestSuites",
    "aliases": [
      "AllureReport.testsuites"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Задаёт значение группировки в отчете Allure на закладке Suites. Подробности описаны в справке."
  },
  {
    "key": "ОтчетAllure.ПрикладыватьКОтчетуAllureЖурналРегистрацииВыполненияСценария",
    "aliases": [
      "AllureReport.attacheventlogtotheallurereport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "При возникновении ошибки к сценарию будет приложен журнала регистрации. Данные берутся с момента начала выполнения сценария."
  },
  {
    "key": "ОтчетAllure.ПрикладыватьКОтчетуAllureДанныеОСостоянииАктивнойФормы",
    "aliases": [
      "AllureReport.attachactiveformdatatotheallurereport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки будут собраны данные о состоянии элементов активной формы в формате xlsx."
  },
  {
    "key": "ОтчетAllure.ПрикладыватьКОтчетуAllureДанныеОЗначенияхПеременных",
    "aliases": [
      "AllureReport.attachvariablestotheallurereport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки будут собраны данные со значениями переменных Контекста и Контекста глобального."
  },
  {
    "key": "ОтчетAllure.ПрикладыватьФайлыMxlКОтчетуAllure",
    "aliases": [
      "AllureReport.attachmxlfilestoallurereport"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Файлы отчетов и их эталонов будут прикладываться к отчету Allure в формате mxl."
  },
  {
    "key": "ОтчетAllure.ПрикладыватьФайлыXlsxКОтчетуAllure",
    "aliases": [
      "AllureReport.attachxlsxfilestoallurereport"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Файлы отчетов и их эталонов будут прикладываться к отчету Allure в формате xlsx."
  },
  {
    "key": "ОтчетAllure.ПрикладыватьФайлыMxlСохраненныеВФорматеHTMLКОтчетуAllure",
    "aliases": [
      "AllureReport.attachmxlfilessavedinhtmlformattoallurereport"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Все mxl файлы, которые будут приложены к отчету Allure будут сохраняться в формате HTML. Это упрощает открытие и просмотр результата."
  },
  {
    "key": "ОтчетAllure.ПрикладыватьДополнительныеДанныеПриСравненииЗначенияСЭталономAllure",
    "aliases": [
      "AllureReport.attachadditionaldatawhencomparingvaluewithreferenceallure"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при сравнении макета с эталоном или при сравнении таблицы с эталоном будут формироваться дополнительные файлы: картинка, содержащая разницу между эталоном и текущим значением таблицы или макета картинка текущего значения картинка эталонного значения файл в формате gif, показывающий разницу между текущим и эталонным значением. Также в отчете Allure появится дополнительная секция, где можно будет удобно просмотреть сравнение эталона и текущего значения. Для работы опции необходимо, чтобы на ПК, где запускается Vanessa Automation был установлен пакет ImageMagick7 версии или выше и пакет ghostscript https://www.ghostscript.com/download.html, который выполняет конвертацию pdf файлов в картинки. Также необходимо, чтобы на ПК выполнялись команды вида: magick convert file.pdf file.png Пример результата можно посмотреть тут. https://www.ghostscript.com/download.html https://www.youtube.com/watch?v=1xnp6CxCktA&list=PLalsS95_a3a8iVPCLjFMY2wj4ZMG2XpVH&index=3&ab_channel=VSL"
  },
  {
    "key": "ОтчетAllure.ПодставлятьВОтчетеAllureЗначенияПеременных",
    "aliases": [
      "AllureReport.setvariablevaluesinstepsallurereport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то в параметрах шагов, в которых использовались переменные, имена переменных будут заменены на их значения. Опцию нужно использовать осторожно, т.к. она требует дополнительных ресурсов для анализа, нужно ли подставлять переменные в шаг."
  },
  {
    "key": "ОтчетAllure.СписокИсключаемыхПеременныхAllure",
    "aliases": [
      "AllureReport.allureexcludevars"
    ],
    "value": "[]",
    "valueKind": "array",
    "description": "Имена переменных из списка не будут заменены на их значения"
  },
  {
    "key": "ОтчетAllure.ПрикладыватьКОтчетуAllureДанныеОСостоянииВсехФорм",
    "aliases": [
      "AllureReport.attachallformsdatatotheallurereport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки будут собраны данные о состоянии элементов всех форм открытых в клиенте тестирования в формате xlsx."
  },
  {
    "key": "ОтчетAllure.ПрикладыватьКОтчетуAllureДанныеОСетевыхСоединениях",
    "aliases": [
      "AllureReport.attachnetworkconnectiondatatotheallurereport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки будут собраны данные о сетевых соединениях ПК, на котором запускались тесты."
  },
  {
    "key": "ОтчетAllure.ПрикладыватьКОтчетуAllureДанныеОПроцессахОС",
    "aliases": [
      "AllureReport.attachdataoftheoperatingsystemprocessestotheallurereport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки будут собраны данные о запущенных процессах ОС."
  },
  {
    "key": "ОтчетAllure.ТегиПропускающиеСценарийAllure",
    "aliases": [
      "AllureReport.tagsskippingscript"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Список тегов, разделённых с помощью \";\". Если в сценарии есть такой тег, тогда сценарий не будет выполняться и отчете Allure у него будет статус пропущен/skipped."
  },
  {
    "key": "ОтчетAllure.КаталогОтносительноКоторогоНадоСтроитьИерархию",
    "aliases": [
      "AllureReport.directorytobuildhierarchy"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, относительно которого рассчитывается иерархия фич. Подробности описаны в справке."
  },
  {
    "key": "ОтчетAllure.ДанныеАллюрМеток",
    "aliases": [
      "AllureReport.DataAllureMarks"
    ],
    "value": "[]",
    "valueKind": "array",
    "description": "Таблица используется для установки соответствия тегов сценариев меткам аллюра. Если в строке таблицы указано регулярное выражение, то к каждому тегу сценария применяется регулярное выражение из данной таблицы и если тег ему соответствует, то к отчету будет добавлена метка в формате ИмяМетки:Значение. Если в строке таблицы регулярное выражение не указано, то метка добавляется безусловно. Подробнее зачем это может быть нужно можно прочитать тут https://habr.com/ru/company/sberbank/blog/359302/"
  },
  {
    "key": "ДелатьОтчетВФорматеjUnit",
    "aliases": [
      "junitcreatereport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Формировать отчет в формате JUnit по результатам выполнения сценариев."
  },
  {
    "key": "СкриншотыjUnit",
    "aliases": [
      "junitscreenshots"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "С версии 13.12 в jUnit можно добавлять скриншоты. Чтобы все корректно работало - КаталогСкриншотов должен быть расположен внутри КаталогаПроекта. Папку скриншотов сохранять как артефакты. https://docs.gitlab.com/ee/ci/unit_test_reports.html#viewing-junit-screenshots-on-gitlab"
  },
  {
    "key": "ОтчетJUnit",
    "aliases": [
      "JUnitReport"
    ],
    "value": "{}",
    "valueKind": "object",
    "description": "JUnitReport"
  },
  {
    "key": "ОтчетJUnit.КаталогВыгрузкиJUnit",
    "aliases": [
      "JUnitReport.junitpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог для формирования отчета."
  },
  {
    "key": "ОтчетJUnit.ЗаписыватьСценарииВJunitЧерезTestSuite",
    "aliases": [
      "JUnitReport.WriteScriptsInjUnitViaTestSuite"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "JUnitReport.WriteScriptsInjUnitViaTestSuite"
  },
  {
    "key": "ДелатьОтчетВФорматеCucumberJson",
    "aliases": [
      "cucumbercreatereport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Формировать отчет в формате Cucumber по результатам выполнения сценариев."
  },
  {
    "key": "ОтчетCucumber",
    "aliases": [
      "CucumberReport"
    ],
    "value": "{}",
    "valueKind": "object",
    "description": "CucumberReport"
  },
  {
    "key": "ОтчетCucumber.КаталогВыгрузкиCucumberJson",
    "aliases": [
      "CucumberReport.cucumberreportpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог для формирования отчета."
  },
  {
    "key": "ДелатьОтчетВФорматеСППР",
    "aliases": [
      "ModelingCreateReport"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Формировать отчет в формате СППР по результатам выполнения сценариев."
  },
  {
    "key": "ОтчетСППР",
    "aliases": [
      "ModelingReport"
    ],
    "value": "{}",
    "valueKind": "object",
    "description": "ModelingReport"
  },
  {
    "key": "ОтчетСППР.КаталогВыгрузкиСППР",
    "aliases": [
      "ModelingReport.modelingreportpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог для формирования отчета."
  },
  {
    "key": "ОтчетСППР.ИмяКонфигурацииСППР",
    "aliases": [
      "ModelingReport.ModelingConfigurationName"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Имя конфигурации для отчета"
  },
  {
    "key": "ОтчетСППР.ВерсияКонфигурацииСППР",
    "aliases": [
      "ModelingReport.ModelingConfigurationVersion"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Версия конфигурации для отчета"
  },
  {
    "key": "АвтонумерацияШагов",
    "aliases": [
      "autonumberingofsteps"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Добавляет авто нумерацию в начало текста описания шага. Для того, чтобы лидирующие нули не терялись при экспорте из MD формата, текст записывается в блок кода."
  },
  {
    "key": "ТекстовыеИнструкцииГруппаШаговКакШаг",
    "aliases": [
      "TextStepGroupAsStep"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Включает режим, когда группа шагов в сценарии будет интерпретироваться как один шаг в текстовой инструкции. Если не указано дополнительных тегов, то скриншот будет сниматься после выполнения последнего шага в группе. Чтобы для одной группы шагов сделать несколько скриншотов нужно использовать тег @screenshot перед нужными шагами. Если нужно сделать только один скриншот для группы шагов, то можно указать тег @screenshot только один раз перед нужным шагом."
  },
  {
    "key": "ДобавлятьИмяФичиВТекстовуюИнструкцию",
    "aliases": [
      "AddFeatureNameToTextInstruction"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то в текстовую инструкцию будет добавлена информация с названием фичи."
  },
  {
    "key": "ДобавлятьИмяСценарияВТекстовуюИнструкцию",
    "aliases": [
      "AddScenarioNameToTextInstruction"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то в текстовую инструкцию будет добавлена информация с названием сценария."
  },
  {
    "key": "СоздаватьИнструкциюHTML",
    "aliases": [
      "htmlcreate"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то во время выполнения сценария будет создаваться скринкаст в формате HTML. В поле \"Команда создания скриншотов\" должна быть указана консольная команда для снятия скриншотов. Также в тексте сценария возможно использовать специальные директивы, которые описаны в справке."
  },
  {
    "key": "ИнструкцияHTML",
    "aliases": [],
    "value": "{}",
    "valueKind": "object",
    "description": "ИнструкцияHTML"
  },
  {
    "key": "ИнструкцияHTML.КаталогВыгрузкиИнструкцийHTML",
    "aliases": [
      "ИнструкцияHTML.htmlpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог HTML инструкций"
  },
  {
    "key": "ИнструкцияHTML.СтилиHTMLИнструкции",
    "aliases": [
      "ИнструкцияHTML.htmlstyles"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Файл стилей"
  },
  {
    "key": "ИнструкцияHTML.ВключитьОзвучкуHTML",
    "aliases": [
      "ИнструкцияHTML.EnableHTMLVoiceover"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Используется встроенная в браузеры технология Синтеза речи. Синтез речи (text-to-speech или tts) подразумевает получение синтезированного текста приложения и его речевое воспроизведение. Подробнее Воспроизведение текста начинается при клике на картинку шага. https://developer.mozilla.org/ru/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API#%D1%81%D0%B8%D0%BD%D1%82%D0%B5%D0%B7_%D1%80%D0%B5%D1%87%D0%B8"
  },
  {
    "key": "ИнструкцияHTML.ТемпОзвучкиHTML",
    "aliases": [
      "ИнструкцияHTML.HTMLVoiceOverTempo"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "ИнструкцияHTML.HTMLVoiceOverTempo"
  },
  {
    "key": "ИнструкцияHTML.ДиапазонОзвучкиHTML",
    "aliases": [
      "ИнструкцияHTML.HTMLVoiceoverRange"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "ИнструкцияHTML.HTMLVoiceoverRange"
  },
  {
    "key": "ИнструкцияHTML.ГолосОзвучкиHTML",
    "aliases": [
      "ИнструкцияHTML.HTMLVoiceoverVoice"
    ],
    "value": "5",
    "valueKind": "number",
    "description": "ИнструкцияHTML.HTMLVoiceoverVoice"
  },
  {
    "key": "ИнструкцияHTML.ВариантСтилейHTMLИнструкции",
    "aliases": [
      "ИнструкцияHTML.VariantsHTMLInstructions"
    ],
    "value": "2",
    "valueKind": "number",
    "description": "Вариант 3D Карусель - адаптирован как под ПК так и под мобильные устройства Подробности тут. https://www.youtube.com/watch?v=dMmjG97nJ_w"
  },
  {
    "key": "СоздаватьИнструкциюMarkdown",
    "aliases": [
      "markdowncreate"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то во время выполнения сценария будет создаваться скринкаст в формате MarkDown. В поле \"Команда создания скриншотов\" должна быть указана консольная команда для снятия скриншотов или установлен флаг скриншоты компонентой \"VanessaExt\". Также в тексте сценария возможно использовать специальные директивы, которые описаны в справке."
  },
  {
    "key": "ИнструкцияMarkdown",
    "aliases": [],
    "value": "{}",
    "valueKind": "object",
    "description": "ИнструкцияMarkdown"
  },
  {
    "key": "ИнструкцияMarkdown.КаталогВыгрузкиИнструкцийMarkdown",
    "aliases": [
      "ИнструкцияMarkdown.markdownpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог Markdown инструкций"
  },
  {
    "key": "ДелатьОтчетВоВнутреннемФормате",
    "aliases": [
      "simplereport"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Включает вывод отчет о запуске сценариев во внутреннем формате."
  },
  {
    "key": "КаталогиБиблиотек",
    "aliases": [
      "librarycatalogs"
    ],
    "value": "[]",
    "valueKind": "array",
    "description": "Список каталогов, в которых находятся epf файлы, содержащие шаги для сценариев и feature файлы, содержащие экспортные сценарии."
  },
  {
    "key": "СписокТеговИсключение",
    "aliases": [
      "ignoretags"
    ],
    "value": "[]",
    "valueKind": "array",
    "description": "В поле указываются теги. Если тег будет найден в фиче, то вся фича не будет загружена. Если тег будет найден у сценария, то не будет загружен только этот сценарий."
  },
  {
    "key": "СписокТеговОтбор",
    "aliases": [
      "filtertags"
    ],
    "value": "[]",
    "valueKind": "array",
    "description": "В поле указываются теги. Если тег НЕ будет найден в фиче, то вся фича не будет загружена. Также возможно загрузить из фичи только те сценарии, у которых указаны нужные теги из списка."
  },
  {
    "key": "СписокСценариевДляВыполнения",
    "aliases": [
      "scenariofilter"
    ],
    "value": "[]",
    "valueKind": "array",
    "description": "Позволяет задать фильтр на выполнение сценариев - будут выполняться только сценарии из списка. Сценарии будут выполняться в том порядке как они указаны в фича файле. Сценарий в списке указывается с помощью его имени."
  },
  {
    "key": "СписокФичДляВыполнения",
    "aliases": [
      "FeaturesToRun"
    ],
    "value": "[]",
    "valueKind": "array",
    "description": "Позволяет задать порядок выполнения фича файлов. Также устанавливает отбор - будут запускаться фича файлы только из списка. Можно передавать полный путь к фича файлу (c:\\temp\\my.feature). Можно передавать имя фичи без полного пути (my.feature). Можно передавать имя фичи без полного пути и без расширения файла (my). Настройка применяется, только если происходит загрузка фича файлов из каталога."
  },
  {
    "key": "ДелатьЛогВыполненияСценариевВЖР",
    "aliases": [
      "logtogr"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то в журнал регистрации будут записываться события о начале выполнения сценария и о начале выполнения шагов."
  },
  {
    "key": "ДелатьЛогВыполненияСценариевВТекстовыйФайл",
    "aliases": [
      "logtotext"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает вывод лога выполнения сценариев. В лог записываются события: 1. Начало выполнения сценария 2. Событие возникновения ошибки Вывод лога возможен либо в файл, либо в консоль, либо в файл и консоль одновременно."
  },
  {
    "key": "ВыводитьВЛогВыполнениеШагов",
    "aliases": [
      "logstepstotext"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Выводит в лог событие: начало выполнения шага."
  },
  {
    "key": "ПодробныйЛогВыполненияСценариев",
    "aliases": [
      "fulllog"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Больше деталей в логе 1. Количество тестов всего 2. Сколько упало/успешно/пропущено 3. Прошло/осталось времени"
  },
  {
    "key": "ВыводитьЛогВКонсоль",
    "aliases": [
      "outputloginconsole"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает вывод лога в консоль. Для работы опции необходимо включить использование компоненты VanessaExt."
  },
  {
    "key": "МаскироватьПарольВЛоге",
    "aliases": [
      "maskpwdinlog"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Маскируется пароль пользователя в логе /P\"*****\""
  },
  {
    "key": "РазмерБуфераЛогаВыполненияСценариев",
    "aliases": [
      "textlogbuffersize"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "textlogbuffersize"
  },
  {
    "key": "ЗвуковоеОповещениеПриОкончанииВыполненияСценария",
    "aliases": [
      "soundnotificationwhenscriptends"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если опция включена, то при окончании выполнения сценария будет выдаваться звуковое оповещение: 1. Сценарии выполнены успешно. 2. Ошибка при выполнении сценария. 3. Сработала точка останова. Необходимо включить использование компоненты VanessaExt. Опция работает только под Windows."
  },
  {
    "key": "ПоказыватьОкноОстановкиВыполненияСценария",
    "aliases": [
      "ShowWindowForStoppingScriptExecution"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Включает показ дополнительного окна, которое позволяет остановить выполнение сценария. Необходимо включить использование компоненты VanessaExt."
  },
  {
    "key": "ИспользоватьДляОстановкиВыполненияСценарияФайл",
    "aliases": [
      "UseAFileToStopScriptExecution"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если опция включена, то при нажатии кнопки остановки выполнения сценария в специальном окошке будет создаваться временный файл, а Vanessa Automation будет останавливать выполнение работы сценария, проверяя наличие этого файла."
  },
  {
    "key": "РазрешеноЗапускатьТолькоОдинКлиентТестирования",
    "aliases": [
      "OnlyOneTestClientAllowedToRun"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то будет включен контроль, что одновременно не может быть подключено более одного клиента тестирования. Это может быть полезно, если на компьютерах, на которых запускаются тесты, ограничен объем оперативной памяти и нужно контролировать запуск лишних процессов."
  },
  {
    "key": "ПроверкаСерверныхВызововВОбработчикахСобытий",
    "aliases": [
      "CheckingServerCallsInEventHandlers"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Добавляет к параметрам запуска клиентов тестирования строку /EnableCheckServerCalls. При завершении работы теста проверяет в окне \"Информация для технической поддержки\" наличие специальных сообщений о контекстных серверных вызовах. Если такие сообщения были найдены, то будет вызвана ошибка сценария. Подробная информация тут https://its.1c.ru/db/pubv8devui/content/282/1"
  },
  {
    "key": "ПоказыватьОкноОстановкиЗаписиДействийПользователя",
    "aliases": [
      "ShowWindowToStopRecordingUserActions"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Включает показ дополнительного окошка для удобной остановки записи действий пользователя и переключения в окно Vanessa Automation. Необходимо включить использование компоненты VanessaExt."
  },
  {
    "key": "УбиратьПробелПередЗвездочкойВЗаголовкеОкна",
    "aliases": [
      "removespacebeforestarinwindowtitle"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "removespacebeforestarinwindowtitle"
  },
  {
    "key": "ОтображатьЗакладкиСверху",
    "aliases": [
      "showbookmarkstop"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция установлена, то закладки будут отображаться сверху. Это нужно, чтобы предоставить редактору сценария больше места для отображения сценария."
  },
  {
    "key": "ПоказыватьРазличияВРедактореОтдельно",
    "aliases": [
      "showdifferencesineditorseparately"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Управляет режимом отображения различий при сравнении файлов в редакторе. Если опция включена - то отображается два столбца, иначе различия показываются в тексте файла."
  },
  {
    "key": "ПроверкаСинтаксисаВРедакторе",
    "aliases": [
      "syntaxcheckingineditor"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Опция для включения/отключения проверки синтаксиса в редакторе сценариев"
  },
  {
    "key": "ОтображениеТабуляцииИПробелов",
    "aliases": [
      "displayingtabsandspaces"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "Изменяет режим отображения табуляции и пробелов"
  },
  {
    "key": "ДелатьЛогОшибокВТекстовыйФайл",
    "aliases": [
      "logerrorstotext"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Формировать json файл для каждой ошибки, в котором будет подробная информация об ошибке."
  },
  {
    "key": "СобиратьДанныеОСостоянииАктивнойФормыПриОшибке",
    "aliases": [
      "getactiveformdataonerror"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки будут собраны данные о состоянии элементов активной формы в формате mxl."
  },
  {
    "key": "СобиратьДанныеОСостоянииВсехФормПриОшибке",
    "aliases": [
      "getallformsdataonerror"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки будут собраны данные о состоянии элементов всех форм открытых в клиенте тестирования в формате mxl."
  },
  {
    "key": "СобиратьДанныеОСетевыхСоединениях",
    "aliases": [
      "collectnetworkconnectiondata"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки будут собраны данные о сетевых соединениях ПК, на котором запускались тесты."
  },
  {
    "key": "СобиратьДанныеОПроцессахОС",
    "aliases": [
      "collectdataoftheoperatingsystemprocesses"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки будут собраны данные о запущенных процессах ОС."
  },
  {
    "key": "СобиратьДанныеОЗначенияхПеременных",
    "aliases": [
      "CollectDataOnVariableValues"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает сбор данных о значениях переменных."
  },
  {
    "key": "КомандаЗапускаБраузера",
    "aliases": [
      "browserlaunchcommand"
    ],
    "value": "",
    "valueKind": "string",
    "description": "В данном поле указывается команда запуска браузера. Если поле пустое, тогда для запуска web клиента будет использован браузер по умолчанию. Если в команде запуска браузера содержится строка \"TestClientUrl\", то она будет заменена на строку подключения клиента тестирования. Иначе строка подключения клиента тестирования будет добавлена в конец последним параметром."
  },
  {
    "key": "ИспользоватьБраузерПлюсWebSocket",
    "aliases": [
      "usebrowserwebsocket"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Позволяет выполнять внешние команды для браузера через WebSocket. Для работы опции необходимо включить использование компоненты VanessaExt."
  },
  {
    "key": "ЭмулироватьДвиженияМышкиVanessaExt",
    "aliases": [
      "emulatemousemovementswithVanessaExt"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает эмуляцию движения мышки с помощью компоненты VanessaExt."
  },
  {
    "key": "ЭмулироватьВводКлавиатурыVanessaExt",
    "aliases": [
      "emulatekeyboardinputwithVanessaExt"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает эмуляцию ввода клавиатуры с помощью компоненты VanessaExt"
  },
  {
    "key": "СмещениеПоГоризонталиДвиженияМышкиVanessaExt",
    "aliases": [
      "hrizontaloffset"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "Используется, когда надо сместить положение мышки по горизонтали на заданное число пикселей. Может принимать как положительные, так и отрицательные значения."
  },
  {
    "key": "СмещениеПоВертикалиДвиженияМышкиVanessaExt",
    "aliases": [
      "verticaloffset"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "Используется, когда надо сместить положение мышки по вертикали на заданное число пикселей. Может принимать как положительные, так и отрицательные значения."
  },
  {
    "key": "КоличествоШаговПриДвиженииМышкиVanessaExt",
    "aliases": [
      "thenumberofstepswhenmovingthemouse"
    ],
    "value": "150",
    "valueKind": "number",
    "description": "Задаёт количество микродвижений (шагов), которая совершает мышка на своём пути. Значение по умолчанию 150."
  },
  {
    "key": "ПаузаМеждуШагамиПриДвиженииМышкиVanessaExt",
    "aliases": [
      "timeoutbetweenstepswhenmovingthemouse"
    ],
    "value": "3",
    "valueKind": "number",
    "description": "Задаёт паузу в миллисекундах между микро движениями мышки. Значение по умолчанию 3."
  },
  {
    "key": "ПодсвечиватьКликМышкиВБраузереVanessaExt",
    "aliases": [
      "hlightmouseclicksinbrowser"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если опция включена, то будет включена подсветка кликов с помощью внешней компоненты VanessaExt."
  },
  {
    "key": "ЦветПодсветкиКликаМышкиVanessaExt",
    "aliases": [
      "mouseclickhighlightcolor"
    ],
    "value": "255",
    "valueKind": "number",
    "description": "Число. Задаёт цвет, которым будут подсвечиваться клики мышки."
  },
  {
    "key": "РадиусПодсветкиКликаМышкиVanessaExt",
    "aliases": [
      "mouseclickhighlightradius"
    ],
    "value": "30",
    "valueKind": "number",
    "description": "Задаёт радиус анимации клика."
  },
  {
    "key": "ДлительностьПодсветкиКликаМышкиVanessaExt",
    "aliases": [
      "mouseclickhighlightduration"
    ],
    "value": "12",
    "valueKind": "number",
    "description": "Задаёт длительность анимации клика."
  },
  {
    "key": "ТолщинаПодсветкиКликаМышкиVanessaExt",
    "aliases": [
      "mouseclickhighlightwidth"
    ],
    "value": "12",
    "valueKind": "number",
    "description": "Задаёт толщину анимации клика."
  },
  {
    "key": "ПрозрачностьПодсветкиКликаМышкиVanessaExt",
    "aliases": [
      "mouseclickhighlighttransparency"
    ],
    "value": "127",
    "valueKind": "number",
    "description": "Задаёт прозрачность анимации клика."
  },
  {
    "key": "ПоискКартинокСПомощьюКомпонентыVanessaExt",
    "aliases": [
      "findingpicturesusingaddinvanessaext"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если опция включена, то шаги, выполняющие поиск картинок на экране, будут использовать внешнюю компоненту VanessaExt вместо использования SikuliX."
  },
  {
    "key": "ПорогПоискаКартинки",
    "aliases": [
      "PictureSearchThreshold"
    ],
    "value": "0.99",
    "valueKind": "number",
    "description": "Число, определяющее порог поиска картинки на экране. Значение может быть задано в диапазоне от 0 до 1."
  },
  {
    "key": "ИгнорироватьОшибкиПоискаЭлементовВБраузере",
    "aliases": [
      "ignorebrowsersearcherrors"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Позволяет не останавливать выполнение сценария если элемент формы не был найден в браузере."
  },
  {
    "key": "ИспользоватьUIAutomation",
    "aliases": [
      "UseUIAutomation"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает использование механизма UI Automation в Windows для эмуляции движения и кликов мышкой в шагах из стандартной библиотеки шагов Vanessa Automation. Например, когда опция выключена, шаг И я нажимаю на кнопку \"ЗаголовокКнопки\" просто нажмёт на кнопку не выполняя интерактивных действий. Если опция включена, то курсор мышки сначала будет перемещён к данной кнопке, а затем уже кнопка будет нажата."
  },
  {
    "key": "КоэффициентМасштабированияЭкрана",
    "aliases": [
      "scalefactor"
    ],
    "value": "1",
    "valueKind": "number",
    "description": "Значение по умолчанию равно единице. Если используется масштабирование экрана в ОС, тогда нужно изменять устанавливать соответствующее значение. Например, при масштабировании в 150% в ОС надо установить значение коэффициента 1.5."
  },
  {
    "key": "ИмяФайлаЛогВыполненияСценариев",
    "aliases": [
      "textlogname"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Имя файла, куда будет выводиться лог Vanessa Automation. Если поле пустое - то лог в текстовый файл выводиться не будет."
  },
  {
    "key": "ИмяКаталогаЛогОшибок",
    "aliases": [
      "texterrorslogname"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, для формирования файлов с данными об ошибках и состоянии элементов форм и других данных, связанных с ошибкой. Каталог очищается при начале выполнения сценариев."
  },
  {
    "key": "КомандаСделатьСкриншот",
    "aliases": [
      "commandscreenshot"
    ],
    "value": "",
    "valueKind": "string",
    "description": "В поле указывается консольная команда, которая будет использоваться при снятии скриншотов. Например: 1. \"C:\\Program Files (x86)\\IrfanView\\i_view32.exe\" /capture=1 /convert= 2. nircmd savescreenshot"
  },
  {
    "key": "ИспользоватьКомпонентуVanessaExt",
    "aliases": [
      "useaddin"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Предназначена для управления окнами Windows и Linux. Возможности: Получение списка окон и списка процессов Управление размерами и положением окна Получение снимка окна и снимка экрана https://github.com/lintest/VanessaExt"
  },
  {
    "key": "ЗавершатьРаботуЕслиНеПолучилосьВыполнитьТихуюУстановкуКомпоненты",
    "aliases": [
      "QuitIfSilentInstallationAddinFails"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен и не получилось выполнить тихую установку внешней компоненты работа сеанса будет завершена с кодом возврата 4. Возможные статусы возврата: https://github.com/Pr-Mex/vanessa-automation/blob/develop/docs/ReturnStatus/ReturnStatus.md"
  },
  {
    "key": "ИспользоватьПарсерGherkinИзКомпонентыVanessaExt",
    "aliases": [
      "usethegherkinparserfromthevanessaextaddin"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Устанавливает признак того. что нужно использовать парсер Gherkin из компоненты VanessaExt. Этот парсер работает гораздо быстрее, чем встроенный парсер."
  },
  {
    "key": "ПоискФайловСПомощьюКомпонентыVanessaExt",
    "aliases": [
      "SearchingForFilesUsingTheVanessaExtComponent"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает поиск файлов с помощью внешней компоненты VanessaExt."
  },
  {
    "key": "ИспользоватьВнешнююКомпонентуДляСкриншотов",
    "aliases": [
      "useaddinforscreencapture"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Для снятия скриншотов используется компонента VanessaExt вместо команды создания скриншотов. Для работы опции необходимо включить использование внешней компоненты VanessaExt."
  },
  {
    "key": "СпособСнятияСкриншотовВнешнейКомпонентой",
    "aliases": [
      "screencaptureaddinmethod"
    ],
    "value": "0",
    "valueKind": "number",
    "description": "Весь экран - получает скриншот всего экрана, включая панель задач операционной системы. Текущее окно клиента тестирования - получает скриншот только активного окна клиента тестирования. Все окна клиента тестирования - получает скриншот всех окон клиента тестирования"
  },
  {
    "key": "ПроцессыДляСнятияСкриншотов",
    "aliases": [
      "ProcessesForTakingScreenshots"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Список имен процессов через точку с запятой. Можно использовать символ *, чтобы экранировать один или несколько символов в имени процесса."
  },
  {
    "key": "ДелатьСкриншотПриВозникновенииОшибки",
    "aliases": [
      "onerrorscreenshot"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает снятие скриншотов при возникновении ошибки или по требованию (перед шагом указан тег @screenshot). Для работы опции необходимо, чтобы было заполнено поле \"Команда создания скриншотов\" либо подключена внешняя компонента VanessaExt."
  },
  {
    "key": "СоздаватьПодкаталогВКаталогеAllureДляЭтойСборки",
    "aliases": [
      "createsubfolderforbuild"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "createsubfolderforbuild"
  },
  {
    "key": "ВыгружатьСтатусВыполненияСценариевВФайл",
    "aliases": [
      "createlogs"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то Vanessa Automation будет выгружать статус выполнения сценариев в файл. Подробности тут: https://pr-mex.github.io/vanessa-automation/dev/ReturnStatus/ReturnStatus"
  },
  {
    "key": "ПутьКФайлуДляВыгрузкиСтатусаВыполненияСценариев",
    "aliases": [
      "logpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Путь к файлу, в который будет выгружен статус выполнения сценариев."
  },
  {
    "key": "СниматьСкриншотКаждогоОкна1С",
    "aliases": [
      "onerrorscreenshoteverywindow"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает снятие скриншотов с каждого окна 1С при возникновении ошибки. Для работы опции используется SikuliX либо внешняя компонента VanessaExt (рекомендуется) в зависимости от настроек."
  },
  {
    "key": "СниматьСкриншотыБраузера",
    "aliases": [
      "TakeBrowserScreenshots"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если опция включена, то при возникновении ошибки, когда браузер подключен через debug порт, будет выполнена попытка сделать скриншот браузера."
  },
  {
    "key": "КаталогВыгрузкиСкриншотов",
    "aliases": [
      "outputscreenshot"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, в который будут складываться скриншоты."
  },
  {
    "key": "КаталогПроекта",
    "aliases": [
      "projectpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, где находятся файлы тестируемого проекта, необходимые для выполнения тестов."
  },
  {
    "key": "МетаданныеБиблиотек",
    "aliases": [
      "stepsfrommetadata"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "В списке указываются пути к формам внутри конфигурации, содержащим описания шагов."
  },
  {
    "key": "КаталогКешОзвучкиДляИнтерактивнойСправки",
    "aliases": [
      "VoiceActingCacheDirectoryForOnlineHelp"
    ],
    "value": "",
    "valueKind": "string",
    "description": "VoiceActingCacheDirectoryForOnlineHelp"
  },
  {
    "key": "СоздаватьФайлыОзвучкиДляСправки",
    "aliases": [
      "CreateVoiceoversForOnlineHelp"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "CreateVoiceoversForOnlineHelp"
  },
  {
    "key": "ПодключатьГорячуюКлавишуДляПолученияСправкиОбЭлементе",
    "aliases": [
      "ConnectAHotkeyToGetHelpAboutCurrentItem"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "ConnectAHotkeyToGetHelpAboutCurrentItem"
  },
  {
    "key": "ЗакрыватьСценарийИнтерактивнойСправкиПослеВыполнения",
    "aliases": [
      "CloseInteractiveHelpScriptAfterExecution"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "CloseInteractiveHelpScriptAfterExecution"
  },
  {
    "key": "ПоказыватьПомощникПриПервомЗапуске",
    "aliases": [
      "ShowHelperOnFirstLaunch"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "ShowHelperOnFirstLaunch"
  },
  {
    "key": "ОтключатьДляПолейВозможностьЗатиранияТекстаПриСерверномВызове",
    "aliases": [
      "DisableForFieldsAbilityToOverwriteTextWhenServerCall"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Существует проблема, что при синхронизации состояния формы после завершения серверного вызова, может затираться текст, который в данный момент редактирует пользователь. В тестах это может проявляться так, что тест ввёл значение в поле, но до того как он начал работать с другим полем данное значение было возвращено в предыдущее состояние. Данная опция включает механизм, когда свойство \"ОбновлениеТекстаРедактирования\" у полей формы, будет изменяться после вызова шага ```Gherkin Тогда открылось окно \"ИмяОкна\" ``` Для работы опции в базе клиента тестирования должно быть установлено расширение VAExtension."
  },
  {
    "key": "ОбучениеЗапуститьУрок",
    "aliases": [
      "LearningRunLesson"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "LearningRunLesson"
  },
  {
    "key": "ОбучениеВидео",
    "aliases": [
      "LearningVideo"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "LearningVideo"
  },
  {
    "key": "ОбучениеPDF",
    "aliases": [
      "LearningPDF"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "LearningPDF"
  },
  {
    "key": "ОбучениеMD",
    "aliases": [
      "LearningMD"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "LearningMD"
  },
  {
    "key": "ИспользоватьШаблонНовойФичи",
    "aliases": [
      "UseTemplateForNewFeature"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если указан шаблон (в формате *.txt), то новый сценарий будет создаваться из него"
  },
  {
    "key": "ПутьКШаблонуНовойФичи",
    "aliases": [
      "DirectoryOfNewFeatureTemplate"
    ],
    "value": "",
    "valueKind": "string",
    "description": "DirectoryOfNewFeatureTemplate"
  },
  {
    "key": "СоздаватьИнструкциюВидео",
    "aliases": [
      "videocreate"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Позволяет создавать видео инструкции. Видео по описанию настроек находится в этом плей листе. Также рекомендуется прочитать этот FAQ. https://www.youtube.com/watch?v=QSDvDQDLyLk&list=PLalsS95_a3a_m9ieRJgD3XPWCP9goa9GC https://github.com/Pr-Mex/vanessa-automation/blob/develop/docs/FAQ/MakeAutoVideo.md"
  },
  {
    "key": "ОзвучиватьВыполнениеСценария",
    "aliases": [
      "soundscenarioexecution"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Включает озвучку выполнения сценария согласно заданным настройкам голоса диктора."
  },
  {
    "key": "ЗаписьВидео",
    "aliases": [
      "VideoRecording"
    ],
    "value": "{}",
    "valueKind": "object",
    "description": "VideoRecording"
  },
  {
    "key": "ЗаписьВидео.КаталогВыгрузкиИнструкцийВидео",
    "aliases": [
      "VideoRecording.videopath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, в которой будут помещен результат сборки видео или анимированного скринкаста."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоКомандаНачатьЗаписьВидео",
    "aliases": [
      "VideoRecording.comandrecvideo"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Команда, которая будет запускать VLC для начала записи экрана. В команде возможно редактирование битрейта и других настроек."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоИнструмент",
    "aliases": [
      "VideoRecording.videocapturetool"
    ],
    "value": "ffmpeg",
    "valueKind": "string",
    "description": "Если выбран вариант VLC, тогда для записи видео будет вызываться инструмент VLC. Иначе будет использована внешняя компонента VanessaExt, которая будет вызывать ffmpeg."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоЭкранШирина",
    "aliases": [
      "VideoRecording.screenwidth"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Задаёт ширину экрана для записи видео. Значение не может быть больше чем ширина в текущем разрешении экрана. Если указать значение меньше, то в видео будет записываться часть экрана, начиная с верхнего левого угла."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоЭкранВысота",
    "aliases": [
      "VideoRecording.screenheight"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Задаёт высоту экрана для записи видео. Значение не может быть больше чем высота в текущем разрешении экрана. Если указать значение меньше, то в видео будет записываться часть экрана, начиная с верхнего левого угла."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоЭкранСлева",
    "aliases": [
      "VideoRecording.screenleft"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Задает отступ слева"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоЭкранСверху",
    "aliases": [
      "VideoRecording.screentop"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Задает отступ сверху"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоКоличествоКадров",
    "aliases": [
      "VideoRecording.fps"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Задаёт количество кадров в секунду, снимаемых с экрана во время записи видео."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоФайлКурсораМышки",
    "aliases": [
      "VideoRecording.mousecurfile"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Путь к картинке, которая используется для отрисовки курсора мышки."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоПодсвечиватьАктивныеЭлементыФорм",
    "aliases": [
      "VideoRecording.showframe"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "VideoRecording.showframe"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоПеремещатьКурсорМышкиКАктивномуЭлементуФормы",
    "aliases": [
      "VideoRecording.movemouse"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "VideoRecording.movemouse"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоКаталогДляВременныхФайлов",
    "aliases": [
      "VideoRecording.tempfolderforvideo"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Рабочий каталог, в котором создаются промежуточные файлы во время записи и сборки видео. Каталог очищается перед каждой сборкой видео!"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоФайлВодянойЗнак",
    "aliases": [
      "VideoRecording.watermarkfile"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Картинка в формате png, которая будет использована для наложения водяного знака. Водяной знак будет расположен в правом нижнем углу видео. Разрешение картинки должно быть меньше, чем разрешение, в котором идёт запись видео."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоКомандаFfmpeg",
    "aliases": [
      "VideoRecording.ffmpegcomand"
    ],
    "value": "ffmpeg",
    "valueKind": "string",
    "description": "Команда для работы и обработки видео. Также допускается указание полного пути к файлу ffmpeg.exe По умолчанию: ffmpeg"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоКомандаConvert",
    "aliases": [
      "VideoRecording.convertcomand"
    ],
    "value": "magick convert",
    "valueKind": "string",
    "description": "В поле описывается как будет вызываться команда Convert. Для версии ImageMagick 7 достаточно указать \"magick convert.\" Для более старых версий нужно указать путь к исполняемому файлу convert.exe в каталоге с программой ImageMagick. Пример: \"C:\\Program Files\\ImageMagick-Х.Х.Х-Q16\\convert.exe\" Скачать: https://imagemagick.org/script/download.php Для версий младше 7 в процессе установки обязательным к установке является пункт: Install legacy utilities (e. g. convert) https://imagemagick.org/script/download.php"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоКаталогМузыки",
    "aliases": [
      "VideoRecording.musicpath"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Каталог, в котором находятся файлы в формате mp3. Если поле заполнено, то из каталога будет случайным образом взят mp3 файл, который будет использован для музыкальной подложки. Если длина mp3 файла меньше, чем длина результирующего видео, то аудио трек будет зациклен нужное количество раз, чтобы соответствовать длине видео файла."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоГромкостьМузыки",
    "aliases": [
      "VideoRecording.musicvolume"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Возможно указывать значение от 0 до 1. Если значение поля 0, тогда громкость музыки изменяться не будет. Если указано значение отличное от нуля (например 0.06), тогда данное значение будет влиять на громкость музыкальной подложки. Чем больше значение - тем громче будет звучать музыкальная подложка. Рекомендуется указывать значение 0.1 или меньше."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоДелатьНаложениеTTS",
    "aliases": [
      "VideoRecording.dotts"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Включает озвучку видео диктором."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоТипОзвучкиTTS",
    "aliases": [
      "VideoRecording.ttstype"
    ],
    "value": "1",
    "valueKind": "number",
    "description": "Указывает какой голос нужно использовать для озвучки видео диктором."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидео1СЛогин",
    "aliases": [
      "VideoRecording.1CttsLogin"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Логин для авторизации в сервисе синтеза речи"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидео1СПароль",
    "aliases": [
      "VideoRecording.1CttsPassword"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Пароль для авторизации в сервисе синтеза речи. Пароль указывается в текстовом файле."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидео1СГолос",
    "aliases": [
      "VideoRecording.1CttsVoice"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Голос для генерации речи в сервисе"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидео1ССкоростьРечи",
    "aliases": [
      "VideoRecording.1CttsSpeed"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Скорость (темп) синтезированной речи. Скорость речи задается дробным числом в диапазоне от 0.8 до 2."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоYandexTTSЯзык",
    "aliases": [
      "VideoRecording.yandexttslanguage"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Задаёт язык, на котором будет говорить диктор. Подробности здесь. Управление ударением и произношением см тут. https://cloud.yandex.ru/docs/speechkit/tts/request https://yandex.ru/dev/dialogs/alice/doc/speech-tuning-docpage/"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоYandexTTSГолос",
    "aliases": [
      "VideoRecording.yandexttsvoice"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Задаёт голос, которым будет говорить диктор. Подробности здесь. Управление ударением и произношением см тут. https://cloud.yandex.ru/docs/speechkit/tts/request https://yandex.ru/dev/dialogs/alice/doc/speech-tuning-docpage/"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоYandexTTSЭмоция",
    "aliases": [
      "VideoRecording.yandexttsemotion"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Задаёт эмоцию, с которой будет говорить диктор. Подробности здесь. Управление ударением и произношением см тут. https://cloud.yandex.ru/docs/speechkit/tts/request https://yandex.ru/dev/dialogs/alice/doc/speech-tuning-docpage/"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоYandexTTSСкорость",
    "aliases": [
      "VideoRecording.yandexttsspeed"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Скорость (темп) синтезированной речи. Скорость речи задается дробным числом в диапазоне от 0.1 до 3.0."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоYandexTTSИдентификаторКаталога",
    "aliases": [
      "VideoRecording.yandexttsfolderId"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Последняя часть пути строки адреса в интернет браузере. https://console.cloud.yandex.ru/folders/ИдентификаторКаталога Требуется: 1. В главном окне Яндекс.Облако нажать на ссылку \"Перейти в текущий каталог\". 2. Скопировать последнюю часть путь из строки адреса Пример: https://console.cloud.yandex.ru/folders/b1gheo81t4a6eaafe5vd (Идентификатор каталога - b1gheo81t4a6eaafe5vd) Получение идентификатора каталога https://cloud.yandex.ru/docs/resource-manager/operations/folder/get-id"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоYandexTTSOauthToken",
    "aliases": [
      "VideoRecording.yandexttsoauthtoken"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "OAuth-токен используется в процедуре аутентификации в Яндекс.Облаке Для получения OAuth-токена требуется: 1. Перейти по ссылке https://cloud.yandex.ru/docs/iam/concepts/authorization/oauth-token; 2. Сгенерировать токен; 3. Сохранить его в текстовый файл; 4. Указать путь к текстовому файлу с токеном. https://cloud.yandex.ru/docs/iam/concepts/authorization/oauth-token"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоYandexTTSApiKey",
    "aliases": [
      "VideoRecording.yandexttsapikey"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "API ключ используется в процедуре аутентификации в Яндекс.Облаке https://cloud.yandex.ru/docs/iam/operations/api-key/create Если указан, то авторизация будет через него, если нет, то будет через Токен"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоYandexTTSВариантЗапроса",
    "aliases": [
      "VideoRecording.yandexttsquerytype"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Определяет как будут получены файлы озвучки: через официальное API или через бесплатный интерфейс. Рекомендуемое значение - через официальное API."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоAmazonГолос",
    "aliases": [
      "VideoRecording.amazonttsvoice"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Соответствие языка и голоса смотрите здесь. https://docs.aws.amazon.com/en_us/polly/latest/dg/voicelist.html"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоAmazonДвижок",
    "aliases": [
      "VideoRecording.amazonttsengine"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Варианты значения для поля \"Движок\" смотрите здесь. https://docs.aws.amazon.com/en_us/polly/latest/dg/voicelist.html"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоAmazonЯзык",
    "aliases": [
      "VideoRecording.amazonttslanguage"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Соответствие языка и голоса смотрите здесь. https://docs.aws.amazon.com/en_us/polly/latest/dg/voicelist.html"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоAmazonРегион",
    "aliases": [
      "VideoRecording.amazonttsregion"
    ],
    "value": "us-east-1",
    "valueKind": "string",
    "description": "В поле указывается параметр регион. Значение по умолчанию: us-east-1."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоAmazonКлючДоступа",
    "aliases": [
      "VideoRecording.amazonttskey"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Ключ доступа к облаку Amazon."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоAmazonСекретныйКлюч",
    "aliases": [
      "VideoRecording.amazonttssecretkey"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Файл, в котором хранится секретный ключ для доступа к облаку Amazon."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоСберTTSГолос",
    "aliases": [
      "VideoRecording.sberttsvoice"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Задает голос для генерации. Примеры голосов можно посмотреть здесь https://developer.sberdevices.ru/docs/ru/smartservices/synthesize_smartspeech#%D0%BF%D1%80%D0%B8%D0%BC%D0%B5%D1%80%D1%8B-%D0%B3%D0%BE%D0%BB%D0%BE%D1%81%D0%BE%D0%B2-%D0%B4%D0%BB%D1%8F-%D1%81%D0%B8%D0%BD%D1%82%D0%B5%D0%B7%D0%B0"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоСберTTSClientID",
    "aliases": [
      "VideoRecording.sberttsclientid"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Идентификатор клиента, полученный в Smartmarket studio"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоСберTTSClientSecret",
    "aliases": [
      "VideoRecording.sberttsclientsecret"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Вторая часть идентификации клиента в Smartmarket studio"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоПутьКДвижкуTTS",
    "aliases": [
      "VideoRecording.audioenginetts"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Консольная команда, которая будет использована при конвертации текста в речь. Используется программа balabolka_console. https://cross-plus-a.com/bconsole.htm"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоИмяTTS",
    "aliases": [
      "VideoRecording.ttsvoice"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Указывает какой голос будет использован для озвучки. Допускается указывать не полное название голоса в системе, а только часть, например \"Elena\". Понадобится установить Microsoft Speech Platform х32 и Server Runtime Languages. https://www.microsoft.com/en-us/download/details.aspx?id=27225"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоСловарьЗамен",
    "aliases": [
      "VideoRecording.changewordslib"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Список файлов, которые будут использоваться для автозамены произносимого текста."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоГруппаШаговКакШаг",
    "aliases": [
      "VideoRecording.groupofstepsasastep"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Включает режим, когда по умолчанию каждая группа шагов первого уровня в сценарии будет конвертироваться в один шаг в автоинструкции."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоОтключитьМасштабированиеШаговПоВремени",
    "aliases": [
      "VideoRecording.disablescalingofsteps"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Отключает масштабирование видео фрагментов по времени."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоПодсвечиватьНажатияМышки",
    "aliases": [
      "VideoRecording.highlightmouseclicks"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Включает подсветку кликов мышки. Используется утилита из проекта UIToolsFor1C. Эмуляция кликов мышки осуществляется с помощью SikuliX."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоОтключитьСлайдСЗаголовкомФичи",
    "aliases": [
      "VideoRecording.turnofffeaturetitleslide"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Отключает создание в видео начального слайда, в котором указывается название фича файла."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоОтключитьСлайдСценария",
    "aliases": [
      "VideoRecording.turnoffscenarioslide"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Отключает создание в видео слайда, в котором выводится название сценария."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоОтключитьСлайдФинал",
    "aliases": [
      "VideoRecording.turnofffinalslide"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Отключает создание в видео финального слайда, в котором выводится итоговая информация по видео."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоЭмулироватьВводСКлавиатуры",
    "aliases": [
      "VideoRecording.emulatekeyboardinput"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Включает ввод эмуляцию ввода текста с клавиатуры с помощью утилиты из проекта UIToolsFor1C. Допускается ввод текста только на русском и английском языках. Переключение раскладки клавиатуры осуществляется с помощью эмуляции нажатия Ctrl+Shift."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоСкрытьСлужебныеОкна",
    "aliases": [
      "VideoRecording.hideservicewindows"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Скрывает служебные консольные окна, которые используются для сборки видео. Ускоряет сборку видео. Рекомендуется."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоСкоростьПроизношения",
    "aliases": [
      "VideoRecording.speedofspeech"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Скорость произношения текста диктором. Значения могут быть от -10 до 10."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоСкоростьПроизношенияТекстаБезОзвучки",
    "aliases": [
      "VideoRecording.speedofspeechwithouttts"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "VideoRecording.speedofspeechwithouttts"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоКэшироватьФайлыTTS",
    "aliases": [
      "VideoRecording.cachettsfiles"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Включает кэширование файлов озвучки. Ускоряет сборку видео. Позволяет сократить обращение к внешним сервисам для генерации речи. Позволяет сократить затраты на генерацию речи при использовании платных тарифов у сервисов генерации речи."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоКэшФайловTTS",
    "aliases": [
      "VideoRecording.ttsfilescache"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Каталог, в котором хранится кэш файлов озвучки."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоКэшироватьВидеоВставки",
    "aliases": [
      "VideoRecording.cachevideo"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Если флаг установлен то при работе шага И видеовставка \"ТекстВставки\" будет происходить проверка, есть ли в кэш уже такой видеофрагмент. Если в кэш фрагмента нет - он будет туда добавлен. Если фрагмент есть - то он будет взят из кэш. Установка флага ускоряет сборку видео."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоКэшВидеоВставок",
    "aliases": [
      "VideoRecording.videocachepath"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Каталог, в котором хранятся фрагменты видеовставок."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоДобавлятьСубтитры",
    "aliases": [
      "VideoRecording.addsubtitles"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Включает добавление субтитров встроенных в видео."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоПроцентУскорения",
    "aliases": [
      "VideoRecording.accelerationpercentage"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Максимальный процент ускорения, который возможен для фрагмента видео (одного шага видео). Механизм сборки видео может ускорить фрагмент видео, например, если длительность аудио трека для фрагмента была 5 секунд, а сам видео фрагмент получился 10 секунд. Если указано значение 0 - то ограничения на ускорение нет. Рекомендуется значение - 30%. Тогда в приведенном примере видео ускорится (5 * 1.3) с 5 секунд до 6.5 секунд."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоФормироватьИнструкциюТипВидео",
    "aliases": [
      "VideoRecording.instructiontypevideo"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Создавать видео инструкцию."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоФормироватьИнструкциюТипHTML",
    "aliases": [
      "VideoRecording.instructiontypehtml"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Создавать анимированный скринкаст в формате HTML."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоФормироватьИнструкциюТипMarkdown",
    "aliases": [
      "VideoRecording.instructiontypemarkdown"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "VideoRecording.instructiontypemarkdown"
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоЭмулироватьДвиженияМышкиSikuliX",
    "aliases": [
      "VideoRecording.emulatemousemovement"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Если флаг установлен, то при выполнении шагов будет выполняться попытка найти элемент формы или элемент управления на экране и переместить курсор мышки к нему. Для поиска картинки и передвижения мышки используется SikuliX. Картинка для поиска будет сгенерирована по тексту, полученному из элемента формы. Чтобы отключить движение мышки у конкретного шага надо использовать директиву #[DoNotMoveMouse]."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоПутьКОбработкеДвижкаTTS",
    "aliases": [
      "VideoRecording.pathprocessingenginetts"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Позволяет генерировать озвучку шага с помощью внешней обработки. Обработка должна в основной форме содержать экспортный метод: GetMp3File(Vanessa, VideoParams, Text, FileName, VoiceParams) где: Vanessa - Контекст фреймворка Vanessa Automation VideoParams - Структура, содержащая параметры записи видео Text - текст, который требуется озвучить FileName - имя текущего видеофрагмента VoiceParams - дополнительные параметры озвучки, указанные в фича файле с помощью дополнительных директив Метод должен возвращать путь к mp3 файлу."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоЗаменитьСлайдЗаголовок",
    "aliases": [
      "VideoRecording.changefeaturetitleslide"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Если флаг установлен, то стандартный файл с заголовком фичи будет заменен на указанный видео файл. Видео файл должен быть того разрешения, что и записываемое видео. Также у него должна быть аудио дорожка."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоПутьКСлайдуЗаголовок",
    "aliases": [
      "VideoRecording.featuretitleslidepath"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Путь к видео файлу с заголовком фичи, который будет добавлен вместо стандартного."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоДобавитьМузыкуКСлайдуЗаголовок",
    "aliases": [
      "VideoRecording.addmusictofeaturetitleslide"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Если флаг установлен, то к видео файлу с заголовком фичи будет добавлена музыка."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоЗаменитьСлайдФинал",
    "aliases": [
      "VideoRecording.changefinalslide"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Если флаг установлен, то стандартный финальный файл будет заменен на указанный видео файл. Видео файл должен быть того разрешения, что и записываемое видео. Также у него должна быть аудио дорожка."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоПутьКСлайдуФинал",
    "aliases": [
      "VideoRecording.finalslidepath"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Путь к финальному видео файлу, который будет добавлен вместо стандартного финального видео файла."
  },
  {
    "key": "ЗаписьВидео.ЗаписьВидеоДобавитьМузыкуКСлайдуФинал",
    "aliases": [
      "VideoRecording.addmusictofinalslide"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Если флаг установлен, то к финальному видео файлу будет добавлена музыка."
  },
  {
    "key": "ЗаписьВидео.НастройкиДругогоДвижкаTTS",
    "aliases": [
      "VideoRecording.SettingsOtherEngineTTS"
    ],
    "value": "[]",
    "valueKind": "array",
    "description": "Позволяет задать произвольный набор настроек для генерации файлов озвучки."
  },
  {
    "key": "ИспользоватьSikuliXСервер",
    "aliases": [
      "usesikulixserver"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "SikuliX это Java приложение, которое позволяет управлять перемещением и нажатиями мыши на экране, а также эмулировать нажатие кнопок клавиатуры. SikuliX Server - это специальная программная оптимизация работы с SikuliX. Если опция включена VA собирает один большой скрипт из множества скриптов SikuliX, который можно запустить один раз и быстро выполнять необходимые команды, которые раньше приходилось запускать по одной. Это позволяет существенно сэкономить время на выполнение одного скрипта SikuliX, т.к. не тратится время на запуск SikuliX и его выгрузку из памяти. Описание установки и настройки SikuliX и SikuliX Server приведено в разделе справки 20.1 Открыть справку"
  },
  {
    "key": "SikuliXServer",
    "aliases": [],
    "value": "{}",
    "valueKind": "object",
    "description": "SikuliXServer"
  },
  {
    "key": "SikuliXServer.КаталогиСкриптовSikuliX",
    "aliases": [
      "SikuliXServer.sikulixscriptpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог скриптов. Можно указывать несколько каталогов, разделенных через \";\"."
  },
  {
    "key": "SikuliXServer.КаталогДляГенерацииКартинок",
    "aliases": [
      "SikuliXServer.pathforpicturegeneration"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, в котором будут программно создаваться картинки для поиска их на экране."
  },
  {
    "key": "ИскатьЭлементыФормыПоИмени",
    "aliases": [
      "searchformelementsbyname"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то при генерации текста сценария после накликивания, шаги в сценарии будут искать элементы формы по внутреннему имени. Если флаг снят, то при генерации текста сценария после накликивания, шаги в сценарии будут искать элементы формы по заголовку, если это возможно. Это возможно в том случае, если в данной форме есть только один элемент с данным заголовком."
  },
  {
    "key": "ДобавлятьПриНакликиванииМетаИнформацию",
    "aliases": [
      "addmetainformationclicking"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то при генерации текста сценария после накликивания будет добавляться информация, необходимая для перевода сценария на другой язык в будущем."
  },
  {
    "key": "ТегTreeВключенПоУмолчанию",
    "aliases": [
      "thetreetagisenabledbydefault"
    ],
    "value": "true",
    "valueKind": "boolean",
    "description": "Если флаг установлен, то считается, что в фича файл написан так, как будто в нём указан тег @tree, даже если его там нет. Т.е. считается, что любой загружаемый фича файл использует иерархию шагов."
  },
  {
    "key": "StartFeaturePlayer",
    "aliases": [
      "startfeatureplayer"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "startfeatureplayer"
  },
  {
    "key": "ВыгрузитьPIDTestManager",
    "aliases": [
      "returnpidoftestmanager"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "returnpidoftestmanager"
  },
  {
    "key": "КаталогИсполняемогоФайла",
    "aliases": [
      "pathtoplatform"
    ],
    "value": "",
    "valueKind": "string",
    "description": "pathtoplatform"
  },
  {
    "key": "ИмяФайлаPIDTestManager",
    "aliases": [
      "filenamepidtestmanager"
    ],
    "value": "",
    "valueKind": "string",
    "description": "filenamepidtestmanager"
  },
  {
    "key": "ИмяФайлаВнешнихКомандФреймворка",
    "aliases": [
      "fileofcommand"
    ],
    "value": "",
    "valueKind": "string",
    "description": "fileofcommand"
  },
  {
    "key": "ДелатьСообщенияТранслитом",
    "aliases": [
      "translatemassage"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "translatemassage"
  },
  {
    "key": "КаталогИнструментов",
    "aliases": [
      "instrpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, где находится обработка Vanessa Automation. При работе со стандартной поставкой поле должно быть заполнено. При работе с Vanessa Automation Single допускается оставлять поле пустым."
  },
  {
    "key": "КаталогВременныхФайлов",
    "aliases": [
      "TemporaryFilesDirectory"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, в котором будут создаваться временные файлов скриптов. Если указано значение настройки - тогда временные файлы скриптов будут создаваться в нём. Если значение настройки не указано, тогда будет использоваться временный каталог пользователя. Обычно это \"C:\\USERS%username%\\APPDATA\\LOCAL\\TEMP\". Настройка нужна, т.к. Vanessa Automation может создавать bat файлы для запуска системных команд, а в некоторых ОС может быть установлен запрет на запуск таких файлов из временного каталога пользователя."
  },
  {
    "key": "ВыполнитьСценарии",
    "aliases": [
      "vanessarun"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "vanessarun"
  },
  {
    "key": "ЗагрузитьСценарии",
    "aliases": [
      "loadscenarios"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "loadscenarios"
  },
  {
    "key": "ЗавершитьРаботуСистемы",
    "aliases": [
      "vanessashutdown"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "vanessashutdown"
  },
  {
    "key": "ВыполнитьСценарииСТекущегоШага",
    "aliases": [
      "vanessarunfromthisstep"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "vanessarunfromthisstep"
  },
  {
    "key": "НомерСтрокиДляЗапускаСТекущегоШагаСценария",
    "aliases": [
      "stepnumber"
    ],
    "value": "",
    "valueKind": "string",
    "description": "stepnumber"
  },
  {
    "key": "КлиентыТестирования",
    "aliases": [
      "testclienttable"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "testclienttable"
  },
  {
    "key": "ИмяСборки",
    "aliases": [
      "buildname"
    ],
    "value": "",
    "valueKind": "string",
    "description": "buildname"
  },
  {
    "key": "ДымовыеТесты",
    "aliases": [],
    "value": "{}",
    "valueKind": "object",
    "description": "ДымовыеТесты"
  },
  {
    "key": "ДымовыеТесты.ДымовыеТестыЯзыкШагов",
    "aliases": [
      "ДымовыеТесты.SmokeTestsLanguageSteps"
    ],
    "value": "ru",
    "valueKind": "string",
    "description": "ДымовыеТесты.SmokeTestsLanguageSteps"
  },
  {
    "key": "ДымовыеТесты.ДымовыеТестыКаталогВыходныхФайлов",
    "aliases": [
      "ДымовыеТесты.SmokeTestsDirectoryOutputFiles"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, в который будут записаны итоговые feature-файлы."
  },
  {
    "key": "ДымовыеТесты.ДымовыеТестыОчищатьКаталогВыходныхФайлов",
    "aliases": [
      "ДымовыеТесты.SmokeTestsCleanDirectoryOutputFiles"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "Если установлен, то feature-файлы в каталоге выходных файлов будут удалены перед началом формирования тестов."
  },
  {
    "key": "ДымовыеТесты.ДымовыеТестыКаталогФайловИсключений",
    "aliases": [
      "ДымовыеТесты.SmokeTestsDirectoryFileExceptions"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Каталог, в котором хранятся текстовые файлы с объектами-исключениями. Для каждого вида объектов метаданных или события должен быть отдельный файл (\"Справочники\", \"Документы\" и т. д.)."
  },
  {
    "key": "ДымовыеТесты.ДымовыеТестыТолькоВведенныеОбъекты",
    "aliases": [
      "ДымовыеТесты.SmokeTestsOnlyEnteredObjects"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "При включении данного флага в формировании feature-файлов расширенных действий будут участвовать только объекты, для которых в текущей информационной базе существует хотя бы один не помеченный на удаление элемент."
  },
  {
    "key": "ДымовыеТесты.ДымовыеТестыТолькоИзмененныеОтносительноКонфигурацииПоставщика",
    "aliases": [
      "ДымовыеТесты.SmokeTestsOnlyChangedRelativeToVendorConfiguration"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "ДымовыеТесты.SmokeTestsOnlyChangedRelativeToVendorConfiguration"
  },
  {
    "key": "ДымовыеТесты.ДымовыеТестыИмяКонфигурацииПоставщика",
    "aliases": [
      "ДымовыеТесты.SmokeTestsVendorConfigurationName"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "Имя конфигурации поставщика для сравнения конфигураций."
  },
  {
    "key": "ДымовыеТесты.ДымовыеТестыПутьКФайлуНастроекСценариев",
    "aliases": [
      "ДымовыеТесты.SmokeTestsPathToFileSettingsScripts"
    ],
    "value": "",
    "valueKind": "string",
    "description": "Путь к файлу настройки сценариев (файл настройки можно сформировать на закладке \"Настройка сценариев\" в окне \"Генератор дымовых тестов\")."
  },
  {
    "key": "ДымовыеТесты.ДымовыеТестыНачальнаяДатаДляПодбораДокументов",
    "aliases": [
      "ДымовыеТесты.SmokeTestsStartingDateForSelectionDocuments"
    ],
    "value": "",
    "valueKind": "unknown",
    "description": "ДымовыеТесты.SmokeTestsStartingDateForSelectionDocuments"
  },
  {
    "key": "ДымовыеТесты.ДымовыеТестыСортироватьДокументыПоДатеУбыв",
    "aliases": [
      "ДымовыеТесты.SmokeTestsSortDocumentsByDescendingDate"
    ],
    "value": "false",
    "valueKind": "boolean",
    "description": "ДымовыеТесты.SmokeTestsSortDocumentsByDescendingDate"
  },
  {
    "key": "КаталогOutputAllure",
    "aliases": [
      "allurepath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "allurepath"
  },
  {
    "key": "КаталогOutputAllureБазовый",
    "aliases": [
      "allurepathbase"
    ],
    "value": "",
    "valueKind": "string",
    "description": "allurepathbase"
  },
  {
    "key": "КаталогOutputjUnit",
    "aliases": [
      "junitpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "junitpath"
  },
  {
    "key": "КаталогOutputCucumberJson",
    "aliases": [
      "cucumberreportpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "cucumberreportpath"
  },
  {
    "key": "КаталогOutputИнструкцияHTML",
    "aliases": [
      "htmlpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "htmlpath"
  },
  {
    "key": "КаталогOutputИнструкцияMarkdown",
    "aliases": [
      "markdownpath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "markdownpath"
  },
  {
    "key": "КаталогOutputИнструкцияВидео",
    "aliases": [
      "videopath"
    ],
    "value": "",
    "valueKind": "string",
    "description": "videopath"
  },
  {
    "key": "КаталогOutputСкриншоты",
    "aliases": [
      "outputscreenshot"
    ],
    "value": "",
    "valueKind": "string",
    "description": "outputscreenshot"
  }
];
