# Integração Backstage ↔ GitHub

Guia verificada em 2026-09-14 sobre o scaffold criado em `alura-online/` (Backstage recente, novo frontend system). Documentação oficial: https://backstage.io/docs/integrations/github/locations/

## O que faz esta integração

- Descobrir entidades do catálogo a partir de repos e organizações de GitHub (`catalog-info.yaml`)
- Carregar usuários e grupos de uma organização
- Usar ações de scaffolder de GitHub (criar repos, publicar, PRs, webhooks, deploy keys...)

## 1. Token de GitHub (PAT)

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** (ou classic)
2. Scopes segundo o uso:

| Uso | Scopes |
|---|---|
| Ler componentes do catálogo | `repo` |
| Ler dados de organização (usuários/grupos) | `read:org`, `read:user`, `user:email` |
| Publicar templates de software | `repo`, `workflow` (se os templates incluem workflows) |

## 2. Configuração em `app-config.yaml`

O scaffold já traz a seção pronta; só falta definir a variável:

```yaml
integrations:
  github:
    - host: github.com
      token: ${GITHUB_TOKEN}
```

- `host` (opcional): por padrão `github.com`
- `token` (opcional): PAT; sem token → acesso anônimo
- `apiBaseUrl` / `rawBaseUrl` (opcional): só GitHub Enterprise
  (`https://<host>/api/v3` e `https://<host>/raw`); no GitHub público são inferidos
- O provider público é registrado automaticamente ao iniciar; só é necessário listá-lo para fornecer um token

Exemplo com GitHub Enterprise:

```yaml
integrations:
  github:
    - host: ghe.example.net
      apiBaseUrl: https://ghe.example.net/api/v3
      rawBaseUrl: https://ghe.example.net/raw
      token: ${GHE_TOKEN}
```

## 3. Instalar o plugin de catálogo de GitHub

O scaffold NÃO inclui o provider de catálogo. Instale-o:

```bash
cd alura-online
yarn workspace backend add @backstage/plugin-catalog-backend-module-github
```

Registre-o em `packages/backend/src/index.ts` (junto aos outros plugins de catalog):

```ts
backend.add(import('@backstage/plugin-catalog-backend-module-github'));
```

Recompilar e reiniciar:

```bash
yarn build:backend
yarn start
```

Verificação: o início não deve mostrar erros novos; as ações de scaffolder de GitHub (`github:repo:create`, `publish:github`, etc.) aparecem listadas no log de `scaffolder`.

## 4. Ativar o discovery de entidades

Para que Backstage leia `catalog-info.yaml` de todos os repos da organização [Tech-Preta](https://github.com/Tech-Preta), adicione em `app-config.yaml`:

```yaml
catalog:
  providers:
    github:
      techPreta:
        organization: Tech-Preta
        schedule:
          frequency: { minutes: 30 }
          timeout: { minutes: 3 }
```

> **Por que `Tech-Preta` e não `nataliagranato`?**
> `nataliagranato` é um usuário pessoal — o GitHub Discovery usa a API `/orgs/{org}/repos`, que não funciona para usuários. A organização real é [github.com/Tech-Preta](https://github.com/Tech-Preta) (67 repos públicos, 2 privados), validada via API em 2026-09-14.

### Token via arquivo `.env` (abordagem adotada)

O Backstage **não carrega `.env` automaticamente**. A solução adotada neste projeto usa `dotenv-cli` no script `start` do `package.json` raiz, que injeta as variáveis antes de iniciar qualquer processo.

**Passo 1 — Instalar `dotenv-cli` como dependência de desenvolvimento:**

```bash
cd alura-online
yarn add --dev dotenv-cli
```

**Passo 2 — Atualizar o script `start` em `package.json` (raiz do workspace):**

```json
{
  "scripts": {
    "start": "dotenv -e .env -- backstage-cli repo start"
  }
}
```

**Passo 3 — Criar o arquivo `.env` na raiz do projeto (`alura-online/.env`):**

```bash
GITHUB_TOKEN=ghp_xxx
```

A partir de então, basta executar normalmente:

```bash
yarn start   # .env é carregado automaticamente
```


## 5. Alternativa: GitHub App (recomendada para produção)

Para organizações, Backstage pode se autenticar com GitHub Apps em vez de PAT: maiores limites de rate limit e modelo de autorização mais claro. Ver https://backstage.io/docs/integrations/github/github-apps

## Problemas comuns

1. **Sem token não se descobre nada**: o acesso anônimo só serve para repos públicos; o discovery de orgs exige PAT com `read:org`.
2. **Scopes insuficientes**: se o catálogo não carrega, verifique que o token tenha os scopes da tabela (os fine-grained tokens são criados por repo/org).
3. **O plugin não está pré-instalado**: `plugin-catalog-backend-module-github` é preciso adicioná-lo com `yarn workspace backend add`; o scaffold só traz `plugin-catalog-backend`.
4. **`${GITHUB_TOKEN}` não definido / erro 401**: o Backstage inicia normalmente, mas o GitHub Entity Provider falha com `HttpError: Bad credentials`. Solução: garantir que `dotenv-cli` está instalado, o script `start` usa `dotenv -e .env --`, e o `.env` existe com o token válido.
5. **Discovery apontando para usuário pessoal em vez de org**: o provider `github` usa `/orgs/{org}/repos` — aponte sempre para uma organização GitHub real, não para um usuário pessoal.
