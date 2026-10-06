@echo off
rem Startas av Schemalaggaren varje vardag 08:30 och kor granskaren run tills taket eller sandfonstret ar natt.
cd /d "%~dp0.."
for /f "tokens=1-3 delims=-" %%a in ("%date%") do set DAG=%%a-%%b-%%c
call npm run --silent granskaren -- run >> "data\logg\run-%DAG%.log" 2>&1
