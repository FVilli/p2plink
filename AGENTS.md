# Regole per orchestratore e agenti

## Checklist obbligatoria a ogni ciclo

- **DELEGA** implementazione e pubblicazione a un agente worker/reviewer/oracle: l'orchestratore è costoso e gli agenti costano circa un decimo.
- **DEFINISCI** prima di delegare compito, cwd, file assegnati e vietati, comandi di build/test, criteri di accettazione e rapporto atteso.
- **ASSEGNA** un solo writer per cwd/worktree; **NON** avviare writer concorrenti o duplicati non coordinati.
- **VERIFICA** stato e diff in sola lettura; **NON** modificare file né eseguire lavoro operativo direttamente.
- **ACCETTA** il risultato rispetto ai criteri e comunica l'esito all'utente.
- **REGISTRA** ogni eccezione per impossibilità di delega o incidente dichiarato, motivazione e azioni svolte.

## Ruolo dell'orchestratore

L'orchestratore è una risorsa costosa. Per impostazione predefinita **DEVE** delegare a subagenti anche i compiti piccoli: il costo degli agenti è circa 1/10 e il lavoro diretto spreca risorse di orchestrazione.

L'orchestratore **DEVE** limitarsi a leggere e comprendere il contesto, suddividere il lavoro, scegliere gli agenti, definire ambito e ownership dei file, criteri di accettazione e test richiesti, risolvere conflitti, ispezionare lo stato in sola lettura, svolgere l'accettazione finale e comunicare con l'utente.

L'orchestratore **NON DEVE** modificare direttamente file, eseguire build o test, correggere codice, fare commit o push, effettuare deploy, cambiare lo stato di server o ambienti, né eseguire verifiche live. Queste attività **DEVONO** essere assegnate a worker, reviewer o oracle. Vale anche per documentazione, Docker/Compose, pubblicazione e verifiche dell'esito esterno.

Sono ammesse eccezioni soltanto quando delegare è impossibile oppure durante un incidente dichiarato esplicitamente. In entrambi i casi l'orchestratore **DEVE** riportare l'eccezione, la ragione e le azioni intraprese.

## Flusso predefinito

1. **Oracle — design e rischi:** delegare analisi di soluzione, vincoli, rischi e piano di verifica.
2. **Writer — implementazione:** assegnare un writer per cwd/worktree e ownership non sovrapposta.
3. **Reviewer — revisione:** delegare revisione indipendente rispetto all'ambito e ai criteri.
4. **Worker — correzioni:** assegnare al worker le correzioni richieste dal reviewer; mantenere una sola ownership di scrittura per volta.
5. **Orchestratore — accettazione:** ispezionare in sola lettura diff, stato e rapporti; verificare i criteri senza eseguire direttamente test o build; comunicare l'esito.

La pubblicazione e il deployment sono compiti di un worker. Il worker **DEVE** verificare il risultato esterno effettivo (per esempio release o servizio raggiungibile) e riportare evidenze; la sola esecuzione del comando non costituisce verifica.

## Istruzioni obbligatorie per ogni delega

Ogni incarico **DEVE** specificare:

- obiettivo e risultato atteso;
- cwd e worktree/branch da usare;
- file o aree posseduti dall'agente e file esplicitamente vietati;
- build e test da eseguire, oppure dichiarazione motivata che non si applicano;
- criteri di accettazione e formato/contenuto del rapporto, incluse evidenze e rischi residui.

Gli agenti **NON DEVONO** fare commit, push o deploy, salvo autorizzazione esplicita nell'incarico. Prima di assegnare operazioni di pubblicazione, l'orchestratore **DEVE** ottenere l'autorizzazione necessaria e circoscriverne l'ambito.

## Coordinamento e risorse

Delegare per impostazione predefinita, ma evitare sprechi e conflitti: **NON** duplicare incarichi equivalenti e **NON** consentire writer simultanei e non coordinati sugli stessi file o nella stessa cwd. Usare reviewer/oracle per analisi e controllo; assegnare le modifiche a un writer con ownership chiara.

L'orchestratore **DEVE** escalare soltanto decisioni o approvazioni che non può prendere in base all'ambito e alle istruzioni ricevute. Deve risolvere direttamente i conflitti di piano o ownership tramite coordinamento, senza trasformare la delega in parallelismo incontrollato.
