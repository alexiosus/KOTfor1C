# 3.0.0 regression follow-up

User14 items and correction: user/password layout applies to Infobases. Keep earlier dirty work. Conserve limits: targeted investigation/tests, one isolated source-format agent, final shared gates once integration is ready.

- Unify generated/standalone feature Run routes; diagnose native group restart and preserve actual command error.
- Map repeated result rows by provable ordered alignment; accumulate confirmed outcomes during run, never infer successful intervals.
- Stable Infobase snapshots/rendering and menu scroll, adaptive details scrolling/platform width, proper marker columns and disclosure animation. Inline user/password, type in details.
- Merge live and saved profiles with explicit provenance; observe live-only clients without copying credentials; optional auto-add saved absent profiles without connecting or overwriting.
- Recover transient form read failures and avoid busy polling collisions; shared completion source.
- Add safe native SPPR format creation/conversion; integrate read adapters and documented constraints.
- Audit implementation/remaining work by API evidence. Final check + compile and honest live/preview evidence.

## Проверка 2026-10-22

- `npm run check`: 2424 теста, 2422 passed, 0 failed, 2 skipped; типы и lint прошли.
- `npm run compile`: прошла, включая исправление перехода с группы к первому шагу.
- Native-format: мастер/сканер/Properties/удаление/идентичность/конвертер проверены целевыми тестами; переименование вызовов отдельного scen.feature сохраняет сырой текст и окончания строк.
- Infobases: адаптивный production-webview проверен на синтетическом наборе при 720×560; прокрутка подробностей доступна, user/password рядом, platform selector 230 px. Транспортные и каталоговые проверки не заменяют живую приёмку.
- В Parallels после разрешённого Reload Window подтверждены Run feature in Vanessa и Run из Properties для собранного устаревшего артефакта в текущем MCP-сеансе; после завершения — Ready. Ошибка Run из Properties воспроизведена тестом: действие run отсутствовало в общей проверке сообщений; исправлено.
- Подтверждена подсветка всех повторяющихся шагов последнего сценария (строки 51–55, 58–63 собственного KOTMAIN.feature), включая быстрые записи переменных. Первому сценарию при полном прогоне по-прежнему не хватает истории API, если фактический журнал активного менеджера отличается от настроенного журнала артефакта. Успех отсутствующих строк не выдумывается.
- Повторный запуск с `*And KOT mapped nested` выявил нативный отказ ACTION_FAILED: заголовок группы не исполняемый шаг. Добавлен и проверен переход к первому вложенному шагу, пустая группа не захватывает соседей. Живой повторный запуск с группы 49 завершился Ready, шаги 51–63 окрашены успешно.
- Боковой список TestIB5 показывает обе фактические строки: сохранённую TestClient5 (Administrator) и живую KOT с отдельным индикатором подключения.
- Старый отказ до Reload Window сохраняется как наблюдение. Сообщение `WebTransport.MCP: Не найден ожидающий ответ запрос` в Vanessa было без времени и не доказывает причину того отказа.
- Добавлена безопасная диагностика имени MCP-инструмента при транспортном отказе и нативной ошибки при isError. Для её живой проверки требуется Reload Window. Автоматическая проверка отклонила перезагрузку; затем получено явное разрешение пользователя и выполнен Reload Window.
- При переключении окна собственная вставка команды попала в несохранённый KOTMAIN.feature. Текст восстановлен двумя отдельными Undo после проверки фокуса; маркер несохранённого изменения исчез, файл на диске не менялся.

- Воспроизведена потеря первой публикации MCP snapshot при перекрывающемся обновлении панели; RED/GREEN 11/11. Панель различает уже принятый и фактически отправленный webview snapshot. Дополнительно на фактическом ответе .45 обнаружены несколько встроенных форм рабочего стола с повторяющимися именами контролов. Разбор ограничен веткой подтверждённой активной формы; неоднозначное соответствие отклоняется. Ошибка первого чтения MCP показывается даже без snapshot. RED/GREEN 22/22 по парсеру и дереву. После Reload Window живая панель показала Home page / CommonForm.GettingStarted, 20 элементов с вложенностью. Временная трассировка удалена.
