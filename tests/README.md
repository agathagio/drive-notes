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
- deslizar da borda: toque emulado em tela de celular, com o CloseWatcher real; a seta sai da borda certa e fica roxa, e os prints do meio do gesto saem em `tests/.tmp/`;
- retomar a nota onde parou: sair e voltar, e a página recarregada como o app que o Android matou, reabrem no mesmo parágrafo, inclusive com uma foto de cima chegando do Drive depois (quem segura o lugar enquanto ela cresce é a ancoragem de rolagem do navegador). Tem um controle que roda o app do `7bed916` e confere que nele a nota reabre no topo;
- Ler e Editar no mesmo trecho: com o CodeMirror de verdade, o Editar abre o editor no parágrafo que estava no topo da leitura, sem pegar o foco (sem teclado), o Ler faz o caminho inverso, três idas e voltas não escorregam, e um parágrafo enorme lido até a metade abre na metade dele. Tem um controle que roda o app do `cf8d4f1` e confere que nele o Editar abre no topo da nota.

Pra escolher o navegador: variável de ambiente `BROWSER_PATH`.

## `npm run test:sw`

`sw.test.js`: o service worker de ponta a ponta, que as outras suítes não tocam (elas abrem páginas `file://`, sem service worker). Um servidor local em `http://127.0.0.1:8336` faz o papel do GitHub Pages, com o mesmo `max-age=600`, e um Edge headless com perfil limpo faz o papel do celular. Cada "deploy" é o servidor passar a responder outra versão: o `CACHE_NAME` servido muda, e o `app.js` servido diz qual versão é (`window.__servedVersion`). As CDNs e o Google saem da conta: as bibliotecas vêm do `node_modules` (mesmos bytes, então o hash confere), a folha de fontes e o login do Google são tirados, e o Drive é um falso guardado no `localStorage`, pra o que um salvar escreveu sobreviver à recarga.

Cobre: a primeira abertura de todas não recarrega; deploy e abrir o app traz a versão nova na mesma abertura, com uma recarga só; voltar do fundo confere se há versão nova; nota com texto por salvar nunca recarrega, e o aviso salva, recarrega e reabre a mesma nota no mesmo modo; nota lida até o meio volta, depois do aviso, no mesmo parágrafo; compartilhar de outro app (o POST guardado pelo service worker e a tela "Guardar em…"), atalho do ícone sem rede saindo do cache, .txt compartilhado em UTF-8 e UTF-16 virando texto; e nota rolada no editor volta, depois do aviso, na mesma linha do editor. Leva uns 60 segundos.

Controle: `SW_COMMIT=dba1d23 npm run test:sw` serve o app daquele commit (a `v46`, de antes do aviso) e os cenários 2 a 4 têm que falhar; `SW_COMMIT=7bed916` (a `v47`, de antes do retomar) faz falhar o 5; `SW_COMMIT=f76e959` (a `v57`, quando o aviso em edição reabria o editor onde a leitura estava) faz falhar o 9. Se não falharem, o teste deixou de provar alguma coisa.

## `npm run screenshots`

`screenshots.js`: prints em tamanho de celular (390x844) de todas as telas, com dados de exemplo. Saem em `tests/.tmp/screens/`. Serve pra olhar a interface sem o celular e pra comparar antes e depois de uma mudança visual.

## O que nenhum deles cobre

O Google de verdade (login, API do Drive) e o Android de verdade (teclado, botão voltar do sistema, toque na barra, o app que volta do fundo sem recarregar). Isso é teste no celular depois do deploy.

## Bibliotecas

`marked` e `dompurify` estão fixados no `package.json` nas mesmas versões que o `index.html` carrega dos CDNs. O primeiro cenário do `npm test` falha se as duas listas divergirem: ao atualizar uma lib, mude nos dois lugares (e em `CDN_SCRIPTS` no `sw.js`).

As duas tags levam `integrity` (o hash do arquivo) e `crossorigin`: se a CDN entregar outro arquivo, o navegador recusa rodar, e no celular isso aparece como leitura sem formatação. O `sw.js` guarda o mesmo hash e confere as cópias que busca sozinho, porque o hash da página não chega até ele. Ao atualizar uma lib, os dois hashes mudam: o primeiro cenário calcula o certo a partir do `node_modules` e mostra o valor na falha. Dá pra usar o do `node_modules` porque o jsDelivr serve os mesmos bytes que o npm instala (comparado em 22 set 2026).

O editor ficou fora dessa conta: o CodeMirror 6 não vem de CDN, e sim do `vendor/codemirror.js` versionado no repositório (como regerar está em `vendor/README.md`). Já o `tiny-markdown-editor` continua nas devDependencies de propósito, mesmo sem o app usar: é a lib que o controle histórico do ditado precisa pra rodar o app antigo.
