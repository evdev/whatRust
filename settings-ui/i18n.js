"use strict";
// Interface language for the local pages (settings, lock screen, shell).
//
// English is the source language: the HTML and scripts are written in English
// and PT maps each English string to Portuguese. With Portuguese selected,
// text nodes and a few attributes whose (whitespace-collapsed) text is a key
// are rewritten, including nodes added later by scripts, so code that does
// `el.textContent = "Save"` needs no change. Strings with variable parts go
// through t("Open {0}", [name]). A string without an entry is shown as written.
// The start language is injected by Rust as window.__WR_LANG; the settings
// page switches it live with I18n.setLang().
(function (root) {
  var PT = {
    "whatRust — Settings": "whatRust — Configurações",
    "whatRust — Locked": "whatRust — Bloqueado",
    "Settings": "Configurações",
    "Back to WhatsApp": "Voltar ao WhatsApp",
    "Accounts": "Contas",
    "Notifications": "Notificações",
    "Appearance": "Aparência",
    "Security": "Segurança",
    "Startup": "Inicialização",
    "Shortcuts": "Atalhos",
    "Network": "Rede",
    "Proxy": "Proxy",
    "Routes all WhatsApp account traffic through a proxy.": "Encaminha todo o tráfego das contas do WhatsApp por um proxy.",
    "Off": "Desativado",
    "Host": "Servidor",
    "Port": "Porta",
    "Proxies that need a username and password are not supported: the built-in browser engines do not accept credentials this way. Changes take effect after restarting whatRust.": "Proxy com usuário e senha não é suportado: os navegadores embutidos não aceitam credenciais por esse caminho. A alteração vale após reiniciar o whatRust.",
    "Restart whatRust to apply the proxy.": "Reinicie o whatRust para aplicar o proxy.",
    "Restart now": "Reiniciar agora",
    "Diagnostics": "Diagnóstico",
    "Account on startup": "Conta ao iniciar",
    "New account name": "Nome da nova conta",
    "Add": "Adicionar",
    "Multiple accounts require macOS 14 or later.": "Múltiplas contas exigem macOS 14 ou superior.",
    "Show all accounts in one window": "Mostrar todas as contas em uma janela",
    "One window with an account switcher. An account loads only when you open it, and opening another does not close the first. Requires restarting whatRust.": "Uma janela com um seletor de contas. Uma conta só carrega quando você a abre, e abrir outra não fecha a primeira. Requer reiniciar o whatRust.",
    "Restart whatRust to apply the change.": "Reinicie o whatRust para aplicar a mudança.",
    "Restart whatRust to apply. Menu-bar-only mode takes priority over this option.": "Reinicie o whatRust para aplicar. O modo somente barra de menus tem prioridade sobre esta opção.",
    "Please wait…": "Aguarde…",
    "Actions for {0}": "Ações de {0}",
    "Open account": "Abrir conta",
    "Return to the main window": "Reintegrar à janela",
    "Open in a separate window": "Abrir em janela separada",
    "Use on startup": "Usar ao iniciar",
    "Rename": "Renomear",
    "Rename account": "Renomear conta",
    "Enter a name.": "Informe um nome.",
    "Move up": "Mover para cima",
    "Move down": "Mover para baixo",
    "Remove account": "Remover conta",
    "This account's local session will be deleted. To use it again, you will need to scan the QR code.": "A sessão local desta conta será apagada. Para usá-la novamente, você precisará ler o QR code.",
    "Remove \"{0}\"?": "Remover \"{0}\"?",
    "Remove": "Remover",
    "Open {0}": "Abrir {0}",
    "In a separate window": "Em janela separada",
    "{0} unread chats": "{0} conversas não lidas",
    "Options for {0}": "Opções de {0}",
    "Could not load the accounts: {0}": "Não foi possível carregar as contas: {0}",
    "Updates": "Atualizações",
    "Check for updates automatically": "Verificar atualizações automaticamente",
    "Asks GitHub (api.github.com) a minute after start and every 6 hours which version is the newest. Nothing else is sent.": "Consulta o GitHub (api.github.com) um minuto após iniciar e a cada 6 horas. Só pergunta qual é a versão mais recente.",
    "Install updates automatically": "Instalar atualizações automaticamente",
    "Only acts where no password is needed.": "Só age quando não é preciso senha.",
    "Installed version": "Versão instalada",
    "Check now": "Verificar agora",
    "Install type": "Tipo de instalação",
    "Last check": "Última verificação",
    "Download and install": "Baixar e instalar",
    "Restart and install": "Reiniciar e instalar",
    "View on GitHub": "Ver no GitHub",
    "Copy": "Copiar",
    "What's new": "Novidades",
    "Versions 0.6.10 and older cannot update themselves: install this version by hand once. Every downloaded file is checked against the checksum (SHA-256) published with the release before it is installed.": "Versões 0.6.10 e anteriores não atualizam sozinhas: instale esta versão manualmente uma vez. Cada arquivo baixado é conferido com a soma de verificação (SHA-256) publicada na versão antes de ser instalado.",
    "Never": "Nunca",
    "Downloads, verifies and replaces the app in the background. The new version starts the next time you open whatRust.": "Baixa, confere e substitui o aplicativo em segundo plano. A nova versão começa na próxima vez que você abrir o whatRust.",
    "Downloads and verifies in the background. The installer runs when you click Restart and install, because it restarts whatRust.": "Baixa e confere em segundo plano. O instalador roda quando você clica em Reiniciar e instalar, porque ele reinicia o whatRust.",
    "Does not apply to this install type: it needs a password or is updated by another tool. You install with one click.": "Não se aplica a este tipo de instalação: ela precisa de senha ou é atualizada por outra ferramenta. Você instala com um clique.",
    "Looking for updates…": "Procurando atualizações…",
    "You are on the latest version": "Você está na versão mais recente",
    "Version {0} is available": "A versão {0} está disponível",
    "Could not look for updates": "Não foi possível procurar atualizações",
    "This release has no file for your install type.": "Esta versão não tem um arquivo para o seu tipo de instalação.",
    "Downloading version {0}…": "Baixando a versão {0}…",
    "{0} MB of {1} MB": "{0} MB de {1} MB",
    "{0} MB": "{0} MB",
    "Installing version {0}…": "Instalando a versão {0}…",
    "Enter your administrator password when the system asks.": "Digite sua senha de administrador quando o sistema pedir.",
    "Version {0} is ready to install": "A versão {0} está pronta para instalar",
    "The installer has been downloaded and verified. whatRust will close and open again when it installs.": "O instalador já foi baixado e conferido. O whatRust vai fechar e abrir de novo ao instalar.",
    "Version {0} was installed": "A versão {0} foi instalada",
    "Restart whatRust to use the new version.": "Reinicie o whatRust para usar a nova versão.",
    "The installer has taken over. whatRust will close and open again by itself.": "O instalador assumiu. O whatRust vai fechar e abrir de novo sozinho.",
    "File downloaded and verified": "Arquivo baixado e conferido",
    "The package was opened in your system's software center; confirm the installation there. If nothing opens, run the command below.": "O pacote foi aberto na central de programas do sistema; confirme a instalação lá. Se nada abrir, execute o comando abaixo.",
    "The file was opened. Finish the installation there.": "O arquivo foi aberto. Termine a instalação por lá.",
    "Asks for your administrator password when installing.": "Pede sua senha de administrador ao instalar.",
    "Download and open": "Baixar e abrir",
    "Copied ✓": "Copiado ✓",
    "Select and copy": "Selecione e copie",
    "Receive notifications": "Receber notificações",
    "Turns on whatRust message alerts.": "Ativa os avisos de mensagens do whatRust.",
    "Notify while the app is open": "Avisar com o aplicativo aberto",
    "Get alerts even when the window is in the foreground.": "Receber avisos mesmo com a janela em primeiro plano.",
    "Notify in the chat I am reading": "Avisar na conversa que estou lendo",
    "Also alert for new messages in the open chat.": "Também avisar mensagens novas na conversa aberta.",
    "Respect muted chats": "Respeitar conversas silenciadas",
    "When muting cannot be confirmed, the additional detector stays silent.": "Quando o silenciamento não puder ser confirmado, o detector adicional permanece silencioso.",
    "Mentions, replies, and direct messages": "Menções, respostas e mensagens diretas",
    "Does not alert on @everyone": "Não avisa em @everyone",
    "Alert sound": "Som do alerta",
    "Plays the distinct sound. With the popup off, the ordinary whatRust alert still appears.": "Toca o som distinto. Com o popup desligado, o aviso normal do whatRust continua.",
    "Sound file": "Arquivo do som",
    "Built-in sound": "Som incluso",
    "Custom sound": "Som personalizado",
    "Choose sound…": "Escolher som…",
    "That file is not a supported audio file.": "O arquivo não é um áudio aceito.",
    "The audio is larger than 5 MB.": "O áudio tem mais de 5 MB.",
    "The file is larger than 8 MB.": "O arquivo tem mais de 8 MB.",
    "The voice note is larger than 2 MB.": "O áudio tem mais de 2 MB.",
    "Attach a file": "Anexar arquivo",
    "Record a voice note": "Gravar áudio",
    "Remove the file": "Remover arquivo",
    "Stop recording": "Parar gravação",
    "Cancel the recording": "Cancelar gravação",
    "The microphone is not available.": "O microfone não está disponível.",
    "Voice notes cannot include a caption. Remove the text or clear the recording.": "Notas de voz não aceitam legenda. Apague o texto ou descarte a gravação.",
    "Could not store the sound.": "Não foi possível guardar o som.",
    "Reply popup": "Popup de resposta",
    "Shows the message and lets you reply. Replaces the ordinary alert for that message.": "Mostra a mensagem e permite responder. Substitui o aviso normal dessa mensagem.",
    "Alerts even in a muted chat and while the app is in the foreground.": "Avisa mesmo com a conversa silenciada e com o aplicativo em primeiro plano.",
    "With the sound and the popup off, this alert does nothing.": "Com o som e o popup desligados, este alerta não faz nada.",
    "Close": "Fechar",
    "Write a reply": "Escreva uma resposta",
    "Write a reply.": "Escreva uma resposta.",
    "Send": "Enviar",
    "New message": "Nova mensagem",
    "Could not send.": "Não foi possível enviar.",
    "WhatsApp is still opening. Try again.": "O WhatsApp ainda está abrindo. Tente de novo.",
    "The reply is too long.": "A resposta é longa demais.",
    "That account is not available.": "Conta indisponível.",
    "The additional detector only uses identifiable new messages. Muted chats, history and unknown states do not produce additional alerts.": "O detector adicional só usa mensagens novas identificáveis. Conversas silenciadas, histórico e estados desconhecidos não geram avisos adicionais.",
    "Voice notes": "Notas de voz",
    "Transcription": "Transcrição",
    "Transcribe videos": "Transcrever vídeos",
    "Shows a button on each video. The audio stays on this computer and is transcribed by FluidVoice.": "Mostra um botão em cada vídeo. O áudio fica neste computador e é transcrito pelo FluidVoice.",
    "Transcribe voice notes": "Transcrever notas de voz",
    "Shows the transcript under each voice note. The audio stays on this computer and is transcribed by FluidVoice.": "Mostra a transcrição embaixo de cada nota de voz. O áudio fica neste computador e é transcrito pelo FluidVoice.",
    "FluidVoice port": "Porta do FluidVoice",
    "FluidVoice's local API. The default is 47733.": "API local do FluidVoice. O padrão é 47733.",
    "Connection": "Conexão",
    "Not checked yet.": "Ainda não verificada.",
    "Test connection": "Testar conexão",
    "Checking…": "Verificando…",
    "FluidVoice on Windows": "FluidVoice no Windows",
    "Optional. Opens the official Windows beta installer. FluidVoice is a separate app.": "Opcional. Abre o instalador oficial da versão beta para Windows. O FluidVoice é um aplicativo separado.",
    "Install FluidVoice": "Instalar FluidVoice",
    "FluidVoice did not respond. Transcription uses that separate app, and the Windows version is still in beta. Open the official installer? Then turn on the local API in FluidVoice.": "O FluidVoice não respondeu. A transcrição usa esse aplicativo separado, e a versão para Windows ainda é beta. Abrir o instalador oficial? Depois, ative a API local no FluidVoice.",
    "FluidVoice is a separate app, and the Windows version is still in beta. whatRust opens the official installer in the browser. Then turn on the local API in FluidVoice.": "O FluidVoice é um aplicativo separado, e a versão para Windows ainda é beta. O whatRust abre o instalador oficial no navegador. Depois, ative a API local no FluidVoice.",
    "Install FluidVoice?": "Instalar o FluidVoice?",
    "Open installer": "Abrir instalador",
    "Translate transcripts": "Traduzir transcrições",
    "Sends only the transcript text to the chosen provider.": "Envia só o texto da transcrição para o provedor escolhido.",
    "Translation language": "Idioma da tradução",
    "AI provider": "Provedor de IA",
    "OpenRouter": "OpenRouter",
    "Gemini": "Gemini",
    "Anthropic": "Anthropic",
    "Model": "Modelo",
    "Translation model": "Modelo da tradução",
    "Summary model": "Modelo do resumo",
    "Model name accepted by that provider.": "Nome do modelo aceito por esse provedor.",
    "Used by the Summarize button on each transcript and by chat summaries.": "Usado pelo botão Resumir em cada transcrição e pelos resumos de conversa.",
    "Chat summaries": "Resumos de conversa",
    "Not allowed yet.": "Ainda não permitido.",
    "Allowed on this computer.": "Permitido neste computador.",
    "Revoke": "Revogar",
    "Main models available for this key.": "Modelos principais disponíveis para esta chave.",
    "Loading models…": "Carregando modelos…",
    "Save the API key to list models.": "Guarde a chave da API para listar os modelos.",
    "The models could not be listed.": "Não foi possível listar os modelos.",
    "No main model is available for this key.": "Nenhum modelo principal disponível para esta chave.",
    "API key": "Chave da API",
    "No key saved.": "Nenhuma chave guardada.",
    "Key saved on this computer.": "Chave guardada neste computador.",
    "Save key": "Guardar chave",
    "Remove key": "Remover chave",
    "Checking the key…": "Verificando a chave…",
    "Enter the API key.": "Digite a chave da API.",
    "The API key was not accepted.": "A chave da API não foi aceita.",
    "This provider's saved key will be deleted from this computer.": "A chave guardada deste provedor será apagada deste computador.",
    "This provider's key was removed from this computer.": "A chave deste provedor foi removida deste computador.",
    "The provider rejected the key.": "A chave foi recusada pelo provedor.",
    "The account is out of credits or payment is required.": "A conta está sem créditos ou o pagamento é exigido.",
    "This key's quota or usage limit is used up.": "A cota ou o limite de uso desta chave se esgotou.",
    "The model or feature is not available for this key.": "O modelo ou o recurso não está disponível para esta chave.",
    "The provider did not accept the request.": "O provedor não aceitou o pedido.",
    "The provider could not be reached.": "Não foi possível contactar o provedor.",
    "The request to the provider timed out.": "O pedido ao provedor expirou.",
    "Key saved.": "Chave guardada.",
    "Key saved. The provider accepted the key.": "Chave guardada. O provedor aceitou a chave.",
    "Key saved. No main model is available for this key.": "Chave guardada. Nenhum modelo principal está disponível para esta chave.",
    "Key saved. {0} main models available.": "Chave guardada. {0} modelos principais disponíveis.",
    "The key stays on this computer and never enters the WhatsApp page. Translation and the Summarize button each use the model chosen for them. A chat summary stays on this computer, not on the phone, and is not sent into the chat.": "A chave fica neste computador e nunca entra na página do WhatsApp. A tradução e o botão Resumir usam o modelo escolhido para cada um. Um resumo de conversa fica neste computador, não no telefone, e não é enviado no chat.",
    "Behavior": "Comportamento",
    "Keep running in the background when closed": "Continuar em segundo plano ao fechar",
    "With one account open, closing the window leaves it connected. With more than one, closing a window ends just that account": "Com uma conta aberta, fechar a janela a deixa conectada. Com mais de uma, fechar uma janela encerra só essa conta",
    "Start minimized": "Iniciar minimizado",
    "Start without opening the main window": "Iniciar sem abrir a janela principal",
    "Start with the system": "Iniciar com o sistema",
    "Show icon in the menu bar": "Mostrar ícone na barra de menus",
    "When off, click the Dock icon to open whatRust": "Quando desativado, clique no ícone do Dock para abrir o whatRust",
    "Start minimized with Windows": "Iniciar minimizado com o Windows",
    "Applies only at Windows sign-in. When opened from a shortcut, the window always appears.": "Vale apenas ao entrar no Windows. Ao abrir pelo atalho, a janela sempre aparece.",
    "Source device": "Aparelho de origem",
    "An icon next to the time shows an Apple device, Android, or a computer, when the message id gives a good indication.": "Um ícone ao lado do horário indica um aparelho Apple, um Android ou um computador, quando o identificador da mensagem permite.",
    "App icon": "Ícone do aplicativo",
    "Custom": "Personalizado",
    "Choose PNG…": "Escolher PNG…",
    "Reset to default": "Restaurar padrão",
    "Square PNG image, 32 to 1024 px and up to 5 MB. Applies to the whole app; the tray icon does not change. On Linux with Wayland the window icon comes from the .desktop file and does not change.": "Imagem PNG quadrada, de 32 a 1024 px e até 5 MB. Vale para o aplicativo todo; a bandeja não muda. No Linux com Wayland, o ícone da janela vem do arquivo .desktop e não muda.",
    "Download folder": "Pasta de downloads",
    "System Downloads folder": "Pasta Downloads do sistema",
    "Choose folder…": "Escolher pasta…",
    "Reset to Downloads": "Restaurar Downloads",
    "Interface size": "Tamanho da interface",
    "Title bar": "Barra de título",
    "Tiling window managers such as Hyprland don't use a title bar.": "Gerenciadores de janelas lado a lado, como o Hyprland, não usam barra de título.",
    "Detected: {0}. In automatic mode the bar is hidden.": "Detectado: {0}. No modo automático a barra fica oculta.",
    "Automatic": "Automático",
    "Show": "Mostrar",
    "Hide": "Ocultar",
    "Adjusts the size of WhatsApp without changing the other accounts.": "Ajusta o tamanho do WhatsApp sem alterar as outras contas.",
    "Very small": "Muito pequeno",
    "Small": "Pequeno",
    "Default": "Padrão",
    "Large": "Grande",
    "Menu bar only": "Somente na barra de menus",
    "No Dock icon or main window. The open account stays connected while the panel is closed; other accounts load when you open them": "Sem ícone no Dock nem janela principal. A conta aberta continua conectada com o painel fechado; as outras carregam quando você as abre",
    "The tray icon is the only entry point in menu-bar-only mode, so it stays visible": "O ícone da bandeja é o único ponto de entrada no modo somente barra de menus, por isso permanece visível",
    "Requires macOS 14 (Sonoma) or later — this Mac cannot keep a hidden panel connected": "Requer macOS 14 (Sonoma) ou superior — este Mac não consegue manter um painel oculto conectado",
    "Hide Dock icon": "Ocultar ícone do Dock",
    "Keeps the main window; the menu bar icon becomes the way to reopen whatRust": "Mantém a janela principal; o ícone da barra de menus passa a ser a forma de reabrir o whatRust",
    "Language": "Idioma",
    "Language of the whatRust interface.": "Idioma da interface do whatRust.",
    "Shortcut to show or hide": "Atalho para mostrar ou ocultar",
    "A key combination to show or hide the app": "Uma combinação de teclas para mostrar ou ocultar o aplicativo",
    "Shortcut": "Atalho",
    "Record": "Gravar",
    "Privacy blur shortcut": "Atalho para desfocar",
    "Turns the privacy blur on or off in every account. To choose what gets blurred, press Ctrl+Shift+P (⌘+Shift+P on a Mac) in a WhatsApp window.": "Liga ou desliga o desfoque de privacidade em todas as contas. Para escolher o que é desfocado, pressione Ctrl+Shift+P (⌘+Shift+P no Mac) numa janela do WhatsApp.",
    "On Linux/Wayland, set": "No Linux/Wayland, configure",
    "in the system shortcuts.": "nos atalhos do sistema.",
    "Press the keys… (Esc cancels)": "Pressione as teclas… (Esc cancela)",
    "Unsupported key. Try another.": "Tecla não suportada. Tente outra.",
    "Include Ctrl, Alt or Shift.": "Inclua Ctrl, Alt ou Shift.",
    "Password": "Senha",
    "At least 6 characters": "Pelo menos 6 caracteres",
    "At least 6 characters.": "Pelo menos 6 caracteres.",
    "Confirm": "Confirmar",
    "Turn on lock": "Ativar bloqueio",
    "Use biometrics": "Usar biometria",
    "Use {0}": "Usar {0}",
    "Lock on launch": "Bloquear ao iniciar",
    "Lock when hidden": "Bloquear ao ocultar",
    "Lock when idle": "Bloquear por inatividade",
    "Minutes; 0 turns it off": "Minutos; 0 desativa",
    "Lock now": "Bloquear agora",
    "Change password…": "Alterar senha…",
    "Turn off…": "Desativar…",
    "The lock protects access to the whatRust windows. It": "O bloqueio protege o acesso às janelas do whatRust. Ele",
    "does not": "não",
    "encrypt the data on disk.": "criptografa os dados no disco.",
    "Could not turn on the lock": "Não foi possível ativar o bloqueio",
    "Could not lock": "Não foi possível bloquear",
    "Current password": "Senha atual",
    "Continue": "Continuar",
    "Enter your current password.": "Informe sua senha atual.",
    "New password": "Nova senha",
    "Change": "Alterar",
    "Enter a new password.": "Informe uma nova senha.",
    "Your lock password was changed.": "Sua senha de bloqueio foi alterada.",
    "Password changed": "Senha alterada",
    "Could not change the password": "Não foi possível alterar a senha",
    "Enter your current password to turn off the lock.": "Informe sua senha atual para desativar o bloqueio.",
    "Turn off lock": "Desativar bloqueio",
    "Turn off": "Desativar",
    "Could not turn off the lock": "Não foi possível desativar o bloqueio",
    "Could not change biometrics": "Não foi possível alterar a biometria",
    "Could not save": "Não foi possível salvar",
    "Notification diagnostics": "Diagnóstico de notificações",
    "Check Windows alerts": "Verificar avisos do Windows",
    "The test confirms sending; check that Windows shows the banner.": "O teste confirma o envio; confira se o Windows exibe o banner.",
    "Test": "Testar",
    "Permissions and Do Not Disturb": "Permissões e Não perturbe",
    "Open in Windows": "Abrir no Windows",
    "Activity this session": "Atividade desta sessão",
    "Time, account and result only. Message text is not stored.": "Somente horário, conta e resultado. Não armazena o texto das mensagens.",
    "Waiting to send": "Aguardando envio",
    "Sent to Windows; display not confirmed": "Enviada ao Windows; exibição não confirmada",
    "Send failed": "Falha no envio",
    "Not sent": "Não enviada",
    "Alert opened": "Aviso aberto",
    "Alert dismissed": "Aviso encerrado",
    "App locked": "Aplicativo bloqueado",
    "Notifications off": "Notificações desativadas",
    "Foreground alerts off": "Avisos em primeiro plano desativados",
    "Active chat": "Conversa ativa",
    "Muted chat": "Conversa silenciada",
    "Mute state not confirmed": "Silenciamento não confirmado",
    "Windows rejected the send": "Windows recusou o envio",
    "Native capture active": "Captura nativa ativa",
    "Native capture unavailable; fallback bridge": "Captura nativa indisponível; ponte alternativa",
    "Integrated controls": "Controles integrados",
    "Access from the window menu": "Acesso pelo menu da janela",
    "Additional detector available when reliable signals exist": "Detector adicional disponível quando houver sinais confiáveis",
    "Waiting for a compatible chat": "Aguardando conversa compatível",
    "No alerts recorded": "Nenhum aviso registrado",
    "Upcoming events will appear here during this run.": "Os próximos eventos aparecerão aqui durante esta execução.",
    "Save": "Salvar",
    "Changes saved ✓": "Alterações salvas ✓",
    "Changes saved": "Alterações salvas",
    "Saved with a note: {0}": "Salvo com observação: {0}",
    "Go back without saving?": "Voltar sem salvar?",
    "Your changes have not been saved.": "As alterações ainda não foram salvas.",
    "Back": "Voltar",
    "whatRust controls": "Controles do whatRust",
    "whatRust settings": "Configurações do whatRust",
    "Switch WhatsApp account": "Trocar conta do WhatsApp",
    "Choose an account to continue": "Escolha uma conta para continuar",
    "Use the selector above to open a WhatsApp, or settings to manage your accounts.": "Use o seletor acima para abrir um WhatsApp ou as configurações para gerenciar suas contas.",
    "Enter your password to access your WhatsApp accounts.": "Digite sua senha para acessar suas contas do WhatsApp.",
    "Enter your password": "Digite sua senha",
    "Enter your password.": "Digite sua senha.",
    "Unlock": "Desbloquear",
    "Forgot your password? Reset…": "Esqueceu a senha? Redefinir…",
    "Wrong password. Try again.": "Senha incorreta. Tente novamente.",
    "Could not unlock. Try again.": "Não foi possível desbloquear. Tente novamente.",
    "Could not confirm biometrics. Enter your password.": "Não foi possível confirmar a biometria. Digite sua senha.",
    "Too many attempts. Try again in {0}s.": "Muitas tentativas. Tente de novo em {0}s.",
    "This signs out every account in this app and removes the lock. You will need to link WhatsApp again with the QR code. Your chats stay on your phone.": "Isso desconecta todas as contas deste aplicativo e remove o bloqueio. Você precisará vincular o WhatsApp novamente pelo QR Code. Suas conversas continuam no celular.",
    "Reset whatRust?": "Redefinir o whatRust?",
    "Reset": "Redefinir",
    "Could not reset the app. Try again.": "Não foi possível redefinir o aplicativo. Tente novamente.",
    "Cancel": "Cancelar",
    "This field cannot be empty.": "Este campo não pode ficar vazio.",
    "Stand-in": "Stand-in",
    "Allow stand-in": "Allow stand-in",
    "Each individual chat stays off until you turn it on there.": "Each individual chat stays off until you turn it on there.",
    "How to reply": "How to reply",
    "The API key above, or a program you have already signed in to.": "The API key above, or a program you have already signed in to.",
    "Claude Code": "Claude Code",
    "Grok": "Grok",
    "Codex": "Codex",
    "Hermes": "Hermes",
    "Grok Bot": "Grok Bot",
    "Hermes address": "Hermes address",
    "A private address on this network, for example http://192.168.1.20:8642. The profile on that computer should be one created for stand-in.": "A private address on this network, for example http://192.168.1.20:8642. The profile on that computer should be one created for stand-in.",
    "Hermes key": "Hermes key",
    "Stored on this computer, not in settings and not in WhatsApp.": "Stored on this computer, not in settings and not in WhatsApp.",
    "A key is stored on this computer, not in settings and not in WhatsApp.": "A key is stored on this computer, not in settings and not in WhatsApp.",
    "Grok Bot webhook": "Grok Bot webhook",
    "Grok Bot webhook key": "Grok Bot webhook key",
    "No webhook saved yet.": "No webhook saved yet.",
    "Webhook address": "Webhook address",
    "Webhook key": "Webhook key",
    "Key": "Key",
    "Save webhook": "Save webhook",
    "Remove webhook": "Remove webhook",
    "Copy instructions": "Copy instructions",
    "Could not copy. Select the instructions and copy them.": "Não foi possível copiar. Selecione as instruções e copie.",
    "Webhook host: {0}.": "Servidor do webhook: {0}.",
    "In Grok Bot, make a routine with a webhook and no schedule. Paste its address and key here. Paste the instructions below into the routine, and allow that routine to run commands on this computer. Each reply is one run of that routine.": "In Grok Bot, make a routine with a webhook and no schedule. Paste its address and key here. Paste the instructions below into the routine, and allow that routine to run commands on this computer. Each reply is one run of that routine.",
    "Agent wait": "Agent wait",
    "Seconds to wait for one run, from 30 to 300.": "Seconds to wait for one run, from 30 to 300.",
    "Agent runs per hour": "Agent runs per hour",
    "Including runs that stay quiet. After that the stand-in pauses.": "Including runs that stay quiet. After that the stand-in pauses.",
    "In this install, the command-line programs are not available. The API key, Hermes, and Grok Bot still work.": "In this install, the command-line programs are not available. The API key, Hermes, and Grok Bot still work.",
    "The stand-in writes as you and only says it is an assistant if asked directly. A program uses the login you already made in it. whatRust does not read that login. Hermes and Grok Bot can use tools and may keep a copy of this chat. whatRust is still the only WhatsApp sender. Replies happen only while whatRust is running. In Flatpak, the command-line programs are not available. Continuous use can hit your plan limit.": "The stand-in writes as you and only says it is an assistant if asked directly. A program uses the login you already made in it. whatRust does not read that login. Hermes and Grok Bot can use tools and may keep a copy of this chat. whatRust is still the only WhatsApp sender. Replies happen only while whatRust is running. In Flatpak, the command-line programs are not available. Continuous use can hit your plan limit.",
    "Stand-in model": "Stand-in model",
    "For the key, one model per provider. For a program, a model it offers. Empty uses the summary model, or that program's default.": "For the key, one model per provider. For a program, a model it offers. Empty uses the summary model, or that program's default.",
    "Same as the summary model": "Same as the summary model",
    "Program default": "Program default",
    "Program": "Program",
    "Full path, if the app cannot find the program on its own.": "Full path, if the app cannot find the program on its own.",
    "Wait before replying": "Wait before replying",
    "Seconds after the last message, from 5 to 60.": "Seconds after the last message, from 5 to 60.",
    "Replies per hour": "Replies per hour",
    "Maximum in each chat. After that the stand-in pauses.": "Maximum in each chat. After that the stand-in pauses.",
    "Program session": "Program session",
    "Check session": "Check session",
    "General instructions": "General instructions",
    "Save instructions": "Save instructions",
    "Open file": "Open file",
    "Restore template": "Restore template",
    "The stand-in writes as you and only says it is an assistant if asked directly. A program uses the login you already made in it. whatRust does not read that login. In Flatpak, only the API key works. Continuous use can hit your plan limit.": "The stand-in writes as you and only says it is an assistant if asked directly. A program uses the login you already made in it. whatRust does not read that login. In Flatpak, only the API key works. Continuous use can hit your plan limit.",
    "In this install, only the API key is available.": "In this install, only the API key is available.",
    "Saved ✓": "Saved ✓",
  };

  var lang = root.__WR_LANG === "en" ? "en" : "pt-BR";

  function norm(s) { return String(s).replace(/\s+/g, " ").trim(); }
  function has(k) { return Object.prototype.hasOwnProperty.call(PT, k); }
  function fill(text, args) {
    if (!args) return text;
    for (var i = 0; i < args.length; i++) text = text.split("{" + i + "}").join(String(args[i]));
    return text;
  }
  // Translate a source string (exact key) and fill {0}, {1}...
  function t(s, args) {
    var key = norm(s);
    var out = lang !== "en" && has(key) ? PT[key] : s;
    return fill(out, args);
  }

  var api = {
    PT: PT,
    norm: norm,
    t: t,
    lang: function () { return lang; },
    locale: function () { return lang === "en" ? "en-US" : "pt-BR"; },
    setLang: function () {},
  };
  root.I18n = api;
  root.t = t;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined" || !document.documentElement) return;

  // ---- DOM translation -------------------------------------------------
  var ATTRS = ["aria-label", "title", "placeholder"];
  var text = new WeakMap();   // text node -> { src, out }
  var attrs = new WeakMap();  // element  -> { name: { src, out } }
  var SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1 };

  function translateText(node) {
    var rec = text.get(node);
    if (!rec || node.nodeValue !== rec.out) rec = { src: node.nodeValue, out: node.nodeValue };
    var key = norm(rec.src), out = rec.src;
    if (lang !== "en" && has(key)) {
      var m = /^(\s*)[\s\S]*?(\s*)$/.exec(rec.src);
      out = m[1] + PT[key] + m[2];
    }
    rec.out = out;
    text.set(node, rec);
    if (node.nodeValue !== out) node.nodeValue = out;
  }

  function translateAttrs(el) {
    var recs = attrs.get(el) || {};
    ATTRS.forEach(function (name) {
      if (!el.hasAttribute || !el.hasAttribute(name)) return;
      var value = el.getAttribute(name), rec = recs[name];
      if (!rec || value !== rec.out) rec = { src: value, out: value };
      var key = norm(rec.src), out = lang !== "en" && has(key) ? PT[key] : rec.src;
      rec.out = out;
      recs[name] = rec;
      if (value !== out) el.setAttribute(name, out);
    });
    attrs.set(el, recs);
  }

  function walk(node) {
    if (node.nodeType === 3) { translateText(node); return; }
    if (node.nodeType !== 1 || SKIP[node.nodeName]) return;
    translateAttrs(node);
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }

  var observer;
  function translateAll() {
    if (observer) observer.disconnect();
    walk(document.documentElement);
    observe();
  }

  function observe() {
    if (!observer) {
      observer = new MutationObserver(function (records) {
        observer.disconnect();
        records.forEach(function (r) {
          if (r.type === "characterData") { translateText(r.target); }
          else if (r.type === "attributes") { translateAttrs(r.target); }
          else { r.addedNodes.forEach(function (n) { walk(n); }); }
        });
        observe();
      });
    }
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
  }

  api.setLang = function (next) {
    lang = next === "en" ? "en" : "pt-BR";
    root.__WR_LANG = lang;
    document.documentElement.lang = lang;
    translateAll();
    root.dispatchEvent(new Event("i18n"));
  };

  function start() { document.documentElement.lang = lang; translateAll(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : globalThis);
