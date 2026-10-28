# Backstage do zero: guia passo a passo

Guia verificado em 2026-09-10 nesta máquina (Debian, Docker Desktop, kind). Resultado: um Backstage funcional em `http://localhost:3000` com login de convidado.

## Pré-requisitos

| Ferramenta | Versão mínima | Observação |
|---|---|---|
| Node.js | 22+ | Obrigatório: os módulos nativos (`better-sqlite3`, `isolated-vm`) não compilam com Node 20 |
| Yarn | 4.x | Ativado via corepack, não instalar globalmente |
| Git | qualquer | Para o repositório |
| Docker Desktop | — | Apenas se for construir imagens / implantar no kind |

Verificação rápida:

```bash
node --version   # v22.x
git --version
```

## Passo 1 — Ativar o Yarn 4 com corepack

O Backstage requer o Yarn 4. O Yarn 1.22 (o clássico) que vem com o Node não serve.

```bash
# Com o Node 22 ativo:
corepack enable
corepack prepare yarn@4.9.1 --activate
yarn --version   # 4.9.1
```

## Passo 2 — Scaffold do projeto

```bash
# A partir do diretório onde você quer o projeto (ex: ~/platform):
npx --yes @backstage/create-app@latest 
```

Isso cria `alura-online/` com o monorepo: `packages/app` (frontend React), `packages/backend` (Node), `app-config.yaml`, `yarn.lock`.

> `--skip-install` separa o scaffold do `yarn install`, que demora vários minutos. Assim você pode revisar a estrutura de pastas antes de instalar.

## Passo 3 — Instalar dependências

```bash
cd alura-online
yarn install
```

Aguarde ~1 min. Os avisos `YN0007: must be built` são normais (pacotes nativos que o Yarn compila em tempo de execução). Se falhar com `couldn't be built successfully`, você está com a versão incorreta do Node: volte ao Passo 1.

## Passo 4 — Compilar o backend

```bash
yarn build:backend
```

Gera `dist/` com o bundle do backend e o frontend compilado. Sem erros = pronto para iniciar.

## Passo 5 — Iniciar em modo de desenvolvimento

```bash
yarn start
```

- Frontend: `http://localhost:3000`
- Backend (API): `http://localhost:7007`

Verificação:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7007/auth/providers  # 200
```

Abra `http://localhost:3000` e pressione **ENTER** para entrar como convidado (o provider guest vem configurado por padrão em `app-config.yaml` → `auth.providers.guest: {}`).

## Estrutura resultante

```
backstage/
├── packages/
│   ├── app/            # Frontend (React, novo sistema de frontend)
│   │   └── src/modules/  # Módulos: nav, home
│   └── backend/        # Backend (Node)
│       └── src/index.ts  # Registro de plugins (auth, catalog, techdocs...)
├── app-config.yaml     # Config de desenvolvimento (portas, auth, catalog)
├── app-config.production.yaml
├── package.json        # Workspace raiz
└── yarn.lock
```

## Problemas encontrados

1. **Node 20 quebra o `yarn install`**: `better-sqlite3` falha ao compilar. Use Node 22+ (ex: `~/.nvm/versions/node/v22.23.0/bin`).
2. **`yarn start` morre com o terminal**: se você iniciar o processo em background e fechar a sessão, o servidor cai silenciosamente. Reinicie com `yarn start` em um terminal dedicado.
3. **Erros `ERR_STREAM_PREMATURE_CLOSE` no log ao iniciar**: são do collator de techdocs/search index no início; não são fatais, o servidor responde 200 normalmente.
4. **A API retorna 401 sem sessão**: `/api/catalog/entities` exige autenticação. Isso é correto; o fluxo de login é via browser (cookies), não via curl.

## Próximos passos comuns

```bash
# Atualizar a versão de todos os pacotes @backstage/* juntos
yarn backstage-cli versions:bump

# Adicionar plugin de frontend
yarn workspace app add <plugin-npm-package>

# Adicionar plugin de backend
yarn workspace backend add <plugin-npm-package>

# Build Docker + deploy no kind
docker build -t backstage:latest -f packages/backend/Dockerfile .
kind load docker-image backstage:latest --name <cluster>
```

## Referências

- Docs oficiais: https://backstage.io/docs
- Upgrade helper (comparar versões ao atualizar): https://backstage.github.io/upgrade-helper/