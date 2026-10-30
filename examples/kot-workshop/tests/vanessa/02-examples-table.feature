# language: en
@Workshop @Data
Feature: Several examples of the same scenario

Scenario Outline: Remember a named value
    And I save "<Value>" in "<Variable>" variable

Examples:
    | Variable        | Value                  |
    | WorkshopClient  | Учебный покупатель     |
    | WorkshopProduct | Учебный товар          |
