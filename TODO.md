- [x] Encontrar e corrigir no `admin.html` a autenticação do upload: `uploadArquivo()` passou de `x-admin-password: obterSenha()` para `headersComJwt()` (evita 401 em `/api/upload`).
- [x] Remover `prompt()` de `function obterSenha()` substituindo o corpo inteiro por apenas leitura do `localStorage`.


