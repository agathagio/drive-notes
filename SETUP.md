# Drive Notes: setup do Google Cloud

Guia passo a passo pra configurar a integração com o Google Drive.
Você só precisa fazer isso **uma vez**.

---

## 1. Criar projeto no Google Cloud Console

1. Acesse [console.cloud.google.com](https://console.cloud.google.com)
2. Faça login com sua conta Google (a mesma do Drive)
3. Clique em **Select a project** (topo da página) → **New Project**
4. Nome: `Drive Notes` (ou o que preferir)
5. Clique **Create**
6. Certifique-se de que o projeto está selecionado no topo

## 2. Ativar as APIs

1. No menu lateral, vá em **APIs & Services** → **Library**
2. Pesquise e ative:
   - **Google Drive API** → clique → **Enable**

O app não usa mais o Google Picker: a navegação de pastas é do próprio app, direto na Drive API.

## 3. Configurar tela de consentimento OAuth

1. Vá em **APIs & Services** → **OAuth consent screen**
2. Escolha **External** → **Create**
3. Preencha:
   - App name: `Drive Notes`
   - User support email: seu email
   - Developer contact email: seu email
4. Clique **Save and Continue** nas próximas telas (Scopes, Test users)
5. Na tela **Test users**, clique **Add Users** e adicione seu email
6. Finalize
7. Depois de tudo salvo, publique o app (de Testing pra In production). Hoje isso fica em **Google Auth Platform**: na página **Branding**, preencha o que o botão exige (nome do app, e-mail de suporte, página inicial `https://SEU-USUARIO.github.io/drive-notes/`, política de privacidade `https://SEU-USUARIO.github.io/drive-notes/privacidade.html`, que é a página `privacidade.html` do repositório, e `SEU-USUARIO.github.io` em Authorized domains); depois, na página **Audience**, clique **Publish app** e confirme. Não precisa enviar pra verificação. Sem isso o refresh token (seção 7b) morre em 7 dias e o app pede login toda semana.

## 4. Criar credenciais

### OAuth Client ID
1. Vá em **APIs & Services** → **Credentials** e clique **Create Credentials** → **OAuth client ID**
2. Application type: **Web application**
3. Name: `Drive Notes Web`
4. Em **Authorized JavaScript origins**, adicione:
   - `https://SEU-USUARIO.github.io` (pra produção no GitHub Pages)
   - `http://localhost:8000` (pra testes locais, se quiser)
5. Clique **Create**
6. Copie o **Client ID**

API key e Project Number não são mais necessários (eram só do Google Picker). Se você criou uma API key pra versões antigas, pode apagar em **Credentials**.

### Segredo do cliente

O Worker de login (seção 7b) precisa do **Client secret** do cliente Web. O Google só mostra o segredo na hora em que ele é criado: se não estiver anotado, abra o cliente em **Credentials**, clique **Add secret**, copie o novo e apague o antigo depois que o Worker estiver no ar. O Client ID não muda.

## 5. Configurar o app

Abra o arquivo `app/core.js` e substitua os valores no topo:

```javascript
const CONFIG = {
  CLIENT_ID: 'SEU_CLIENT_ID_AQUI.apps.googleusercontent.com',
  ROOTS: [
    { id: 'ID_DA_PASTA_RAIZ', name: 'vault', dates: true, embedPrefix: '' },
  ],
  DEFAULT_FOLDER_ID: 'ID_DA_PASTA_DE_NOTAS_NOVAS',
  DEFAULT_FOLDER_TRAIL: ['vault', '_inbox'],
  AUTH_URL: 'https://drive-notes-auth.SUA-CONTA.workers.dev/',
};
```

## 6. IDs das pastas

`ROOTS` são as pastas-raiz que a árvore da tela inicial mostra, na ordem da lista; a busca e a lista do `[[` enxergam todas juntas. Cada uma tem o ID da pasta e o nome que aparece na árvore. `dates` diz se as notas dali ganham `created` e `updated` nas propriedades; `embedPrefix` é o que vai antes do nome do arquivo no `![[...]]` de uma foto ou desenho (`'_media/'` escreve `![[_media/foto.jpg]]`, `''` escreve `![[foto.jpg]]`). Foto e desenho sobem pra pasta `_media` que fica direto dentro da raiz da nota.

`DEFAULT_FOLDER_ID` é onde as notas novas são criadas (a inbox), e `DEFAULT_FOLDER_TRAIL` é o caminho até ela a partir da raiz, começando pelo nome da raiz. Nota nova nasce com as duas datas se essa raiz tiver `dates: true`, e em branco se não tiver.

1. Abra o Google Drive no navegador
2. Navegue até a pasta
3. Olhe a URL: ela terá algo como `drive.google.com/drive/folders/XXXXX`
4. Copie o ID da pasta (o `XXXXX`)
5. Cole no campo correspondente no `app/core.js`

## 7. Deploy no GitHub Pages

1. Crie um repositório no GitHub (ex: `drive-notes`)
2. Antes de dar push, gere os ícones: abra `lab/generate-icons.html` no browser e baixe os dois PNGs
3. Coloque `icon-192.png` e `icon-512.png` na pasta `drive-notes/`
4. Faça push dos arquivos pro repositório
5. No GitHub, vá em **Settings** → **Pages**
6. Source: **Deploy from a branch** → branch `main` → pasta `/ (root)`
7. O app fica disponível em `https://SEU-USUARIO.github.io/drive-notes/`

## 7b. O Worker de login (Cloudflare)

O token do Google dura 1 hora. Pra renovar sem pedir login de novo, o app usa um refresh token, e pra isso o Google exige o segredo do cliente numa troca feita fora do navegador. Quem faz essa troca é `worker/index.js`, publicado na Cloudflare (plano grátis).

1. Crie uma conta em [cloudflare.com](https://www.cloudflare.com) (não precisa de domínio)
2. No PC, na pasta do repositório: `npx wrangler login` (abre o navegador pra autorizar)
3. Em `worker/`: `npx wrangler secret put GOOGLE_CLIENT_SECRET` e cole o segredo (seção "Segredo do cliente")
4. Confira o `GOOGLE_CLIENT_ID` em `worker/wrangler.toml` (é o seu Client ID) e a lista `ORIGINS` em `worker/index.js` (é a URL do seu GitHub Pages)
5. Em `worker/`: `npx wrangler deploy`. O comando imprime a URL do Worker, tipo `https://drive-notes-auth.sua-conta.workers.dev`
6. Cole essa URL, com a barra no fim, em `AUTH_URL` no `app/core.js`, e faça o push

O Worker não guarda nada: quem tem o refresh token é o aparelho. Pra trocar o segredo, repita o passo 3 e o 5.

## 8. Atualizar origins no Google Cloud

Depois de ativar o GitHub Pages, volte ao Google Cloud Console:
1. **APIs & Services** → **Credentials** → clique no OAuth Client ID
2. Em **Authorized JavaScript origins**, adicione a URL do GitHub Pages:
   `https://SEU-USUARIO.github.io`
3. Salve

## 9. Instalar no celular

1. Abra a URL do GitHub Pages no Chrome do celular
2. Na primeira vez, faça login com Google: aparece a tela "App não verificado" (clique "Avançado" → "Acessar") e a de permissões. É uma vez só por aparelho: dali em diante o login se renova sozinho. Pra trocar de conta ou limpar o aparelho, "Sair da conta" no rodapé da tela inicial.
3. Toque no menu do Chrome (⋮) → **Adicionar à tela inicial**
4. O app aparece como ícone no celular e abre fullscreen

---

## Troubleshooting

- **"This app isn't verified"**: Normal pra app publicado sem verificação do Google. Clique "Advanced" → "Go to Drive Notes (unsafe)". É seguro: é o seu próprio app.
- **Pasta não carrega**: Verifique se a Google Drive API está ativada e se o `id` de cada item de `ROOTS` é o ID da pasta certa.
- **Botão voltar do celular não funciona**: na tela inicial, toque 5 vezes no título "Drive Notes". Abre um painel de diagnóstico com o modo de navegação em uso e o log dos últimos eventos.
- **"Login expirou: toque em salvar" toda hora**: o app está sem refresh token. Confira no painel de diagnóstico (cinco toques no título) a linha "login": "renovável" é o esperado. "só token" ou "nenhum" com o Worker no ar: saia da conta e entre de novo.
- **"Erro: salvo local" com rede**: o Worker pode estar fora ou a URL em AUTH_URL errada. Abra a URL do Worker no navegador: tem que responder "forbidden" (é o esperado pra um acesso sem o app).
- **Erro de origin**: A URL de onde você acessa precisa estar nas Authorized JavaScript Origins.
