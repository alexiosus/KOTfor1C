param(
    [Parameter(Mandatory=$true)][ValidateSet('Inspect','Convert')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$SourceDirectory,
    [Parameter(Mandatory=$true)][string]$ExternalDirectory,
    [Parameter(Mandatory=$true)][string]$Manifest,
    [Parameter(Mandatory=$true)][ValidatePattern('^[\p{L}_][\p{L}\p{N}_]*$')][string]$Name
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$kotSource = Join-Path $SourceDirectory 'DataProcessors'
$kotRoot = Join-Path $kotSource ($Name + '.xml')
$kotDocument = [System.Xml.XmlDocument]::new()
$kotDocument.XmlResolver = $null
$kotDocument.Load($kotRoot)
$kotOld = $kotDocument.DocumentElement.SelectSingleNode('*[local-name()="DataProcessor"]')
if ($null -eq $kotOld) { throw 'The selected configuration does not contain the SPPR compiler data processor.' }
$kotProperties = $kotOld.SelectSingleNode('*[local-name()="Properties"]')
if ($kotProperties.SelectSingleNode('*[local-name()="Name"]').InnerText -ne $Name) { throw 'Unexpected compiler metadata name.' }
$kotChildren = @($kotOld.SelectNodes('*[local-name()="ChildObjects"]/*[local-name()="Form" or local-name()="Template"]'))
if ($Mode -eq 'Inspect') {
    $kotNames = @($kotChildren | ForEach-Object {
        if ($_.InnerText -notmatch '^[\p{L}_][\p{L}\p{N}_]*$') { throw 'Invalid compiler child name.' }
        'DataProcessor.' + $Name + '.' + $_.LocalName + '.' + $_.InnerText
    })
    [IO.File]::WriteAllText($Manifest, (ConvertTo-Json -InputObject @($kotNames) -Compress), [Text.UTF8Encoding]::new($false))
    exit 0
}
foreach ($kotChild in $kotChildren) {
    $kotKind = if ($kotChild.LocalName -eq 'Form') { 'Forms' } else { 'Templates' }
    if (-not (Test-Path -LiteralPath (Join-Path $kotSource ($Name + '/' + $kotKind + '/' + $kotChild.InnerText + '.xml')) -PathType Leaf)) {
        throw 'The compiler child metadata was not exported completely.'
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $kotSource ($Name + '/Ext/ObjectModule.bsl')) -PathType Leaf)) { throw 'The compiler object module is missing.' }
Copy-Item -LiteralPath $kotRoot -Destination (Join-Path $ExternalDirectory ($Name + '.xml'))
Copy-Item -LiteralPath (Join-Path $kotSource $Name) -Destination $ExternalDirectory -Recurse
$kotNew = $kotDocument.CreateElement('ExternalDataProcessor', $kotOld.NamespaceURI)
foreach ($kotAttribute in $kotOld.Attributes) { [void]$kotNew.Attributes.Append($kotAttribute.CloneNode($true)) }
foreach ($kotChild in @($kotOld.ChildNodes)) { [void]$kotNew.AppendChild($kotChild.CloneNode($true)) }
[void]$kotDocument.DocumentElement.ReplaceChild($kotNew, $kotOld)
$kotInternal = $kotNew.SelectSingleNode('*[local-name()="InternalInfo"]')
foreach ($kotType in @($kotInternal.ChildNodes)) {
    if ($kotType.GetAttribute('category') -eq 'Manager') { [void]$kotInternal.RemoveChild($kotType) }
}
$kotContained = $kotDocument.CreateElement('xr', 'ContainedObject', 'http://v8.1c.ru/8.3/xcf/readable')
foreach ($kotPair in @(@('ClassId', 'c3831ec8-d8d5-4f93-8a22-f9bfae07327f'), @('ObjectId', [Guid]::NewGuid().ToString()))) {
    $kotPart = $kotDocument.CreateElement('xr', $kotPair[0], 'http://v8.1c.ru/8.3/xcf/readable')
    $kotPart.InnerText = $kotPair[1]; [void]$kotContained.AppendChild($kotPart)
}
[void]$kotInternal.PrependChild($kotContained)
$kotProperties = $kotNew.SelectSingleNode('*[local-name()="Properties"]')
foreach ($kotProperty in @($kotProperties.ChildNodes)) {
    if ($kotProperty.LocalName -notin @('Name','Synonym','Comment','DefaultForm','AuxiliaryForm')) { [void]$kotProperties.RemoveChild($kotProperty) }
}
$kotDocument.Save((Join-Path $ExternalDirectory ($Name + '.xml')))
foreach ($kotFile in Get-ChildItem -LiteralPath $ExternalDirectory -Filter '*.xml' -Recurse -File) {
    $kotText = [IO.File]::ReadAllText($kotFile.FullName).Replace('DataProcessorObject.' + $Name, 'ExternalDataProcessorObject.' + $Name).Replace('DataProcessor.' + $Name, 'ExternalDataProcessor.' + $Name)
    [IO.File]::WriteAllText($kotFile.FullName, $kotText, [Text.UTF8Encoding]::new($false))
}
$kotManager = Join-Path $ExternalDirectory ($Name + '/Ext/ManagerModule.bsl')
if (Test-Path -LiteralPath $kotManager) { Remove-Item -LiteralPath $kotManager }
