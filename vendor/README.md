# vendor

O `codemirror.js` é gerado, não escrito à mão, e é commitado de propósito: o app não
tem build no dia a dia, e o editor precisa estar no service worker pra funcionar na
primeira abertura sem rede.

Regerar só ao atualizar a versão do CodeMirror:

    npx esbuild vendor/cm6-entry.js --bundle --format=iife --minify --target=es2020 --outfile=vendor/codemirror.js

Depois: rodar `npm test`, subir o número do cache no `sw.js` e conferir o peso com

    node -e "const z=require('zlib'),f=require('fs');const b=f.readFileSync('vendor/codemirror.js');console.log(Math.round(z.gzipSync(b).length/1024)+'kB')"
