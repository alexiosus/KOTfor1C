# Результаты тестов

- Статус: Failed
- Длительность: 3664 мс
- Ошибка: {ExternalDataProcessor.РаботаСИнтерфейсом.Form.Форма.Form(14256)}: {ExternalDataProcessor.VanessaAutomation.Form.КлиентТестирования.Form(2469)}: {ExternalDataProcessor.VanessaAutomation.Form.КлиентТестирования.Form(2379)}: Клиент тестирования не подключен.

Технические данные:
        ЗаголовокАктивногоОкна:
        ИмяАктивнойФормы:
        ИмяФичи: Подготовить заявку из раздельного исходника
        ИмяСценария: Подготовить заявку из раздельного исходника
        НомерСтрокиДерева: 9
        НомерСтрокиФичи: 28
        ПолныйПутьКФиче: C:\KOT\failure-skipped.feature
        ИмяФайла: C:/VA/РаботаСИнтерфейсом.epf
        ИмяПроцедуры: ВКомандномИнтерфейсеЯВыбираю
        ИмяРаннера: TEST-MACHINE
        ИмяКлиентаТестирования:
        СинонимКлиентаТестирования:
        ТипКлиентаТестирования:
        СтрокаСоединения:
        ДопПараметрыПодключения:
        PIDКлиентаТестирования: 0
        ВерсияVA: ver 1.2.043.45
        ВерсияПлатформы: 8.5.1.1522
        ТипПлатформы: Windows x86-64
        РежимСовместимостиTestManager: Version8_3_24
        ВремяРаботыСценария: 0:00:04 (ч:м:с)
        ДатаВремяОшибки: 2026-10-28 00:00:00
        ОбнаруженоНештатноеЗавершениеКлиентаТестирования: Нет

## Шаги (14)
1. And I save "Покупатель из feature" in "WorkshopCustomer" variable → **Success** (19 мс)
2. And I save "Native source is ready" in "WorkshopMessage" variable → **Success** (2 мс)
3. And In the command interface I select "Sales" "Customers" → **Failed** (3530 мс)
   - Ошибка: Клиент тестирования не подключен.
4. Then "Customers" window is opened → **Skipped** (0 мс)
   - Ошибка: Пропущен
5. And I click the button named "Create" → **Skipped** (0 мс)
   - Ошибка: Пропущен
6. Then "Counterparty (create)" window is opened → **Skipped** (0 мс)
   - Ошибка: Пропущен
7. And I input "$WorkshopCustomer$" text in the field named "DescriptionFull" → **Skipped** (0 мс)
   - Ошибка: Пропущен
8. And I move to the next attribute → **Skipped** (0 мс)
   - Ошибка: Пропущен
9. And I click the button named "FormWriteAndClose" → **Skipped** (0 мс)
   - Ошибка: Пропущен
10. And I wait "Counterparty (create)*" window closing in 10 seconds → **Skipped** (0 мс)
   - Ошибка: Пропущен
11. Then "Customers" window is opened → **Skipped** (0 мс)
   - Ошибка: Пропущен
12. And I activate field named "Description" in "List" table → **Skipped** (0 мс)
   - Ошибка: Пропущен
13. And I go to line in "List" table → **Skipped** (0 мс)
   - Ошибка: Пропущен
14. And I go to line in "List" table → **Skipped** (0 мс)
   - Ошибка: Пропущен
