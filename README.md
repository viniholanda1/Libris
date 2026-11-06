# Libris 1.2.11

Sistema de biblioteca escolar da CREDE. A interface é feita em HTML, CSS e JavaScript; o modo desktop usa Tauri 2. Os dados operacionais são armazenados localmente no navegador/aplicativo.

## Arquitetura e dados

- Livros, leitores, empréstimos, configurações, contas locais e auditoria ficam no IndexedDB e são separados por `schoolId`.
- Os dados não são sincronizados entre computadores. Exporte e guarde backups regularmente; limpar os dados do navegador ou desinstalar o aplicativo pode apagar os dados locais.
- As contas locais usam hashes de senha PBKDF2. A autenticação da CREDE é feita pelo Firebase Authentication e serve para acessar a configuração administrativa, não para sincronizar o acervo.
- Backups completos são arquivos ZIP com CSVs. As credenciais locais e a senha SMTP não são exportadas. Restaurar um backup substitui os dados da escola atual, preservando as contas locais existentes no computador.
- A senha SMTP é guardada no cofre de credenciais do sistema operacional no aplicativo desktop. O envio é manual e só está disponível no desktop.

### Conectividade e modo offline

O service worker mantém em cache o shell da aplicação, mas não sincroniza nem faz backup do IndexedDB. Login CREDE, busca de capas/sinopses e recursos carregados sob demanda para ZIP/PDF precisam de conexão. Planeje o primeiro acesso e os fluxos administrativos com internet disponível.

A pasta `functions/` contém uma função de backup agendado para o modelo legado no Firestore. Ela **não** lê o IndexedDB usado pelo aplicativo atual; não a use como substituta dos backups exportados no Libris.

## Requisitos

- Node.js 22.12 ou superior e npm para desenvolvimento e build web.
- Rust/Cargo, Tauri CLI e dependências do sistema para compilar o aplicativo desktop.
- Ubuntu/Debian amd64 para gerar o instalador `.deb`.

## Desenvolvimento no Codespace

```sh
npm ci
npm run dev -- --host 0.0.0.0
```

Abra a porta **5173** encaminhada pelo Codespaces. Para desenvolvimento local, `npm run dev` também inicia o Vite em `http://localhost:5173`.

## Testes e builds

```sh
npm test
npm run build:hosting
```

O build web é escrito em `dist/` (gerado e ignorado pelo Git). Para testar o resultado compilado:

```sh
python3 -m http.server 8080 --directory dist
```

Abra `http://localhost:8080`. Para compilar o aplicativo desktop:

```sh
npm run build:desktop
```

O instalador é gerado em `src-tauri/target/release/bundle/deb/`. A versão arquivada está em [`versoes/1.2.11/`](./versoes/1.2.11/). O diretório `src-tauri/target/` é cache de compilação e pode ser recriado pelo Cargo.

Para executar a interface desktop durante o desenvolvimento, use `npm run tauri dev`.

## Publicação web

O workflow [deploy-pages.yml](./.github/workflows/deploy-pages.yml) compila e publica a branch `main` no GitHub Pages. Configure **Settings → Pages → Build and deployment → GitHub Actions** no repositório. O build do workflow usa `/Libris/` como caminho base; em hospedagem própria, use `npm run build:hosting` sem `GITHUB_PAGES=true`.

O Firebase Authentication exige que o domínio de publicação esteja cadastrado em **Authorized domains** no Firebase Console. A configuração web do Firebase no cliente não é uma chave privada; nunca inclua service-account keys, senhas SMTP ou tokens no frontend ou no repositório.

## Configuração CREDE e login

1. Habilite Email/Password no Firebase Authentication do projeto `librisce` e cadastre as contas administrativas CREDE.
2. No aplicativo, abra **Configuração local (CREDE)** e autentique-se com uma dessas contas.
3. Configure a escola e crie as contas locais que serão usadas no login diário. Essas contas e os dados da escola ficam neste computador.

Não há recuperação automática das contas locais. A administração CREDE deve redefinir as credenciais localmente.

## Backup e migração

- Use **Exportar** para gerar um ZIP completo e guarde-o fora do computador da biblioteca.
- Antes de restaurar, confira escola/data do arquivo: a restauração substitui os dados da escola atual.
- **Importar** aceita backup completo do Libris e CSV legado de livros. Faça backup antes de migrar.
- `migrate.js` e `functions/` pertencem a fluxos legados que escrevem/leem Firestore; não são necessários para o funcionamento local atual. Não execute migrações sem revisar a origem e manter um backup.
- Os arquivos `libris-backup-*.zip` são dados locais e estão ignorados pelo Git. Não os envie ao repositório.

## Empréstimos, etiquetas e avisos

O limite de empréstimo é contado em exemplares ativos por leitor, somando todos os títulos; o novo empréstimo também é limitado pelo estoque disponível. A edição preserva a data inicial (`createdAt`) e altera a data de vencimento (`dueDate`, com compatibilidade para registros antigos que usam `dueAt`).

O leitor 2D USB funciona como teclado: abra Empréstimos, foque o campo **ID do livro** e leia o código. As etiquetas usam código de barras e incluem dados bibliográficos, tombamento legado e ISBN. Leitura por câmera não está disponível.

As capas e sinopses podem ser consultadas no Google Books e na Open Library. Os avisos por e-mail são manuais no desktop, usam o servidor SMTP configurado e exigem internet; as portas aceitas são 465 (TLS) e 587 (STARTTLS).

## Arquivos principais

- `index.html`, `styles.css`, `script.js`: interface e fluxos do aplicativo.
- `local-store.mjs`, `local-data.mjs`: persistência IndexedDB e API local.
- `loan-rules.mjs`, `reader-profiles.mjs`: regras compartilhadas e perfis.
- `tests/`: testes automatizados executados por `npm test`.
- `src-tauri/`: integração e configuração do aplicativo desktop.
- `versoes/`: instaladores e código históricos; o aplicativo ativo fica na raiz.
