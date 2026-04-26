---
name: create-release
description: 'Cria uma release incremental no GitHub para o Mobilidade e Território (Évora) — pergunta patch/minor/major (SemVer), só publica a partir de `main` ou `develop` (com `HEAD` sincronizado com `origin`), garante que README/instructions estão atualizados, escreve changelog em PT seguindo o padrão das releases anteriores, valida com o utilizador antes de publicar, e cria tag + release via `gh`.'
---

# Create Incremental Release

Workflow para preparar e publicar uma nova release no GitHub deste repositório.

## Quando usar

- Utilizador pede uma "release", "nova versão", "tag nova", "publicar versão".
- Após terminar um conjunto coerente de alterações que devem ser entregues.

## Terminologia

Usar **SemVer** estrito (`X.Y.Z`):

| Tipo | Bump | Exemplo |
|------|------|---------|
| **patch** | `Z` (`X.Y.Z` → `X.Y.(Z+1)`) | `2.0.2 → 2.0.3` |
| **minor** | `Y`, reset `Z` (`X.Y.Z` → `X.(Y+1).0`) | `2.0.2 → 2.1.0` |
| **major** | `X`, reset `Y.Z` (`X.Y.Z` → `(X+1).0.0`) | `2.0.2 → 3.0.0` |

## Procedimento

### 1. Verificar a branch e a sincronização com `origin`

**Pré-requisito obrigatório.** A release é sempre criada a partir de `main` ou `develop`, e `HEAD` tem de coincidir com `origin/<branch>`.

```bash
git rev-parse --abbrev-ref HEAD
git fetch --quiet origin && git rev-parse HEAD && git rev-parse @{u}
```

Se a branch atual não for `main` nem `develop`, **parar e alertar o utilizador** com a branch atual antes de avançar.

Se `HEAD` ≠ `@{u}` (commits locais por empurrar, ou remote à frente), parar e perguntar como proceder. Não fazer `push --force` nem `reset --hard`.

### 2. Determinar a versão atual e a próxima

```bash
gh release list --limit 5
```

A última tag é a versão atual. Tags neste repo **não** têm prefixo `v` (ex.: `2.0.2`, não `v2.0.2`).

### 3. Perguntar ao utilizador o tipo de bump

Se o utilizador ainda não disse, perguntar com as opções `patch` / `minor` / `major`. Mostrar a versão atual e o que cada opção produziria (ex.: "atual `2.0.2` → patch `2.0.3`, minor `2.1.0`, major `3.0.0`").

### 4. Garantir que a documentação está atualizada

Verificar e atualizar **se necessário** estes ficheiros (regra do repo: README/instructions têm de refletir alterações em rotas, estado, algoritmos, regras "do not regress"):

- `README.md` — secção "Funcionalidades", "Configuração por variáveis de ambiente", "API".
- `.github/copilot-instructions.md` — regras "do not regress", lista de rotas, etc.
- `.github/instructions/architecture.instructions.md` — contratos das APIs, estado do frontend, algoritmos.

Usar o diff desde a última tag para identificar o que mudou:

```bash
git diff <tag-atual>..HEAD
```

Se faltar documentar alguma mudança, atualizar **antes** de continuar e mencionar ao utilizador.

### 5. Escrever o changelog seguindo o padrão

A partir do mesmo diff (`git diff <tag-atual>..HEAD`), redigir o changelog.

O changelog é em **português europeu** e usa este formato (ver releases `2.0.0`, `2.0.1`, `2.0.2` como referência):

```markdown
## Changelog — v<anterior> → v<nova>

<parágrafo opcional de contexto, especialmente em releases dedicadas a um tema>

### Novas funcionalidades

- <feature visível ao utilizador, em frase completa>

### Melhorias

- <refactors com impacto, performance, UX, defaults mais seguros>

### Correções

- <bug fix descrito do ponto de vista do utilizador, seguido de "Corrigido."
  ou da explicação técnica curta quando relevante>

### Documentação

- <atualizações ao README, copilot-instructions, novas regras "do not regress">
```

Diretrizes (não rígidas — adaptar ao conteúdo da release):

- Omitir secções vazias. Uma release de só correções pode não ter "Novas funcionalidades".
- Cada bullet começa com a "ementa" do problema/feature, seguida da explicação. Usar `código inline` para nomes de ficheiros, rotas, funções, variáveis.
- Quando houver um tema dominante (ex.: "release dedicada a hardening"), começar com um parágrafo curto a indicá-lo.
- Não inventar mudanças que não estão no diff. Se uma mudança parece pequena mas é crítica (ex.: alteração de algoritmo), mencionar mesmo assim.
- Mencionar regras "do not regress" novas ou removidas em "Documentação".

### 6. Validar o changelog com o utilizador

**Passo obrigatório.** Mostrar o changelog completo (em texto, não num ficheiro) e perguntar:

> "Pronto a publicar como `<nova-tag>`? Diz-me se queres ajustar alguma secção."

Esperar confirmação explícita. Iterar sobre o changelog se o utilizador pedir alterações.

### 7. Publicar a release

Após confirmação:

1. Garantir que tudo está committed e pushed na branch atual (`main` ou `develop`):
   ```bash
   git status --porcelain && git push
   ```
   Se houver alterações não-committed feitas no passo 4, perguntar ao utilizador se deve commitar e com que mensagem (não usar `--force` nem `--no-verify`).

2. **Apenas para `major`: promover `main` para o tip de `develop`.** Se a release está a ser feita a partir de `develop` e a branch `main` está atrás, fazer fast-forward de `main` para `develop` *antes* de criar a tag, para que `main` fique no commit que vai ser tagged.

   ```bash
   # Verificar se main está atrás de develop (ancestor)
   git fetch --quiet origin
   git merge-base --is-ancestor origin/main origin/develop && echo "main is behind"
   ```

   Se `main` está atrás (ancestor), pedir confirmação ao utilizador e então:

   ```bash
   git checkout main
   git pull --ff-only origin main
   git merge --ff-only develop
   git push origin main
   git checkout develop
   ```

   Se o fast-forward falhar (main tem commits que develop não tem), **parar e reportar** — não fazer merge não-fast-forward, rebase ou `--force` sem instrução explícita do utilizador.

   Se a release de `major` está a ser feita diretamente de `main`, saltar este passo.

3. Escrever o changelog para um ficheiro temporário (preserva newlines e formatação):
   ```bash
   cat > /tmp/release-<nova>.md <<'EOF'
   <changelog completo>
   EOF
   ```

4. Criar a release. O título é apenas o número da versão (sem prefixo `v`). Para `major`, usar `--target main`; para os outros, deixar o `gh` usar `HEAD` da branch atual:
   ```bash
   # major (depois de fast-forward de main)
   gh release create <nova> --target main --title "<nova>" --notes-file /tmp/release-<nova>.md
   # patch / minor
   gh release create <nova> --title "<nova>" --notes-file /tmp/release-<nova>.md
   ```
   Isto cria automaticamente a tag `<nova>` no commit alvo.

5. Confirmar com o utilizador, mostrando o URL devolvido pelo `gh`.

## Notas de segurança

- Não fazer `git push --force`, `git reset --hard`, nem reescrever história já publicada.
- Não criar a release antes de o utilizador validar o changelog.
- Se o `gh release create` falhar (tag já existe, sem permissões, etc.), parar e reportar — não tentar contornar.
