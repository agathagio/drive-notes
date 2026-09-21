# Testes

O app não tem build. O `package.json` da raiz existe só pra estes testes. Uma vez: `npm install`.

## `npm test`

`app.test.js`: roda o `app.js` real dentro do jsdom contra um Google Drive falso em memória. Cobre save e fila de escrita, conflito, rascunhos, modo leitura (frontmatter, wikilinks, imagens embutidas, callouts, tabelas), foto na nota (upload pro `_media`), navegação e botão voltar, renomear, login expirado, formatação, navegador de pastas, busca (filtro da pasta aberta, vault inteiro, o que fica de fora, voltar de um resultado) as datas `created` / `updated` (incluindo o que fica de fora: `_templates`, `CLAUDE.md`, `-antigo`, `.txt`, fora do vault) e o desenho na nota (caixa de recorte, traço, borracha, desfazer, voltar e o PNG no `_media`), a tarefa marcada no modo leitura (a caixa certa no texto, bloco de código de fora, caixas desligadas se a contagem não bater) e o deslizar da borda (esquerda volta, direita avança, e tudo que não pode virar gesto: arrasto curto, vertical, fora da borda, texto selecionado, tela de desenho). Leva uns 20 segundos.

O jsdom não tem canvas: o `boot()` põe um contexto 2D de mentira que anota o que foi pintado, e é contra esse registro que o traço e a borracha são conferidos. O canvas de verdade fica pro `test:browser`.

O editor aqui é o textarea de fallback. A exceção são os cenários que pedem `boot({ editor: true })`: eles carregam o `vendor/codemirror.js` de verdade dentro do jsdom, e é assim que a fachada `App.Editor`, o Enter dentro de uma tarefa, a formatação, a marca de cursor e a foto desenhada na linha são conferidas contra a lib. O que depende de layout, cursor de verdade e teclado continua no `test:browser`.

## `npm run test:browser`

`browser.test.js`: o que o jsdom não mostra, num Edge ou Chrome headless pelo protocolo de depuração:

- ditado por voz (composição de IME) no editor, com um controle que roda o app de um commit anterior à troca de editor e confirma que o bug se reproduz nele (é esse controle que segura o `tiny-markdown-editor` nas devDependencies);
- barra de formatação no editor;
- foto na nota: a redução por canvas de verdade e o `![[...]]` entrando no editor onde o cursor estava;
- imagem visível na edição: aparece só na linha que é só o embed, não muda o texto, sobrevive a digitação e sai quando a linha muda;
- o CloseWatcher real, com a tecla Esc fazendo o papel do botão voltar do Android;
- datas: o cursor da nota nova cai embaixo das propriedades, salvar não mexe no texto nem no cursor de quem está digitando, e o editor alcança o `updated` do Drive ao ir pro modo leitura;
- desenho: canvas com `devicePixelRatio`, ponta de traço redonda, o traço nascendo sob o dedo (e não deslocado pela faixa do topo), borracha apagando pra transparente e o PNG recortado no traço;
- tarefa: um clique de verdade na caixa do modo leitura vira `[x]` no editor;
- deslizar da borda: toque emulado em tela de celular, com o CloseWatcher real; a seta sai da borda certa e fica roxa, e os prints do meio do gesto saem em `tests/.tmp/`.

Pra escolher o navegador: variável de ambiente `BROWSER_PATH`.

## `npm run screenshots`

`screenshots.js`: prints em tamanho de celular (390x844) de todas as telas, com dados de exemplo. Saem em `tests/.tmp/screens/`. Serve pra olhar a interface sem o celular e pra comparar antes e depois de uma mudança visual.

## O que nenhum deles cobre

O Google de verdade (login, API do Drive) e o Android de verdade (teclado, botão voltar do sistema, toque na barra). Isso é teste no celular depois do deploy.

## Bibliotecas

`marked` e `dompurify` estão fixados no `package.json` nas mesmas versões que o `index.html` carrega dos CDNs. O primeiro cenário do `npm test` falha se as duas listas divergirem: ao atualizar uma lib, mude nos dois lugares (e em `CDN_ASSETS` no `sw.js`).

O editor ficou fora dessa conta: o CodeMirror 6 não vem de CDN, e sim do `vendor/codemirror.js` versionado no repositório (como regerar está em `vendor/README.md`). Já o `tiny-markdown-editor` continua nas devDependencies de propósito, mesmo sem o app usar: é a lib que o controle histórico do ditado precisa pra rodar o app antigo.
