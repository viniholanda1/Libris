# Versoes arquivadas

- `1.2.11/` contém o instalador Debian atual.
- `1.2.1/` a `1.2.10/` contêm instaladores de versões anteriores.
- `debian-antigos/` preserva pacotes históricos com os nomes originais.
- `codigo-legado/` preserva uma cópia antiga do projeto; não faz parte do build ativo.
- `logs/` contém registros históricos de compilação.

O código ativo e os comandos de desenvolvimento ficam na raiz do repositório. `npm run build:desktop` gera o pacote em `src-tauri/target/`; esse diretório é cache gerado e não é arquivado aqui automaticamente.
