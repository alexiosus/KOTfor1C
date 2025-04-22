@echo off

chcp 65001 > nul
setlocal enabledelayedexpansion
REM debug 
REM set BUILD_SOURCESDIRECTORY=D:\git\1cDrive
REM set LastParameters=/Len /DisableStartupMessages /DisableStartupDialogs
REM set DBUser=Administrator
REM set BuildPath=D:\git\1cDrive\build\local_build
REM set AppThin="C:\Program Files (x86)\1cv8\8.3.15.1869\bin\1cv8.exe"
REM set RunSetupFilesTest=0
REM set PSPath=%SystemRoot%\syswow64\WindowsPowerShell\v1.0\powershell.exe -executionpolicy bypass
REM set EmptyInfobasePath=C:\EmptyIB\
REM debug 

echo.
echo Running YAML build...
echo 	Additional variables:
set PathVanessa=%BUILD_SOURCESDIRECTORY%\tools\vanessa\vanessa-automation.epf
echo 		PathVanessa=%PathVanessa%

set LocalSettings=%BuildPath%\yaml_parameters.json
echo copy %BUILD_SOURCESDIRECTORY%\build\develop_parallel\yaml_parameters.json %LocalSettings%  
copy %BUILD_SOURCESDIRECTORY%\build\develop_parallel\yaml_parameters.json %LocalSettings%  
if %errorlevel% neq 0 goto exit_with_error

set BuildPathForwardSlash=%BuildPath:\=/%
call %PSPath% "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" '%LocalSettings%' '#BuildPath' '%BuildPathForwardSlash%'
if %errorlevel% neq 0 goto exit_with_error

set SourcesPathForwardSlash=%BUILD_SOURCESDIRECTORY:\=/%
call %PSPath% "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" '%LocalSettings%' '#SourcesPath' '%SourcesPathForwardSlash%'
if %errorlevel% neq 0 goto exit_with_error

if defined VanessaTestFile set SplitFeatureFiles=True
if not defined SplitFeatureFiles set SplitFeatureFiles=False

call %PSPath% "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" '%LocalSettings%' '#SplitFeatureFiles' '%SplitFeatureFiles%'
if %errorlevel% neq 0 goto exit_with_error

if exist "%LocalSettingsTemp%" del /f /q "%LocalSettingsTemp%"




set VanessaParameters=/IBConnectionString "File=%EmptyInfobasePath%;" /Len /DisableStartupMessages /DisableStartupDialogs
set YamlBuildLogFile=%BuildPath%\yaml_build_log.txt
set YAMLBuildParameters="СобратьСценарии;JsonParams=%LocalSettings%;ResultFile=%BuildPath%\yaml_build_result.txt;LogFile=%YamlBuildLogFile%" 

setlocal enabledelayedexpansion
if not defined DriveTrade set DriveTrade=0
if %DriveTrade% equ 1 (
	echo 	delete tests by tags for Trade version in "%BUILD_SOURCESDIRECTORY%\tests\RegressionTests\yaml\"...	
	echo debug %AppThin% ENTERPRISE %VanessaParameters% /C"Execute;SourceDirectory=%BUILD_SOURCESDIRECTORY%\tests\RegressionTests\yaml\; Extensions=yaml,txt,xml; ErrorFile=%BuildPath%\CutTestsByTags_error.log" /Execute"%BUILD_SOURCESDIRECTORY%\build\DriveTrade\CutCodeByTags.epf"
	%AppThin% ENTERPRISE %VanessaParameters% /C"Execute;SourceDirectory=%BUILD_SOURCESDIRECTORY%\tests\RegressionTests\yaml\; Extensions=yaml,txt,xml; ErrorFile=%BuildPath%\CutTestsByTags_error.log" /Execute"%BUILD_SOURCESDIRECTORY%\build\DriveTrade\CutCodeByTags.epf"
	if %errorlevel% neq 0 goto exit_with_error
	if %errorlevel% neq 1 (
		findstr /c:"Result: failed" "%BuildPath%\CutTestsByTags_error.log" >nul
		findstr /c:"The number" "%BuildPath%\CutTestsByTags_error.log" >nul
	if !errorlevel! neq 1 (
		echo	The number of start tags is not equal to the number of end tags
		goto exit_with_error	
	)
	)
)
endlocal enabledelayedexpansion

echo 	Building YAML files to feature file...
echo 		YAML settings file=%LocalSettings%

%AppThin% ENTERPRISE %VanessaParameters% /Execute "%BUILD_SOURCESDIRECTORY%\build\BuildScenarioBDD.epf"  /C %YAMLBuildParameters%
if %errorlevel% neq 0 (
	if %errorlevel% neq 255	(
		type %YamlBuildLogFile%
		goto exit_with_error
	)
)

if not exist "%BuildPath%\yaml_build_result.txt" goto exit_with_error

findstr /c:"0" "%BuildPath%\yaml_build_result.txt" >nul
if %errorlevel% neq 0 (
		type %YamlBuildLogFile%
		goto exit_with_error
)

if not exist "%BuildPath%\vanessa_error_logs\" (
	md "%BuildPath%\vanessa_error_logs\"
	if %errorlevel% neq 0 goto exit_with_error
)


if not defined RecordGLAccounts (
	echo 	RecordGLAccounts parameter doesn't defined in pipeline parameters
	goto exit_with_error
)

echo Writing parameters from pipeline into tests


REM Задаем директорию, где лежат .feature файлы для обработки
set FeatureFileDir=%BuildPath%\tests\EtalonDrive


REM Проверяем, существует ли директория
if not exist "%FeatureFileDir%" (
    echo WARNING: Feature file directory not found, skipping replacement: %FeatureFileDir%
) else (
    REM Используем FOR /R для рекурсивного обхода файлов *.feature
    REM %%F - переменная, которая будет содержать полный путь к каждому найденному файлу
    FOR /R "%FeatureFileDir%" %%F IN (*.feature) DO (
        echo   Processing feature file: "%%F"
        REM Вызываем PowerShell скрипт для каждого найденного файла
        call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'RecordGLAccountsParameterFromPipeline' '%RecordGLAccounts%'
        call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'AzureProjectNameParameterFromPipeline' '%SYSTEM_TEAM_PROJECT%'
        call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'EMailTestEmailAddressParameterFromPipeline' '%EMailTestEmailAddress%'
		call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'EMailTestPasswordParameterFromPipeline' '%EMailTestPassword%'
		call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'EMailTestIncomingMailServerParameterFromPipeline' '%EMailTestIncomingMailServer%'
		call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'EMailTestIncomingMailPortParameterFromPipeline' '%EMailTestIncomingMailPort%'
		call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'EMailTestOutgoingMailServerParameterFromPipeline' '%EMailTestOutgoingMailServer%'
		call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'EMailTestOutgoingMailPortParameterFromPipeline' '%EMailTestOutgoingMailPort%'
		call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'EMailTestProtocolParameterFromPipeline' '%EMailTestProtocol%'
        REM Опционально: можно добавить проверку errorlevel после каждого вызова
        if %errorlevel% neq 0 (
            echo ERROR during StringReplace for "%%F"
            goto exit_with_error
        )
    )
    echo   Finished writing parameters from pipeline into tests.
)
echo.



echo Writing Trade variable into tests




REM Проверяем, существует ли директория
if not exist "%FeatureFileDir%" (
	echo WARNING: Feature file directory not found, skipping replacement: %FeatureFileDir%
) else (
	if %DriveTrade% equ 1 (
		REM Используем FOR /R для рекурсивного обхода файлов *.feature
		REM %%F - переменная, которая будет содержать полный путь к каждому найденному файлу
		FOR /R "%FeatureFileDir%" %%F IN (*.feature) DO (
			echo   Processing feature file: "%%F"
			REM Вызываем PowerShell скрипт для каждого найденного файла
			call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'DriveTradeParameterFromPipeline' 'Yes'

			REM Опционально: можно добавить проверку errorlevel после каждого вызова
			if %errorlevel% neq 0 (
				echo ERROR during StringReplace for "%%F"
				goto exit_with_error
			)
		)
	) else (
		FOR /R "%FeatureFileDir%" %%F IN (*.feature) DO (
			echo   Processing feature file: "%%F"
			REM Вызываем PowerShell скрипт для каждого найденного файла
			call "%PSPath%" "%BUILD_SOURCESDIRECTORY%\build\StringReplace.ps1" "%%F" 'DriveTradeParameterFromPipeline' 'No'

			REM Опционально: можно добавить проверку errorlevel после каждого вызова
			if %errorlevel% neq 0 (
				echo ERROR during StringReplace for "%%F"
				goto exit_with_error
			)
		)
	)
	echo   Finished writing Trade variable into tests
)
echo.



set FeatureFile1=%BuildPath%\tests\EtalonDrive\001_Company_tests.feature
echo Checking for %FeatureFile1%
if exist "%FeatureFile1%" (
    echo   Found. Delete step 'And I close all client application windows' from 001_Company.feature
    REM Вызываем 1С, убедившись, что %AppThin% в кавычках, если путь содержит пробелы
    %AppThin% ENTERPRISE %VanessaParameters% /EXECUTE "%BUILD_SOURCESDIRECTORY%\build\RepairTestFile.epf" /C"TestFile=%FeatureFile1%"/Len
    if %errorlevel% neq 0 (
        echo ERROR during RepairTestFile for %FeatureFile1%
        goto exit_with_error
    ) else (
        echo   Repaired %FeatureFile1% successfully.
    )
) else (
    echo   Skipped: %FeatureFile1% not found.
)
echo.


set FeatureFile2=%BuildPath%\tests\EtalonDrive\I_start_my_first_launch.feature
echo Checking for %FeatureFile2%
if exist "%FeatureFile2%" (
    echo   Found. Delete step 'And I close all client application windows' from I_start_my_first_launch.feature
    %AppThin% ENTERPRISE %VanessaParameters% /EXECUTE "%BUILD_SOURCESDIRECTORY%\build\RepairTestFile.epf" /C"TestFile=%FeatureFile2%"/Len
    if %errorlevel% neq 0 (
        echo ERROR during RepairTestFile for %FeatureFile2%
        goto exit_with_error
    ) else (
        echo   Repaired %FeatureFile2% successfully.
    )
) else (
    echo   Skipped: %FeatureFile2% not found.
)
echo.


set FeatureFile3=%BuildPath%\tests\EtalonDrive\I_start_my_first_launch_templates.feature
echo Checking for %FeatureFile3%
if exist "%FeatureFile3%" (
    echo   Found. Delete step 'And I close all client application windows' from I_start_my_first_launch_templates.feature
    %AppThin% ENTERPRISE %VanessaParameters% /EXECUTE "%BUILD_SOURCESDIRECTORY%\build\RepairTestFile.epf" /C"TestFile=%FeatureFile3%"/Len
    if %errorlevel% neq 0 (
        echo ERROR during RepairTestFile for %FeatureFile3%
        goto exit_with_error
    ) else (
        echo   Repaired %FeatureFile3% successfully.
    )
) else (
    echo   Skipped: %FeatureFile3% not found.
)
echo.


echo 	YAML builded succesfully



:exit_no_error
exit /b 0

:exit_with_error
exit /b 1

