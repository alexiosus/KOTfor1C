#language: en
@tree
#report.feature=Drive
#report.story=Demo
Feature: 010 - Demo order happy path

@КодСценария=010 - Demo order happy path
@UIDСценария=59403680-937c-4a72-8366-02e894038b49
@КодНастройкиСценария=010 - Demo order happy path
@UIDНастройкиСценария=fa1242fd-f969-4939-9d2e-34cda5c5a768
@UIDРазделПроекта=
@ИмяНастройкиСценария=010 - Demo order happy path
@ИдентификаторБазы=DemoEtalon
@UIDОтветственный=
Scenario: 010 - Demo order happy path
	
	# KOT demo:
	# - Open this file from Test Manager to see a main scenario with PhaseSwitcher metadata.
	# - Put the caret on nested scenario names below to test hover, navigation, and "Find references".
	# - Open one of the nested scen.yaml files or files under their folders to see affected-main highlighting.
	# - This main scenario intentionally has no own ПараметрыСценария block content.
	*And I prepare demo session
		
		And I set "Administrator" synonym to the current TestClient
		And I connect "Administrator" profile of TestClient
		And Delay "1"
	*And I ensure demo master data
		
		Given I open hyperlink "e1cib/list/Catalog.Companies"
		Then "Companies" window is opened
		And I click the button named "FormCreate"
		Then "Company (create)" window is opened
		And I input "Demo company" text in "Description" field
		And I click "Save and close" button
		And I wait "Company (create) *" window closing in 20 seconds
		Given I open hyperlink "e1cib/list/Catalog.Counterparties"
		Then "Counterparties" window is opened
		And I click the button named "FormCreate"
		Then "Counterparty (create)" window is opened
		And I input "Retail demo customer" text in "Description" field
		And I click "Save and close" button
		And I wait "Counterparty (create) *" window closing in 20 seconds
		Given I open hyperlink "e1cib/list/Catalog.Items"
		Then "Items" window is opened
		And I click the button named "FormCreate"
		Then "Item (create)" window is opened
		And I input "Demo item" text in "Description" field
		And I click "Save and close" button
		And I wait "Item (create) *" window closing in 20 seconds
	*And I create demo sales order
			#Customer       = Retail demo customer
			#SecondLineItem = Demo service
		
		# KOT demo:
		# - This scenario receives only part of the values from its parent main scenario.
		# - The rest is taken from defaults in ПараметрыСценария below.
		# - Open the nested call "I add demo sales order lines" to inspect the next propagation level.
		Given I open hyperlink "e1cib/list/Document.SalesOrder"
		Then "Sales orders" window is opened
		And I click the button named "FormCreate"
		Then "Sales order (create)" window is opened
		And I select from "Company" drop-down list by "Demo company" string
		And I select from "Customer" drop-down list by "Retail demo customer" string
		*And I add demo sales order lines
				#FirstLineItem      = FirstLineItem
				#FirstLineQuantity  = FirstLineQuantity
				#FirstLinePrice     = FirstLinePrice
				#SecondLineItem     = SecondLineItem
				#SecondLineQuantity = SecondLineQuantity
				#SecondLinePrice    = SecondLinePrice
			
			# KOT demo:
			# - The same nested scenario is called twice below with different parameters.
			# - The second call exists only when SecondLineItem is passed or has a non-empty value.
			And I save "Demo service" line to the variable "SecondLineItem"
			*And I fill demo sales order line
					#Item     = FirstLineItem
					#Quantity = FirstLineQuantity
					#Price    = FirstLinePrice
				
				# KOT demo:
				# - This is a leaf reusable scenario.
				# - Hover [Item], [Quantity], and [Price] to inspect declared parameters and defaults.
				# - The parent scenario calls this block multiple times with different values.
				# - Use "Find references" to inspect both call sites.
				And in the table "Inventory" I click the button named "InventoryAdd"
				And I activate "Product" field in "Inventory" table
				And I input "Demo item" text in "Product" field of "Inventory" table
				And I input "1.000" text in "Quantity" field of "Inventory" table
				And I input "100.00" text in "Price" field of "Inventory" table
				And I finish line editing in "Inventory" table
			If "$SecondLineItem$" Then
					*And I fill demo sales order line
							#Item     = SecondLineItem
							#Quantity = SecondLineQuantity
							#Price    = SecondLinePrice
						
						# KOT demo:
						# - This is a leaf reusable scenario.
						# - Hover [Item], [Quantity], and [Price] to inspect declared parameters and defaults.
						# - The parent scenario calls this block multiple times with different values.
						# - Use "Find references" to inspect both call sites.
						And in the table "Inventory" I click the button named "InventoryAdd"
						And I activate "Product" field in "Inventory" table
						And I input "Demo service" text in "Product" field of "Inventory" table
						And I input "1.000" text in "Quantity" field of "Inventory" table
						And I input "50.00" text in "Price" field of "Inventory" table
						And I finish line editing in "Inventory" table

		And I click "Save" button
	*And I post and validate demo document
			#ExpectedCustomer = Retail demo customer
			#ExpectedItem     = Demo item
		
		And I click "Post and close" button
		And I wait "Sales order *" window closing in 20 seconds
		Then "Sales orders" window is opened
		And I go to line in "List" table
		| 'Customer'         |
		| "Retail demo customer" |
		And I close "Sales orders" window
		Given I open hyperlink "e1cib/list/Catalog.Items"
		Then "Items" window is opened
		And I go to line in "List" table
		| 'Description'  |
		| "Demo item" |
		And I close "Items" window
