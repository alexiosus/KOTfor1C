# language: en

Feature: Project exports

Background:
    Given data is ready

@ExportScenarios
Scenario Outline: I open <Entity> as "Role"
    Opens an entity for a role.
    Given the entity is open
    Examples:
        | Entity | Role |
        | Order  | Admin |

Scenario: This scenario is not exported
    Given nothing happens

@ExportScenarios
Scenario: I pass a document string
    Given the following text:
        """
        Scenario: Fake declaration
        @ExportScenarios
        Scenario Outline: Another fake <Name>
        """

@ExportScenarios
Scenario:
