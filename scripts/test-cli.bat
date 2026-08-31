@echo off
cd /d "E:\AI Folder Projects\arbiter"
echo Running minimal test...
tinyfish agent run --async --pretty --url "https://example.com" --max-duration-seconds 60 "Extract the page title as JSON: {\"title\": \"string\"}" 2>&1
echo Exit code: %ERRORLEVEL%
