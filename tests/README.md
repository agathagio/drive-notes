# Testes

O app não tem build. O `package.json` da raiz existe só pra estes testes. Uma vez: `npm install`.

## `npm test`

`app.test.js`: roda o `app.js` real dentro do jsdom contra um Google Drive falso em memória. Cobre save e fila de escrita, conflito, rascunhos, modo leitura (frontmatter, wikilinks, callouts, tabelas), navegação e botão voltar, renomear, login expirado, formatação e navegador de pastas. Leva uns 20 segundos.

O editor aqui é o textarea de fallback, porque o TinyMDE precisa de um navegador de verdade.

## `npm run test:browser`

`browser.test.js`: o que o jsdom não mostra, num Edge ou Chrome headless pelo protocolo de depuração:

- ditado por voz (composição de IME) no TinyMDE, com um controle que roda a versão antiga e confirma que o bug se reproduz nela;
- barra de formatação no TinyMDE;
- o CloseWatcher real, com a tecla Esc fazendo o papel do botão voltar do Android.

Pra escolher o navegador: variável de ambiente `BROWSER_PATH`.

## `npm run screenshots`

`screenshots.js`: prints em tamanho de celular (390x844) de todas as telas, com dados de exemplo. Saem em `tests/.tmp/screens/`. Serve pra olhar a interface sem o celular e pra comparar antes e depois de uma mudança visual.

## O que nenhum deles cobre

O Google de verdade (login, API do Drive) e o Android de verdade (teclado, botão voltar do sistema, toque na barra). Isso é teste no celular depois do deploy.

## Bibliotecas

`marked`, `dompurify` e `tiny-markdown-editor` estão fixados no `package.json` nas mesmas versões que o `index.html` carrega dos CDNs. O primeiro cenário do `npm test` falha se as duas listas divergirem: ao atualizar uma lib, mude nos dois lugares (e em `CDN_ASSETS` no `sw.js`).
