# Engine migration fixtures

`typescript-traces.json` contains frozen state fingerprints for 1,956 transitions
across 20 games, produced by the original TypeScript rules before their retirement.
`TestTypeScriptParity` replays the recorded moves with the Go engine and checks
those independent fingerprints. Running this test requires only Go.

The original generator (`scripts/engine-fixtures.ts`) and rule implementation
are available in Git revision `f74deb9`. To regenerate the historical oracle,
check out that revision in a separate worktree and run `bun run fixtures` there.
Do not regenerate the oracle with the implementation under test.
