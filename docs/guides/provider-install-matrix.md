# Clean integrated install: Voyage 1024d + safe cleanup + verification

This is the recommended customer path for eva-brain right now:

1. **archive any old `~/.gbrain` state instead of patching it in place**
2. **do a fresh init with Voyage 1024d**
3. **verify provider health and brain health immediately**
4. **treat OpenClaw Codex OAuth extraction as a host-side dependency**
5. **only then import/sync content**

This guide intentionally prefers a clean integrated path over legacy in-place migration complexity.

## Scope and boundary

This branch already documents and ships:
- provider selection via `gbrain init --embedding-model ...`
- provider probing via `gbrain providers list|explain|test`
- safe brain verification via `gbrain doctor --json` and `gbrain stats`

This branch does **not** yet claim a fully merged end-to-end OpenClaw-managed Codex OAuth `provider_auth` flow inside eva-brain itself.
That work is tracked in `100yenadmin/eva-brain#2`.

So the honest integrated install story is:
- **eva-brain side:** fresh Voyage brain + verification
- **OpenClaw side:** complete the Codex/OpenAI OAuth adapter/auth setup on the host, then verify extraction there
- **cut over only after both halves are green**

## Recommended production target

- embedding provider: **Voyage**
- model: **`voyage:voyage-3.5`**
- embedding dimension: **1024**
- install style: **fresh init**
- old state handling: **archive, never destructive delete first**

Why this path:
- avoids stale/broken 1536d installs
- makes the dimension contract explicit up front
- gives a clean rollback path
- keeps customer installs reproducible

## One-screen command flow

```bash
# 1) archive old state if present
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/.gbrain-archive
[ -e ~/.gbrain ] && mv ~/.gbrain ~/.gbrain-archive/gbrain-$TS

# 2) configure Voyage
export VOYAGE_API_KEY=...

# 3) verify provider before init
gbrain providers list
gbrain providers explain
gbrain providers test --model voyage:voyage-3.5

# 4) fresh init at 1024d
gbrain init --pglite --embedding-model voyage:voyage-3.5

# 5) verify the fresh brain
gbrain doctor --json
gbrain stats

# 6) import content only after health is green
gbrain import /path/to/brain-repo --no-embed
gbrain embed --stale
gbrain extract links --source db
gbrain extract timeline --source db
gbrain stats
```

## Safe cleanup of old installs

Do not mutate an unknown old install in place.
Archive it first.

### Local PGLite install

```bash
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/.gbrain-archive
if [ -e ~/.gbrain ]; then
  mv ~/.gbrain ~/.gbrain-archive/gbrain-$TS
fi
```

What this does:
- preserves the old config
- preserves the old local database
- keeps rollback to one `mv` command

### Why archive instead of patching

Old customer installs may have any of these problems:
- stale 1536d embeddings from an older OpenAI-first setup
- mismatched provider env vars
- half-finished migrations
- old config assumptions that hide the real problem

A fresh init is faster and safer than trying to repair every old state shape.

## Fresh init with Voyage 1024d

### PGLite

```bash
export VOYAGE_API_KEY=...
gbrain providers test --model voyage:voyage-3.5
gbrain init --pglite --embedding-model voyage:voyage-3.5
gbrain doctor --json
gbrain stats
```

### Supabase / Postgres

Use a fresh target database or fresh customer database URL.
Do not point a new 1024d install at an old 1536d database.

```bash
export VOYAGE_API_KEY=...
export GBRAIN_DATABASE_URL='postgresql://...'

gbrain providers test --model voyage:voyage-3.5
gbrain init --supabase --non-interactive \
  --embedding-model voyage:voyage-3.5 \
  --url "$GBRAIN_DATABASE_URL"

gbrain doctor --json
gbrain stats
```

## Dimension contract

The embedding dimension is schema-level state.

For the providers currently documented here:
- OpenAI `text-embedding-3-large` → **1536**
- Voyage `voyage-3.5` → **1024**
- Google `text-embedding-004` → **768**
- Ollama `nomic-embed-text` recipe default → **768**
- LiteLLM → **must be declared explicitly by the operator**

### Operational rule

If the install target is Voyage 1024d, initialize the brain that way from the start.
Do not reuse a 1536d brain and expect the dimension mismatch to self-heal.

### Mismatch behavior

If gbrain receives embeddings whose length does not match the configured dimension, it fails closed with an embedding-dimension error.
That is expected and correct.

## OpenClaw Codex OAuth adapter for extraction

This part is a **host-side dependency**.

What we can safely document here today:
- eva-brain's fresh Voyage install path is independent of Codex OAuth
- the durable OpenClaw Codex/OpenAI auth propagation work is tracked in `100yenadmin/eva-brain#2`
- production extraction that relies on OpenClaw-managed Codex/OpenAI OAuth should be considered dependent on that auth branch/PR

### Recommended integrated rollout

1. complete the fresh Voyage 1024d brain install first
2. verify it with `gbrain doctor --json` and `gbrain stats`
3. separately complete the OpenClaw Codex OAuth adapter/auth flow on the host
4. verify extraction on the host side
5. only then start customer imports / syncs

### Verification expectation for the OAuth half

Because the auth adapter is host-side, the verification should also be host-side:
- the OpenClaw Codex/OpenAI auth flow should complete without prompting for a missing API key
- the extraction command/path should stop failing on missing auth
- no secret values should be printed during verification

Until `100yenadmin/eva-brain#2` lands, the safe fallback is:
- use Voyage for embeddings as documented here
- use API-key-backed extraction paths where applicable
- do not claim fully supported OpenClaw-managed OAuth extraction yet

## Post-init verification

Run these immediately after fresh init:

```bash
gbrain providers list
gbrain providers explain
gbrain providers test --model voyage:voyage-3.5
gbrain doctor --json
gbrain stats
```

Expected outcomes:
- provider test succeeds and prints a 1024-dim result
- doctor reports healthy schema
- stats returns a working brain with no initialization failure

After import, also run:

```bash
gbrain embed --stale
gbrain stats
gbrain search "test query from your imported content"
```

Expected outcomes after import:
- embedded chunk count rises toward total chunk count
- search returns current content from the imported repo
- `extract links` / `extract timeline` complete cleanly

## Rollback

### Local rollback

If the fresh Voyage install is bad, restore the archived state:

```bash
rm -rf ~/.gbrain
mv ~/.gbrain-archive/gbrain-<timestamp> ~/.gbrain
gbrain doctor --json
gbrain stats
```

### Postgres rollback

Rollback by switching the customer back to the old database URL.
Do not drop the old database until the new install passes verification.

```bash
export GBRAIN_DATABASE_URL='postgresql://...old database...'
gbrain doctor --json
gbrain stats
```

## Failure modes

### `Embedding dim mismatch`

Cause:
- a 1024d provider pointed at a 1536d brain, or vice versa

Response:
- stop retrying
- archive the bad state if needed
- re-init cleanly with the intended provider/dimension

### `gbrain providers test` fails

Cause:
- missing `VOYAGE_API_KEY`
- bad network path
- wrong provider/model string

Response:

```bash
gbrain providers env voyage
gbrain providers test --model voyage:voyage-3.5
```

Fix the env/setup first, then rerun init.

### Brain initializes but import/search is wrong

Response:
- rerun `gbrain doctor --json`
- rerun `gbrain stats`
- rerun `gbrain embed --stale`
- verify you imported the intended repo path

## Minimal customer-safe recommendation

If you're installing eva-brain for a customer today, the safest story is:

1. archive old `~/.gbrain`
2. fresh init with Voyage 1024d
3. verify provider + brain health immediately
4. treat OpenClaw Codex OAuth extraction as a separately verified dependency
5. only import customer data after both sides are green
