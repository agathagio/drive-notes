# Drive Notes — Setup do Google Cloud

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
2. Pesquise e ative cada uma:
   - **Google Drive API** → clique → **Enable**
   - **Google Picker API** → clique → **Enable**

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

## 4. Criar credenciais

### API Key
1. Vá em **APIs & Services** → **Credentials**
2. Clique **Create Credentials** → **API Key**
3. Copie a chave gerada
4. (Recomendado) Clique em **Restrict Key**:
   - Em **API restrictions**, selecione **Restrict key**
   - Marque: Google Drive API, Google Picker API
   - Salve

### OAuth Client ID
1. Na mesma página, clique **Create Credentials** → **OAuth client ID**
2. Application type: **Web application**
3. Name: `Drive Notes Web`
4. Em **Authorized JavaScript origins**, adicione:
   - `https://SEU-USUARIO.github.io` (pra produção no GitHub Pages)
   - `http://localhost:8000` (pra testes locais, se quiser)
5. Clique **Create**
6. Copie o **Client ID**

### Project Number
1. Vá em **IAM & Admin** → **Settings** (ou página inicial do projeto)
2. Copie o **Project Number** (é um número, tipo `123456789012`)

## 5. Configurar o app

Abra o arquivo `app.js` e substitua os valores no topo:

```javascript
const CONFIG = {
  CLIENT_ID: 'SEU_CLIENT_ID_AQUI.apps.googleusercontent.com',
  API_KEY: 'SUA_API_KEY_AQUI',
  APP_ID: 'SEU_PROJECT_NUMBER_AQUI',
  DEFAULT_FOLDER_ID: null,  // configurar depois (opcional)
};
```

## 6. (Opcional) Configurar pasta padrão

Pra que novas notas sejam salvas automaticamente em `vault/00-inbox/`:

1. Abra o Google Drive no navegador
2. Navegue até a pasta `vault/00-inbox/`
3. Olhe a URL — ela terá algo como: `drive.google.com/drive/folders/XXXXX`
4. Copie o ID da pasta (o `XXXXX`)
5. Cole em `DEFAULT_FOLDER_ID` no `app.js`

## 7. Deploy no GitHub Pages

1. Crie um repositório no GitHub (ex: `drive-notes`)
2. Antes de dar push, gere os ícones: abra `generate-icons.html` no browser e baixe os dois PNGs
3. Coloque `icon-192.png` e `icon-512.png` na pasta `drive-notes/`
4. Faça push dos arquivos pro repositório
5. No GitHub, vá em **Settings** → **Pages**
6. Source: **Deploy from a branch** → branch `main` → pasta `/ (root)`
7. O app fica disponível em `https://SEU-USUARIO.github.io/drive-notes/`

## 8. Atualizar origins no Google Cloud

Depois de ativar o GitHub Pages, volte ao Google Cloud Console:
1. **APIs & Services** → **Credentials** → clique no OAuth Client ID
2. Em **Authorized JavaScript origins**, adicione a URL do GitHub Pages:
   `https://SEU-USUARIO.github.io`
3. Salve

## 9. Instalar no celular

1. Abra a URL do GitHub Pages no Chrome do celular
2. Na primeira vez, faça login com Google (vai aparecer tela "App não verificado" — clique "Avançado" → "Acessar")
3. Toque no menu do Chrome (⋮) → **Adicionar à tela inicial**
4. O app aparece como ícone no celular e abre fullscreen

---

## Troubleshooting

- **"This app isn't verified"**: Normal pra projetos em Testing mode. Clique "Advanced" → "Go to Drive Notes (unsafe)". É seguro — é o seu próprio app.
- **Picker não aparece**: Verifique se a Picker API está ativada e se o API Key está correto.
- **401 Unauthorized**: Token expirou. Recarregue a página e faça login novamente.
- **Erro de origin**: A URL de onde você acessa precisa estar nas Authorized JavaScript Origins.
