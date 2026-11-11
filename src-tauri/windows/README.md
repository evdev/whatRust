# Instalador Windows

Template original do Tauri CLI 2.12.3, sob as licenças MIT/Apache-2.0 do projeto Tauri:
https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

SHA-256 do original: `8ae02c66f8adb4a0d15d97f984fbacd2b44262d8a4d03fefaf6177f67f7008e5`.

Únicas alterações funcionais: adicionar `--show` à execução da página final e à opção silenciosa `/R`, e no ARM64 ler o WebView2 nativo com `SetRegView 64` e `${IsNativeARM64}`. O instalador NSIS continua x86; `${RunningX64}` nesse caso aponta para `WOW6432Node`, que não tem o runtime ARM64. A execução usa o mesmo RunAsUser do Tauri. Autostart, atalhos e instalações sem a opção Executar não mudam. Ao atualizar o CLI, comparar o template original e reaplicar essas alterações.
