@echo off
set PATH=C:\Program Files\nodejs;%PATH%
cd /d C:\Users\vandarn\Documents\databridge\backend
"C:\Program Files\nodejs\node.exe" "C:\Users\vandarn\Documents\databridge\backend\node_modules\ts-node\dist\bin.js" --project tsconfig.json src\index.ts
