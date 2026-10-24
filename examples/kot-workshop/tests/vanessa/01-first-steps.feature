# language: en
@Workshop @Smoke
Feature: First steps in Vanessa
    Learn how a step changes a variable without opening a business form.

Scenario: Remember a workshop customer
    And I save "Учебный покупатель" in "WorkshopCustomer" variable
    And I save "Заявка создана" in "WorkshopMessage" variable

Scenario: Update the workshop message
    And I save "Заявка проверена" in "WorkshopMessage" variable
