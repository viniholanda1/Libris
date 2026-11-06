# Notas técnicas do Libris

## Estado atual

- Release atual: **1.2.11**.
- Interface: HTML, CSS e JavaScript; Vite é usado para desenvolvimento e build.
- Desktop: Tauri 2; o instalador Debian é compilado com `npm run build:desktop`.
- Persistência operacional: IndexedDB via `local-store.mjs` e `local-data.mjs`, sempre filtrada por escola.
- Testes: `npm test`.

## Dados e autenticação

O acervo e as contas locais não são sincronizados entre computadores. Backups completos são exportados manualmente pelo app em ZIP/CSV; restaurar substitui os dados da escola atual, mas mantém as contas locais existentes. O ZIP não leva senhas nem a senha SMTP.

O Firebase Authentication é usado para autenticar a administração CREDE. O login cotidiano usa contas locais, cujas senhas são armazenadas com PBKDF2. A configuração web Firebase não é segredo; credenciais administrativas, senhas e chaves de service account não devem ser incluídas no frontend ou em backups.

## Regras de empréstimo

- O limite é contado em exemplares ativos por leitor, através de todos os títulos.
- A quantidade de um novo empréstimo não pode superar o limite restante do leitor nem o estoque disponível.
- A edição valida novamente o limite e o estoque.
- `createdAt` registra a saída e não deve ser alterado por renovação; renovações estendem `dueDate`.
- `dueAt` continua aceito para compatibilidade com registros antigos.

As regras estão centralizadas em `loan-rules.mjs` e cobertas por `tests/loan-rules.test.mjs`.

## E-mail e conectividade

O envio SMTP é manual e disponível somente no aplicativo desktop. A senha SMTP fica no cofre de credenciais do sistema operacional. Firebase Authentication, consulta de capas, dependências carregadas por CDN e SMTP precisam de conexão; o service worker armazena em cache apenas o shell web, não os dados nem os serviços remotos.

## Componentes legados

- `functions/` contém backup agendado do Firestore legado e não inclui os dados atuais do IndexedDB.
- `migrate.js` escreve dados no Firestore legado; não é necessário para o funcionamento atual. Revise origem e destino e faça backup antes de qualquer execução.
- `versoes/` guarda instaladores antigos, logs e uma cópia legada; o código ativo fica na raiz.
