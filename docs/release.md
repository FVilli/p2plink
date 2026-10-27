# Release e pubblicazione

## Stato

- Versione corrente: `0.1.0`.
- I nomi npm sono stati verificati disponibili, ma **nessun pacchetto è stato pubblicato**.
- Non creare un repository remoto o pubblicare su npm senza autorizzazione e credenziali.

## Ordine dei pacchetti

```text
1. @p2plink/core
2. @p2plink/crypto
3. @p2plink/mqtt
4. @p2plink/webrtc
5. @p2plink/client
6. @p2plink/server
7. @p2plink/nestjs
8. @p2plink/angular
```

Le dipendenze sono `^0.1.0`. Per una release reale, tutti i pacchetti vanno pubblicati con la stessa versione.

## Build e verifica

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm pack:check
```

`pnpm pack:check` crea i tarball di verifica. La build Angular produce `packages/angular/dist`, con un `package.json` corretto dallo script `scripts/fix-angular-package.mjs`:

- `main`/`module`/`types` relativi alla dist;
- `files` limitato a `fesm2022`, `types`, README e LICENSE;
- dipendenze workspace sostituite con `^0.1.0`.

## Pubblicazione manuale

```bash
export NODE_AUTH_TOKEN=...
for pkg in core crypto mqtt webrtc client server nestjs; do
  (cd packages/$pkg && npm publish --access public --provenance)
done
(cd packages/angular/dist && npm publish --access public --provenance)
```

Requisiti:

- essere owner dello scope `@p2plink`;
- `npm whoami` con l'account corretto;
- 2FA/provenance configurati;
- aver verificato i tarball e la documentazione;
- aver eseguito i test su una macchina pulita.

Il workflow `.github/workflows/release.yml` è manuale e pubblica solo se l'input `publish` è true e il secret `NPM_TOKEN` è configurato.

## Versionamento

- `0.x`: l'API pubblica può cambiare; ogni breaking change va in `CHANGELOG.md`.
- Dopo `1.0.0`: semver.
- Le modifiche al protocollo wire richiedono una nuova versione del protocollo e un namespace topic, non solo un bump del package.
- Changesets è consigliato quando il repository avrà release frequenti; per ora il changelog è manuale.

## Checklist pre-release

- [ ] `pnpm build`, `typecheck`, `lint`, `format:check`, `test` verdi.
- [ ] Browser E2E e Angular/Nest E2E verdi sull'ambiente di riferimento.
- [ ] `pnpm pack:check` senza file mancanti.
- [ ] README, docs e CHANGELOG aggiornati.
- [ ] Licenze e dipendenze native verificate.
- [ ] Handshake e threat model rivisti (idealmente audit esterno).
- [ ] Credenziali demo non usate in produzione.
- [ ] Tag Git e release notes.
