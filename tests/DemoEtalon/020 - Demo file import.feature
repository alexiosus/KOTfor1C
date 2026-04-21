#language: en
@tree
#report.feature=Drive
#report.story=Demo
Feature: 020 - Demo file import

@КодСценария=020 - Demo file import
@UIDСценария=9d150103-5718-4246-a4f3-8df64c33858b
@КодНастройкиСценария=020 - Demo file import
@UIDНастройкиСценария=78ede828-0a69-48cc-9115-26b193c7fb34
@UIDРазделПроекта=
@ИмяНастройкиСценария=020 - Demo file import
@ИдентификаторБазы=DemoEtalon
@UIDОтветственный=
Scenario: 020 - Demo file import
	
	# KOT demo:
	# - The first validation call below uses the nested scenario default parameter.
	# - The second validation call invokes the same nested scenario again, but with another value.
	# - This is the most explicit demo of repeated calls to one scenario with different parameters.
	*And I prepare demo session
		
		And I set "Administrator" synonym to the current TestClient
		And I connect "Administrator" profile of TestClient
		And Delay "1"
	*And I import demo items from file
		
		# KOT demo:
		# - Open files/demo-items.csv to verify that dependency highlighting also works from files/*.
		# - You can use "Open current scenario files folder" to open catalog of attachments in Explorer.
		Given I open hyperlink "e1cib/list/Catalog.Items"
		Then "Items" window is opened
		And I click "Import data from an external source" button
		And I wait "Import data from external sources" window opening in 10 seconds
		If "$КаталогПроекта$/demo-items.csv" Exists Then
				And I select external file "$КаталогПроекта$/demo-items.csv"

		And I click "import data from external file" hyperlink of "You can import data from external file (xlsx, mxl, csv) or copy and paste data into spreadsheet template." field
		And I wait "R1C1" cell in "SpreadsheetDocument" spreadsheet document becomes equal to "Do not import" for "10" seconds
		And I click "Next >" button
		And I click "Import data to application" button
	*And I validate demo import result
		
		# KOT demo:
		# - This scenario is called twice from the import main scenario.
		# - First call keeps the default ImportedItem, second call overrides it explicitly.
		Given I open hyperlink "e1cib/list/Catalog.Items"
		Then "Items" window is opened
		And I go to line in "List" table
		| 'Description'  |
		| "Demo imported item A" |
		And I close "Items" window
	*And I validate demo import result
			#ImportedItem = Demo imported item B
		
		# KOT demo:
		# - This scenario is called twice from the import main scenario.
		# - First call keeps the default ImportedItem, second call overrides it explicitly.
		Given I open hyperlink "e1cib/list/Catalog.Items"
		Then "Items" window is opened
		And I go to line in "List" table
		| 'Description'  |
		| "Demo imported item B" |
		And I close "Items" window
